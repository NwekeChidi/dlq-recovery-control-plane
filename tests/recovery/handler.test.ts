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
import { FailureClass, RecoveryAction } from "../../src/shared/failure";
import { RecoveryJobStatus } from "../../src/shared/recovery";
import { InMemoryRecoveryStore } from "../../src/shared/recovery-repo";
import { InMemoryShipmentLedger } from "../../src/shared/shipments-repo";

jest.setTimeout(60_000);

describe("recovery durable handler", () => {
  beforeAll(async () => {
    await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
  });

  afterAll(async () => {
    await LocalDurableTestRunner.teardownTestEnvironment();
  });

  test("loads a batch, records decisions, and does not replay", async () => {
    const store = new InMemoryRecoveryStore();
    const ledger = new InMemoryShipmentLedger();
    await ledger.claimShipment("SHP-004");
    await ledger.completeShipment("SHP-004", "dispatched");

    const queued: DlqMessage[] = [
      { messageId: "m-001", receiptHandle: "r-001", body: JSON.stringify(shp001Transient) },
      { messageId: "m-002", receiptHandle: "r-002", body: JSON.stringify(shp002LegacyV1) },
      { messageId: "m-003", receiptHandle: "r-003", body: JSON.stringify(shp003Poison) },
      { messageId: "m-004", receiptHandle: "r-004", body: JSON.stringify(shp004AlreadyDispatched) },
    ];

    const handler = createRecoveryHandler({
      ledger,
      store,
      now: () => "2026-09-10T05:00:00.000Z",
      createRecoveryId: () => "REC-test",
      loadBatch: async (batchSize) => queued.slice(0, batchSize),
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: { batchSize: 4 } });

    expect(execution.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(execution.getResult()).toEqual({
      recoveryId: "REC-test",
      processedCount: 4,
      quarantinedCount: 1,
      suppressedCount: 1,
      replayCandidateCount: 1,
      patchCandidateCount: 1,
    });

    const job = await store.getRecoveryJob("REC-test");
    expect(job).toMatchObject({
      status: RecoveryJobStatus.Completed,
      processedCount: 4,
      quarantinedCount: 1,
      suppressedCount: 1,
      recoveredCount: 0,
    });

    await expect(store.getRecoveryMessage("REC-test", "m-001")).resolves.toMatchObject({
      action: RecoveryAction.Replay,
      failureClass: FailureClass.Transient,
    });
    await expect(store.getRecoveryMessage("REC-test", "m-002")).resolves.toMatchObject({
      action: RecoveryAction.Patch,
      failureClass: FailureClass.SchemaMismatch,
    });
    await expect(store.getQuarantine("m-003")).resolves.toMatchObject({
      shipmentId: "SHP-003",
      originalPayload: shp003Poison,
      action: RecoveryAction.Quarantine,
    });
    await expect(store.getRecoveryMessage("REC-test", "m-004")).resolves.toMatchObject({
      action: RecoveryAction.Skip,
      failureClass: FailureClass.Duplicate,
    });
  });

  test("default knobs only inspect one DLQ batch of two", async () => {
    const store = new InMemoryRecoveryStore();
    const queued: DlqMessage[] = [
      { messageId: "m-001", receiptHandle: "r-001", body: JSON.stringify(shp001Transient) },
      { messageId: "m-002", receiptHandle: "r-002", body: JSON.stringify(shp002LegacyV1) },
      { messageId: "m-003", receiptHandle: "r-003", body: JSON.stringify(shp003Poison) },
    ];

    const handler = createRecoveryHandler({
      ledger: new InMemoryShipmentLedger(),
      store,
      createRecoveryId: () => "REC-batch",
      loadBatch: async (batchSize) => queued.slice(0, batchSize),
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: {} });

    expect(execution.getResult()).toMatchObject({
      recoveryId: "REC-batch",
      processedCount: 2,
      replayCandidateCount: 1,
      patchCandidateCount: 1,
      quarantinedCount: 0,
    });
    await expect(store.getQuarantine("m-003")).resolves.toBeUndefined();
  });
});
