import {
  shp001Transient,
  shp002LegacyV1,
  shp003Poison,
  shp004AlreadyDispatched,
} from "../../src/fixtures/shipments";
import { recordRecoveryDecision, triageLoadedMessage } from "../../src/recovery/job";
import { PATCH_VERSION } from "../../src/recovery/patch";
import { buildReplayEnvelope, canReplay } from "../../src/recovery/replay";
import { validateShipmentV2 } from "../../src/recovery/validate";
import { InMemoryRecoveryStore } from "../../src/shared/recovery-repo";
import { InMemoryShipmentLedger } from "../../src/shared/shipments-repo";

describe("buildReplayEnvelope", () => {
  const now = "2026-09-10T08:00:00.000Z";

  test("replays the original transient payload with recovery metadata", async () => {
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

    const envelope = buildReplayEnvelope({
      recoveryId: "REC-1",
      originalMessageId: "m-001",
      record,
    });

    expect(canReplay(record)).toBe(true);
    expect(envelope).toEqual({
      body: shp001Transient,
      attributes: {
        recoveryId: "REC-1",
        originalMessageId: "m-001",
        replayAttempt: 1,
      },
    });
  });

  test("replays a validated v2 patch, not the original v1 payload", async () => {
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

    const envelope = buildReplayEnvelope({
      recoveryId: "REC-1",
      originalMessageId: "m-002",
      record,
    });

    expect(envelope?.attributes).toEqual({
      recoveryId: "REC-1",
      originalMessageId: "m-002",
      replayAttempt: 1,
      patchVersion: PATCH_VERSION,
    });
    expect(validateShipmentV2(envelope?.body).ok).toBe(true);
    expect(envelope?.body).toMatchObject({
      shipmentId: "SHP-002",
      customerId: "CUS-002",
      schemaVersion: 2,
    });
    expect(envelope?.body).not.toEqual(shp002LegacyV1);
  });

  test("never builds an envelope for poison or completed duplicates", async () => {
    const store = new InMemoryRecoveryStore();
    const ledger = new InMemoryShipmentLedger();
    await ledger.claimShipment("SHP-004");
    await ledger.completeShipment("SHP-004", "dispatched");

    const poison = await recordRecoveryDecision({
      store,
      recoveryId: "REC-1",
      messageId: "m-003",
      payload: shp003Poison,
      triage: (await triageLoadedMessage(shp003Poison, ledger)).triage,
      now,
    });
    const duplicate = await recordRecoveryDecision({
      store,
      recoveryId: "REC-1",
      messageId: "m-004",
      payload: shp004AlreadyDispatched,
      triage: (await triageLoadedMessage(shp004AlreadyDispatched, ledger)).triage,
      now,
    });

    expect(canReplay(poison)).toBe(false);
    expect(canReplay(duplicate)).toBe(false);
    expect(
      buildReplayEnvelope({ recoveryId: "REC-1", originalMessageId: "m-003", record: poison }),
    ).toBeUndefined();
    expect(
      buildReplayEnvelope({ recoveryId: "REC-1", originalMessageId: "m-004", record: duplicate }),
    ).toBeUndefined();
  });
});
