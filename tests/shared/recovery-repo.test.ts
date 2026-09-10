import { FailureClass, RecoveryAction } from "../../src/shared/failure";
import {
  DownstreamStatus,
  RecoveryJobStatus,
  ReplayResult,
  createStartedRecoveryJob,
} from "../../src/shared/recovery";
import { InMemoryRecoveryStore } from "../../src/shared/recovery-repo";

describe("InMemoryRecoveryStore", () => {
  test("writes and reads a recovery message audit record", async () => {
    const store = new InMemoryRecoveryStore();
    await store.putRecoveryMessage({
      recoveryId: "rec-1",
      messageId: "msg-003",
      shipmentId: "SHP-003",
      failureClass: FailureClass.Poison,
      action: RecoveryAction.Quarantine,
      originalPayload: { shipmentId: "SHP-003", customerId: null },
      reason: "do not invent a correction",
      createdAt: "2026-09-06T09:00:00.000Z",
    });

    await expect(store.getRecoveryMessage("rec-1", "msg-003")).resolves.toEqual({
      recoveryId: "rec-1",
      messageId: "msg-003",
      shipmentId: "SHP-003",
      failureClass: FailureClass.Poison,
      action: RecoveryAction.Quarantine,
      originalPayload: { shipmentId: "SHP-003", customerId: null },
      reason: "do not invent a correction",
      createdAt: "2026-09-06T09:00:00.000Z",
    });
  });

  test("writes and reads a recovery job record", async () => {
    const store = new InMemoryRecoveryStore();
    const job = createStartedRecoveryJob({
      recoveryId: "rec-1",
      startedAt: "2026-09-06T09:00:00.000Z",
    });
    await store.putRecoveryJob(job);
    await expect(store.getRecoveryJob("rec-1")).resolves.toEqual(job);
    expect(job).toMatchObject({
      status: RecoveryJobStatus.Started,
      batchSize: 2,
      replayDelaySeconds: 5,
      maxFailureRate: 0.25,
      quarantinedCount: 0,
    });
  });

  test("clear removes quarantine and recovery records", async () => {
    const store = new InMemoryRecoveryStore();
    await store.putQuarantine({
      messageId: "msg-003",
      shipmentId: "SHP-003",
      originalPayload: { shipmentId: "SHP-003" },
      failureClass: FailureClass.Poison,
      action: RecoveryAction.Quarantine,
      reason: "unsafe",
      sourceQueue: "ShipmentsDLQ",
      recoveryId: "rec-1",
      quarantinedAt: "2026-09-06T09:00:00.000Z",
    });
    await store.putRecoveryJob(createStartedRecoveryJob({ recoveryId: "rec-1" }));
    await store.putRecoveryMessage({
      recoveryId: "rec-1",
      messageId: "msg-003",
      failureClass: FailureClass.Poison,
      action: RecoveryAction.Quarantine,
      originalPayload: { shipmentId: "SHP-003" },
      createdAt: "2026-09-06T09:00:00.000Z",
    });

    await store.clear();

    await expect(store.listQuarantines()).resolves.toEqual([]);
    await expect(store.listRecoveryJobs()).resolves.toEqual([]);
    await expect(store.listRecoveryMessages()).resolves.toEqual([]);
    await expect(store.getDownstreamStatus()).resolves.toBe(DownstreamStatus.Healthy);
  });

  test("records explicit replay SUCCESS and FAILED results", async () => {
    const store = new InMemoryRecoveryStore();
    await store.putRecoveryMessage({
      recoveryId: "rec-1",
      messageId: "msg-001",
      failureClass: FailureClass.Transient,
      action: RecoveryAction.Replay,
      originalPayload: { shipmentId: "SHP-001" },
      replayResult: ReplayResult.Sent,
      createdAt: "2026-09-06T09:00:00.000Z",
    });

    await store.markReplayResult("rec-1", "msg-001", ReplayResult.Success);
    await expect(store.getRecoveryMessage("rec-1", "msg-001")).resolves.toMatchObject({
      replayResult: ReplayResult.Success,
    });

    await store.setDownstreamStatus(DownstreamStatus.Broken);
    await expect(store.getDownstreamStatus()).resolves.toBe(DownstreamStatus.Broken);
    await store.clear();
    await expect(store.getDownstreamStatus()).resolves.toBe(DownstreamStatus.Healthy);
  });
});
