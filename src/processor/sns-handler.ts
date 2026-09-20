import type { SNSHandler } from "aws-lambda";
import { shipmentIdOf } from "../shared/demo-status";
import { InvalidShipmentError } from "../shared/errors";
import { RecoveryLogEvent, writeRecoveryLog } from "../shared/observability";
import {
  DownstreamStatus,
  ReplayResult,
  type RecoveryStore,
} from "../shared/recovery";
import { DynamoRecoveryStore } from "../shared/recovery-repo";
import { DynamoShipmentLedger, type ShipmentLedger } from "../shared/shipments-repo";
import { processShipment } from "./process-shipment";

/**
 * SNS subscription target for the shipment failure path. A fresh publish carries
 * the shipment as the SNS `Message`; a recovery replay carries the same message
 * plus recovery provenance as SNS message attributes (SNS, unlike EventBridge,
 * has per-message attributes — so this reads just like the SQS handler).
 * Failures throw so SNS retries and then redrives to the subscription's SQS
 * dead-letter queue, where the durable recovery job picks them up.
 */
export const handler: SNSHandler = async (event): Promise<void> => {
  const ledger = ledgerFromEnv();
  const recovery = recoveryStoreFromEnv();
  const downstreamBroken =
    recovery !== undefined
      ? (await recovery.getDownstreamStatus()) === DownstreamStatus.Broken
      : false;

  for (const record of event.Records) {
    const attributes = record.Sns.MessageAttributes ?? {};
    const recoveryId = attributes.recoveryId?.Value;
    const originalMessageId = attributes.originalMessageId?.Value;
    const payload = parseMessage(record.Sns.Message);
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
  }
};

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

function parseMessage(message: string): unknown {
  try {
    return JSON.parse(message) as unknown;
  } catch {
    throw new InvalidShipmentError("SNS message is not valid JSON");
  }
}
