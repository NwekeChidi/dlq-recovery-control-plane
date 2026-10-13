import {
  shp001Transient,
  shp003Poison,
  shp004AlreadyDispatched,
} from "../../src/fixtures/shipments";
import {
  SOURCE_QUEUE_SHIPMENTS_DLQ,
  buildQuarantineRecord,
  isReplayAuthorized,
  isTerminalHold,
  quarantine,
} from "../../src/recovery/quarantine";
import { classify } from "../../src/recovery/triage";
import { FailureClass, RecoveryAction } from "../../src/shared/failure";
import { InMemoryRecoveryStore } from "../../src/shared/recovery-repo";

describe("quarantine policy", () => {
  test("poison and unknown failures are never replay candidates", () => {
    expect(isReplayAuthorized(classify(shp003Poison).action)).toBe(false);
    expect(isReplayAuthorized(classify({ hello: "world" }).action)).toBe(false);
    expect(isReplayAuthorized(classify(shp004AlreadyDispatched).action)).toBe(false);
    expect(isReplayAuthorized(RecoveryAction.Skip)).toBe(false);
    expect(isTerminalHold(classify(shp003Poison).action)).toBe(true);
    expect(isTerminalHold(classify({ hello: "world" }).action)).toBe(true);
    expect(isTerminalHold(RecoveryAction.Skip)).toBe(false);
  });

  test("transient and schema-mismatch remain replayable after triage", () => {
    expect(isReplayAuthorized(classify(shp001Transient).action)).toBe(true);
    expect(isReplayAuthorized(RecoveryAction.Patch)).toBe(true);
  });
});

describe("quarantine", () => {
  const now = "2026-09-06T09:00:00.000Z";

  test("stores the poison payload intact with the quarantine reason", async () => {
    const store = new InMemoryRecoveryStore();
    const triage = classify(shp003Poison);
    const record = await quarantine(store, {
      messageId: "msg-003",
      payload: shp003Poison,
      triage,
      recoveryId: "rec-1",
      quarantinedAt: now,
    });

    expect(record).toMatchObject({
      messageId: "msg-003",
      shipmentId: "SHP-003",
      originalPayload: shp003Poison,
      failureClass: FailureClass.Poison,
      action: RecoveryAction.Quarantine,
      sourceQueue: SOURCE_QUEUE_SHIPMENTS_DLQ,
      recoveryId: "rec-1",
      quarantinedAt: now,
    });
    expect(record.reason).toMatch(/do not invent a correction/i);
    expect(record.originalPayload).toEqual({
      shipmentId: "SHP-003",
      customerId: null,
      warehouseId: "UNKNOWN",
      service: "TELEPORT",
      destinationCountry: "??",
    });

    const stored = await store.getQuarantine("msg-003");
    expect(stored?.originalPayload).toEqual(shp003Poison);
    expect(stored?.reason).toBe(record.reason);

    const audit = await store.getRecoveryMessage("rec-1", "msg-003");
    expect(audit).toMatchObject({
      recoveryId: "rec-1",
      messageId: "msg-003",
      shipmentId: "SHP-003",
      failureClass: FailureClass.Poison,
      action: RecoveryAction.Quarantine,
      originalPayload: shp003Poison,
      reason: record.reason,
      createdAt: now,
    });
  });

  test("stores unknown / manual-review messages instead of replaying them", async () => {
    const store = new InMemoryRecoveryStore();
    const payload = { hello: "world" };
    const triage = classify(payload);

    expect(triage.action).toBe(RecoveryAction.ManualReview);
    expect(isReplayAuthorized(triage.action)).toBe(false);

    await quarantine(store, {
      messageId: "msg-unknown",
      payload,
      triage,
      recoveryId: "rec-1",
      quarantinedAt: now,
    });

    const stored = await store.getQuarantine("msg-unknown");
    expect(stored).toMatchObject({
      failureClass: FailureClass.Unknown,
      action: RecoveryAction.ManualReview,
      originalPayload: payload,
    });
  });

  test("clones the original payload so later mutation cannot rewrite quarantine", async () => {
    const store = new InMemoryRecoveryStore();
    const payload = { ...shp003Poison, customerId: null as string | null };
    await quarantine(store, {
      messageId: "msg-003",
      payload,
      triage: classify(payload),
      recoveryId: "rec-1",
      quarantinedAt: now,
    });

    payload.warehouseId = "MUTATED";
    const stored = await store.getQuarantine("msg-003");
    expect(stored?.originalPayload).toEqual(shp003Poison);
  });

  test("refuses to quarantine a replayable failure", () => {
    expect(() =>
      buildQuarantineRecord({
        messageId: "msg-001",
        payload: shp001Transient,
        triage: classify(shp001Transient),
        recoveryId: "rec-1",
      }),
    ).toThrow(/replayable/i);
  });
});
