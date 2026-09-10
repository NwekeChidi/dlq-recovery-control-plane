import { ExecutionStatus } from "@aws-sdk/client-lambda";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import {
  shp001Transient,
  shp002LegacyV1,
  shp003Poison,
  shp004AlreadyDispatched,
} from "../../src/fixtures/shipments";
import { createRecoveryHandler } from "../../src/recovery/handler";
import type { DlqMessage } from "../../src/recovery/load";
import { PATCH_VERSION } from "../../src/recovery/patch";
import type { ReplayEnvelope } from "../../src/recovery/replay";
import { FailureClass, RecoveryAction } from "../../src/shared/failure";
import { RecoveryJobStatus, ReplayResult } from "../../src/shared/recovery";
import { InMemoryRecoveryStore } from "../../src/shared/recovery-repo";
import { InMemoryShipmentLedger } from "../../src/shared/shipments-repo";

jest.setTimeout(60_000);

function createFakeDlq(messages: DlqMessage[]) {
  const dlq = [...messages];
  let loadCount = 0;
  return {
    loadCount: () => loadCount,
    remaining: () => dlq,
    loadBatch: async (batchSize: number) => {
      loadCount += 1;
      return dlq.slice(0, batchSize);
    },
    deleteMessage: async (receiptHandle: string) => {
      const index = dlq.findIndex((message) => message.receiptHandle === receiptHandle);
      if (index >= 0) {
        dlq.splice(index, 1);
      }
    },
  };
}

describe("recovery durable handler", () => {
  beforeAll(async () => {
    await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
  });

  afterAll(async () => {
    await LocalDurableTestRunner.teardownTestEnvironment();
  });

  test("replays only safe candidates once, then deletes the DLQ batch", async () => {
    const store = new InMemoryRecoveryStore();
    const ledger = new InMemoryShipmentLedger();
    await ledger.claimShipment("SHP-004");
    await ledger.completeShipment("SHP-004", "dispatched");

    const dlq = createFakeDlq([
      { messageId: "m-001", receiptHandle: "r-001", body: JSON.stringify(shp001Transient) },
      { messageId: "m-002", receiptHandle: "r-002", body: JSON.stringify(shp002LegacyV1) },
      { messageId: "m-003", receiptHandle: "r-003", body: JSON.stringify(shp003Poison) },
      { messageId: "m-004", receiptHandle: "r-004", body: JSON.stringify(shp004AlreadyDispatched) },
    ]);
    const sent: ReplayEnvelope[] = [];

    const handler = createRecoveryHandler({
      ledger,
      store,
      now: () => "2026-09-10T05:00:00.000Z",
      loadBatch: dlq.loadBatch,
      replay: async (envelope) => {
        sent.push(envelope);
        await store.markReplayResult(
          envelope.attributes.recoveryId,
          envelope.attributes.originalMessageId,
          ReplayResult.Success,
        );
      },
      deleteMessage: dlq.deleteMessage,
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: { batchSize: 4, recoveryId: "REC-test" } });

    expect(execution.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(execution.getResult()).toEqual({
      recoveryId: "REC-test",
      processedCount: 4,
      quarantinedCount: 1,
      suppressedCount: 1,
      replayCandidateCount: 1,
      patchCandidateCount: 1,
      recoveredCount: 2,
      failureCount: 0,
      failureRate: 0,
      status: RecoveryJobStatus.Completed,
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({
      body: shp001Transient,
      attributes: {
        recoveryId: "REC-test",
        originalMessageId: "m-001",
        replayAttempt: 1,
      },
    });
    expect(sent[1]?.body).toMatchObject({ shipmentId: "SHP-002", schemaVersion: 2 });
    expect(sent[1]?.attributes).toEqual({
      recoveryId: "REC-test",
      originalMessageId: "m-002",
      replayAttempt: 1,
      patchVersion: PATCH_VERSION,
    });
    expect(sent.some((envelope) => JSON.stringify(envelope.body).includes("TELEPORT"))).toBe(
      false,
    );
    expect(sent.some((envelope) => envelope.attributes.originalMessageId === "m-004")).toBe(false);
    expect(dlq.remaining()).toEqual([]);

    const job = await store.getRecoveryJob("REC-test");
    expect(job).toMatchObject({
      status: RecoveryJobStatus.Completed,
      processedCount: 4,
      quarantinedCount: 1,
      suppressedCount: 1,
      recoveredCount: 2,
      failureCount: 0,
    });

    await expect(store.getRecoveryMessage("REC-test", "m-001")).resolves.toMatchObject({
      action: RecoveryAction.Replay,
      failureClass: FailureClass.Transient,
      replayResult: ReplayResult.Success,
      replayAttempt: 1,
    });
    await expect(store.getRecoveryMessage("REC-test", "m-002")).resolves.toMatchObject({
      action: RecoveryAction.Patch,
      failureClass: FailureClass.SchemaMismatch,
      replayResult: ReplayResult.Success,
    });
    await expect(store.getQuarantine("m-003")).resolves.toMatchObject({
      shipmentId: "SHP-003",
      originalPayload: shp003Poison,
      action: RecoveryAction.Quarantine,
    });
    await expect(store.getRecoveryMessage("REC-test", "m-003")).resolves.toMatchObject({
      replayResult: ReplayResult.NotSent,
    });
    await expect(store.getRecoveryMessage("REC-test", "m-004")).resolves.toMatchObject({
      action: RecoveryAction.Skip,
      failureClass: FailureClass.Duplicate,
      replayResult: ReplayResult.NotSent,
    });
  });

  test("0% replay failure continues into the next DLQ batch", async () => {
    const store = new InMemoryRecoveryStore();
    const dlq = createFakeDlq([
      { messageId: "m-001", receiptHandle: "r-001", body: JSON.stringify(shp001Transient) },
      { messageId: "m-002", receiptHandle: "r-002", body: JSON.stringify(shp002LegacyV1) },
      { messageId: "m-003", receiptHandle: "r-003", body: JSON.stringify(shp003Poison) },
    ]);
    const sent: ReplayEnvelope[] = [];

    const handler = createRecoveryHandler({
      ledger: new InMemoryShipmentLedger(),
      store,
      createRecoveryId: () => "REC-batch",
      loadBatch: dlq.loadBatch,
      replay: async (envelope) => {
        sent.push(envelope);
        await store.markReplayResult(
          envelope.attributes.recoveryId,
          envelope.attributes.originalMessageId,
          ReplayResult.Success,
        );
      },
      deleteMessage: dlq.deleteMessage,
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: {} });

    expect(execution.getResult()).toMatchObject({
      recoveryId: "REC-batch",
      processedCount: 3,
      replayCandidateCount: 1,
      patchCandidateCount: 1,
      recoveredCount: 2,
      quarantinedCount: 1,
      failureCount: 0,
      failureRate: 0,
      status: RecoveryJobStatus.Completed,
    });
    expect(sent).toHaveLength(2);
    expect(dlq.remaining()).toEqual([]);
    await expect(store.getQuarantine("m-003")).resolves.toMatchObject({
      shipmentId: "SHP-003",
    });
    expect(dlq.loadCount()).toBe(3);
  });

  test("failure rate at the threshold continues", async () => {
    const store = new InMemoryRecoveryStore();
    const dlq = createFakeDlq(
      ["m-001", "m-002", "m-003", "m-004"].map((messageId) => ({
        messageId,
        receiptHandle: `r-${messageId}`,
        body: JSON.stringify(shp001Transient),
      })),
    );

    const handler = createRecoveryHandler({
      ledger: new InMemoryShipmentLedger(),
      store,
      loadBatch: dlq.loadBatch,
      replay: async (envelope) => {
        const result =
          envelope.attributes.originalMessageId === "m-004"
            ? ReplayResult.Failed
            : ReplayResult.Success;
        await store.markReplayResult(
          envelope.attributes.recoveryId,
          envelope.attributes.originalMessageId,
          result,
        );
      },
      deleteMessage: dlq.deleteMessage,
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: { batchSize: 4, recoveryId: "REC-threshold" } });

    expect(execution.getResult()).toMatchObject({
      recoveryId: "REC-threshold",
      processedCount: 4,
      recoveredCount: 3,
      failureCount: 1,
      failureRate: 0.25,
      status: RecoveryJobStatus.Completed,
    });
    expect(dlq.loadCount()).toBe(2);
  });

  test("failure rate above the limit stops and loads no further batches", async () => {
    const store = new InMemoryRecoveryStore();
    const dlq = createFakeDlq([
      { messageId: "m-001", receiptHandle: "r-001", body: JSON.stringify(shp001Transient) },
      { messageId: "m-002", receiptHandle: "r-002", body: JSON.stringify(shp001Transient) },
      { messageId: "m-003", receiptHandle: "r-003", body: JSON.stringify(shp003Poison) },
    ]);

    const handler = createRecoveryHandler({
      ledger: new InMemoryShipmentLedger(),
      store,
      loadBatch: dlq.loadBatch,
      replay: async (envelope) => {
        await store.markReplayResult(
          envelope.attributes.recoveryId,
          envelope.attributes.originalMessageId,
          ReplayResult.Failed,
        );
      },
      deleteMessage: dlq.deleteMessage,
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: { recoveryId: "REC-stop" } });

    expect(execution.getResult()).toMatchObject({
      recoveryId: "REC-stop",
      processedCount: 2,
      recoveredCount: 0,
      failureCount: 2,
      failureRate: 1,
      status: RecoveryJobStatus.Stopped,
      stopReason: "Replay failure rate 1 exceeded maxFailureRate 0.25",
    });
    expect(dlq.loadCount()).toBe(1);
    expect(dlq.remaining()).toEqual([
      { messageId: "m-003", receiptHandle: "r-003", body: JSON.stringify(shp003Poison) },
    ]);

    const job = await store.getRecoveryJob("REC-stop");
    expect(job).toMatchObject({
      status: RecoveryJobStatus.Stopped,
      processedCount: 2,
      recoveredCount: 0,
      failureCount: 2,
      stopReason: "Replay failure rate 1 exceeded maxFailureRate 0.25",
    });
  });
});
