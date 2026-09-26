import { FailureClass, RecoveryAction } from "../../src/shared/failure";
import {
  DownstreamStatus,
  RecoveryJobStatus,
  ReplayResult,
  createStartedRecoveryJob,
} from "../../src/shared/recovery";
import {
  DynamoRecoveryStore,
  InMemoryRecoveryStore,
  ledgerTtlConfigFromEnv,
  DEFAULT_LEDGER_TTL_DAYS,
} from "../../src/shared/recovery-repo";

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

describe("DynamoRecoveryStore TTL", () => {
  const FIXED_MS = 1_700_000_000_000; // deterministic clock
  const FIXED_SECONDS = Math.floor(FIXED_MS / 1000);

  function capturingStore(ttl: {
    recordTtlDays?: number;
    quarantineTtlDays?: number;
  }) {
    const puts: Record<string, unknown>[] = [];
    const doc = {
      send: async (command: { input?: { Item?: Record<string, unknown> } }) => {
        if (command?.input?.Item) {
          puts.push(command.input.Item);
        }
        return {};
      },
    };
    // The store only uses doc.send; cast through unknown for the fake.
    const store = new DynamoRecoveryStore(doc as unknown as never, "LedgerTable", {
      ttl,
      now: () => FIXED_MS,
    });
    return { store, puts };
  }

  test("stamps expiresAt on job and message records from recordTtlDays", async () => {
    const { store, puts } = capturingStore({ recordTtlDays: 30 });
    await store.putRecoveryJob(createStartedRecoveryJob({ recoveryId: "rec-1" }));
    await store.putRecoveryMessage({
      recoveryId: "rec-1",
      messageId: "msg-001",
      failureClass: FailureClass.Transient,
      action: RecoveryAction.Replay,
      originalPayload: { shipmentId: "SHP-001" },
      createdAt: "2026-09-06T09:00:00.000Z",
    });

    const expected = FIXED_SECONDS + 30 * 86_400;
    expect(puts).toHaveLength(2);
    for (const item of puts) {
      expect(item.expiresAt).toBe(expected);
    }
  });

  test("quarantine records never expire by default (no expiresAt written)", async () => {
    const { store, puts } = capturingStore({ recordTtlDays: 30 });
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

    expect(puts).toHaveLength(1);
    expect(puts[0]).not.toHaveProperty("expiresAt");
  });

  test("quarantine records expire when quarantineTtlDays is set", async () => {
    const { store, puts } = capturingStore({ recordTtlDays: 30, quarantineTtlDays: 365 });
    await store.putQuarantine({
      messageId: "msg-003",
      originalPayload: { shipmentId: "SHP-003" },
      failureClass: FailureClass.Poison,
      action: RecoveryAction.Quarantine,
      reason: "unsafe",
      sourceQueue: "ShipmentsDLQ",
      recoveryId: "rec-1",
      quarantinedAt: "2026-09-06T09:00:00.000Z",
    });

    expect(puts[0]?.expiresAt).toBe(FIXED_SECONDS + 365 * 86_400);
  });
});

describe("ledgerTtlConfigFromEnv", () => {
  test("defaults records to 30 days and quarantine to never", () => {
    expect(ledgerTtlConfigFromEnv({})).toEqual({
      recordTtlDays: DEFAULT_LEDGER_TTL_DAYS,
      quarantineTtlDays: undefined,
    });
  });

  test("reads overrides from env", () => {
    expect(
      ledgerTtlConfigFromEnv({
        RECOVERY_LEDGER_TTL_DAYS: "7",
        RECOVERY_QUARANTINE_TTL_DAYS: "365",
      } as NodeJS.ProcessEnv),
    ).toEqual({ recordTtlDays: 7, quarantineTtlDays: 365 });
  });
});
