import type { EventBridgeEvent, Handler } from "aws-lambda";
import { shipmentIdOf } from "../shared/demo-status";
import { RECOVERY_DETAIL_KEY } from "../shared/demo";
import { RecoveryLogEvent, writeRecoveryLog } from "../shared/observability";
import {
  DownstreamStatus,
  ReplayResult,
  type RecoveryStore,
} from "../shared/recovery";
import { DynamoRecoveryStore } from "../shared/recovery-repo";
import { DynamoShipmentLedger, type ShipmentLedger } from "../shared/shipments-repo";
import { isRecord } from "../shared/shipment";
import { processShipment } from "./process-shipment";

interface RecoveryProvenance {
  recoveryId?: string;
  originalMessageId?: string;
}

/**
 * EventBridge target for the shipment failure path. A fresh event carries the
 * bare shipment in `detail`; a recovery replay carries the shipment plus a
 * `__recovery` block. Failures throw so EventBridge retries and then redrives to
 * the target's SQS dead-letter queue, where the durable recovery job picks them
 * up — exactly like the SQS-triggered path.
 */
export const handler: Handler<EventBridgeEvent<string, unknown>, void> = async (
  event,
): Promise<void> => {
  const ledger = ledgerFromEnv();
  const recovery = recoveryStoreFromEnv();
  const downstreamBroken =
    recovery !== undefined
      ? (await recovery.getDownstreamStatus()) === DownstreamStatus.Broken
      : false;

  const { payload, recoveryId, originalMessageId } = splitRecovery(event.detail);

  try {
    await processShipment(payload, {
      recoveryId,
      ledger,
      downstreamBroken: recoveryId !== undefined && downstreamBroken,
    });
    await recordReplayResult(recovery, recoveryId, originalMessageId, ReplayResult.Success);
    logReplayResult(recoveryId, originalMessageId, payload, ReplayResult.Success);
  } catch (error) {
    await recordReplayResult(recovery, recoveryId, originalMessageId, ReplayResult.Failed);
    logReplayResult(recoveryId, originalMessageId, payload, ReplayResult.Failed);
    throw error;
  }
};

function splitRecovery(detail: unknown): {
  payload: unknown;
  recoveryId?: string;
  originalMessageId?: string;
} {
  if (!isRecord(detail) || !isRecord(detail[RECOVERY_DETAIL_KEY])) {
    return { payload: detail };
  }
  const provenance = detail[RECOVERY_DETAIL_KEY] as RecoveryProvenance;
  const payload = { ...detail };
  delete payload[RECOVERY_DETAIL_KEY];
  return {
    payload,
    recoveryId: typeof provenance.recoveryId === "string" ? provenance.recoveryId : undefined,
    originalMessageId:
      typeof provenance.originalMessageId === "string" ? provenance.originalMessageId : undefined,
  };
}

function logReplayResult(
  recoveryId: string | undefined,
  originalMessageId: string | undefined,
  payload: unknown,
  result: ReplayResult.Success | ReplayResult.Failed,
): void {
  if (!recoveryId) {
    return;
  }
  const shipmentId = shipmentIdOf(payload);
  writeRecoveryLog({
    event: RecoveryLogEvent.ReplayResult,
    recoveryId,
    messageId: originalMessageId,
    shipmentId: shipmentId === "unknown" ? undefined : shipmentId,
    replayResult: result,
  });
}

async function recordReplayResult(
  store: RecoveryStore | undefined,
  recoveryId: string | undefined,
  originalMessageId: string | undefined,
  result: ReplayResult.Success | ReplayResult.Failed,
): Promise<void> {
  if (!store || !recoveryId || !originalMessageId) {
    return;
  }
  await store.markReplayResult(recoveryId, originalMessageId, result);
}

function ledgerFromEnv(): ShipmentLedger | undefined {
  const tableName = process.env.DEMO_LEDGER_TABLE_NAME;
  return tableName ? DynamoShipmentLedger.fromTableName(tableName) : undefined;
}

function recoveryStoreFromEnv(): RecoveryStore | undefined {
  const tableName = process.env.DEMO_LEDGER_TABLE_NAME;
  return tableName ? DynamoRecoveryStore.fromTableName(tableName) : undefined;
}
