import {
  shp001Transient,
  shp002LegacyV1,
  shp003Poison,
  shp004AlreadyDispatched,
} from "../../src/fixtures/shipments";
import { recordRecoveryDecision, triageLoadedMessage } from "../../src/recovery/job";
import { PATCH_VERSION } from "../../src/recovery/patch";
import { parseDlqBody } from "../../src/recovery/load";
import { FailureClass, RecoveryAction } from "../../src/shared/failure";
import { InMemoryRecoveryStore } from "../../src/shared/recovery-repo";
import { InMemoryShipmentLedger } from "../../src/shared/shipments-repo";

describe("triageLoadedMessage", () => {
  test("uses ledger completion evidence for SHP-004", async () => {
    const ledger = new InMemoryShipmentLedger();
    await ledger.claimShipment("SHP-004");
    await ledger.completeShipment("SHP-004", "dispatched");

    const classified = await triageLoadedMessage(shp004AlreadyDispatched, ledger);
    expect(classified.triage.failureClass).toBe(FailureClass.Duplicate);
    expect(classified.triage.action).toBe(RecoveryAction.Skip);
  });
});

describe("recordRecoveryDecision", () => {
  const now = "2026-09-10T05:00:00.000Z";

  test("marks a transient message as a replay candidate without quarantining", async () => {
    const store = new InMemoryRecoveryStore();
    const triage = (await triageLoadedMessage(shp001Transient, new InMemoryShipmentLedger())).triage;
    const record = await recordRecoveryDecision({
      store,
      recoveryId: "REC-1",
      messageId: "m-001",
      payload: shp001Transient,
      triage,
      now,
    });

    expect(record.action).toBe(RecoveryAction.Replay);
    expect(record.failureClass).toBe(FailureClass.Transient);
    await expect(store.getQuarantine("m-001")).resolves.toBeUndefined();
  });

  test("records patch provenance for schema mismatch", async () => {
    const store = new InMemoryRecoveryStore();
    const triage = (await triageLoadedMessage(shp002LegacyV1, new InMemoryShipmentLedger())).triage;
    const record = await recordRecoveryDecision({
      store,
      recoveryId: "REC-1",
      messageId: "m-002",
      payload: shp002LegacyV1,
      triage,
      now,
    });

    expect(record.action).toBe(RecoveryAction.Patch);
    expect(record.patchVersion).toBe(PATCH_VERSION);
    expect(record.validationResult).toBe("ok");
    expect(record.patchedPayload).toMatchObject({ shipmentId: "SHP-002", schemaVersion: 2 });
    expect(record.originalPayload).toEqual(shp002LegacyV1);
  });

  test("quarantines poison with the original payload intact", async () => {
    const store = new InMemoryRecoveryStore();
    const triage = (await triageLoadedMessage(shp003Poison, new InMemoryShipmentLedger())).triage;
    const record = await recordRecoveryDecision({
      store,
      recoveryId: "REC-1",
      messageId: "m-003",
      payload: shp003Poison,
      triage,
      now,
    });

    expect(record.action).toBe(RecoveryAction.Quarantine);
    const quarantined = await store.getQuarantine("m-003");
    expect(quarantined?.originalPayload).toEqual(shp003Poison);
    expect(quarantined?.reason).toBe(record.reason);
  });
});

describe("parseDlqBody", () => {
  test("parses JSON and leaves invalid bodies as text", () => {
    expect(parseDlqBody(JSON.stringify(shp001Transient))).toEqual(shp001Transient);
    expect(parseDlqBody("not-json")).toBe("not-json");
  });
});
