import { migrateShipmentV1ToV2 } from "./patch";
import { isTerminalHold, quarantine } from "./quarantine";
import { classify } from "./triage";
import { validateShipmentV2 } from "./validate";
import { shipmentIdOf } from "../shared/demo-status";
import { RecoveryAction, type TriageResult } from "../shared/failure";
import type { RecoveryMessageRecord, RecoveryStore } from "../shared/recovery";
import {
  ShipmentDispatchStatus,
  type ShipmentLedger,
} from "../shared/shipments-repo";

export async function triageLoadedMessage(
  payload: unknown,
  ledger: ShipmentLedger,
): Promise<{ payload: unknown; shipmentId?: string; triage: TriageResult }> {
  const shipmentId = optionalShipmentId(payload);
  const state = shipmentId ? await ledger.getShipmentState(shipmentId) : undefined;
  return {
    payload,
    shipmentId,
    triage: classify(payload, {
      shipmentCompleted: state?.status === ShipmentDispatchStatus.Completed,
    }),
  };
}

export async function recordRecoveryDecision(input: {
  store: RecoveryStore;
  recoveryId: string;
  messageId: string;
  payload: unknown;
  shipmentId?: string;
  triage: TriageResult;
  now?: string;
}): Promise<RecoveryMessageRecord> {
  const now = input.now ?? new Date().toISOString();

  if (isTerminalHold(input.triage.action)) {
    await quarantine(input.store, {
      messageId: input.messageId,
      payload: input.payload,
      triage: input.triage,
      recoveryId: input.recoveryId,
      quarantinedAt: now,
      shipmentId: input.shipmentId,
    });
    const stored = await input.store.getRecoveryMessage(input.recoveryId, input.messageId);
    if (!stored) {
      throw new Error(`Quarantine did not persist audit for ${input.messageId}`);
    }
    return stored;
  }

  const record: RecoveryMessageRecord = {
    recoveryId: input.recoveryId,
    messageId: input.messageId,
    shipmentId: input.shipmentId ?? optionalShipmentId(input.payload),
    failureClass: input.triage.failureClass,
    action: input.triage.action,
    originalPayload: structuredClone(input.payload),
    reason: input.triage.reason,
    createdAt: now,
  };

  if (input.triage.action === RecoveryAction.Patch) {
    applyPatchProvenance(record, input.payload, now);
  }

  await input.store.putRecoveryMessage(record);
  return record;
}

function applyPatchProvenance(
  record: RecoveryMessageRecord,
  payload: unknown,
  now: string,
): void {
  try {
    const patch = migrateShipmentV1ToV2(payload, { now: () => now });
    const validation = validateShipmentV2(patch.patchedPayload);
    record.patchedPayload = patch.patchedPayload;
    record.patchVersion = patch.patchVersion;
    record.validationResult = validation.ok ? "ok" : validation.reason;
  } catch (error) {
    record.validationResult = error instanceof Error ? error.message : String(error);
  }
}

function optionalShipmentId(payload: unknown): string | undefined {
  const shipmentId = shipmentIdOf(payload);
  return shipmentId === "unknown" ? undefined : shipmentId;
}
