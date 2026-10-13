import { shipmentIdOf } from "../shared/demo-status";
import { RecoveryAction, type TriageResult } from "../shared/failure";
import type { QuarantineRecord, RecoveryStore } from "../shared/recovery";

export const SOURCE_QUEUE_SHIPMENTS_DLQ = "ShipmentsDLQ";

export function isTerminalHold(action: RecoveryAction): boolean {
  return action === RecoveryAction.Quarantine || action === RecoveryAction.ManualReview;
}

export function isReplayAuthorized(action: RecoveryAction): boolean {
  return action === RecoveryAction.Replay || action === RecoveryAction.Patch;
}

export interface QuarantineInput {
  messageId: string;
  payload: unknown;
  triage: TriageResult;
  recoveryId: string;
  sourceQueue?: string;
  quarantinedAt?: string;
  shipmentId?: string;
}

export function buildQuarantineRecord(input: QuarantineInput): QuarantineRecord {
  if (!isTerminalHold(input.triage.action)) {
    throw new Error(
      `Cannot quarantine a message with action ${input.triage.action}; it would hide a replayable failure`,
    );
  }

  return {
    messageId: input.messageId,
    shipmentId: input.shipmentId ?? shipmentIdFromPayload(input.payload),
    originalPayload: structuredClone(input.payload),
    failureClass: input.triage.failureClass,
    action: input.triage.action,
    reason: input.triage.reason,
    sourceQueue: input.sourceQueue ?? SOURCE_QUEUE_SHIPMENTS_DLQ,
    recoveryId: input.recoveryId,
    quarantinedAt: input.quarantinedAt ?? new Date().toISOString(),
  };
}

export async function quarantine(
  store: RecoveryStore,
  input: QuarantineInput,
): Promise<QuarantineRecord> {
  const record = buildQuarantineRecord(input);
  await store.putQuarantine(record);
  await store.putRecoveryMessage({
    recoveryId: record.recoveryId,
    messageId: record.messageId,
    shipmentId: record.shipmentId,
    failureClass: record.failureClass,
    action: record.action,
    originalPayload: record.originalPayload,
    reason: record.reason,
    createdAt: record.quarantinedAt,
  });
  return record;
}

function shipmentIdFromPayload(payload: unknown): string | undefined {
  const shipmentId = shipmentIdOf(payload);
  return shipmentId === "unknown" ? undefined : shipmentId;
}
