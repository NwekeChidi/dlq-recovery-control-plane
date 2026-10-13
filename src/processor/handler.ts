import type { SQSHandler } from "aws-lambda";
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

export const handler: SQSHandler = async (event): Promise<void> => {
  const ledger = ledgerFromEnv();
  const recovery = recoveryStoreFromEnv();
  const downstreamBroken =
    recovery !== undefined
      ? (await recovery.getDownstreamStatus()) === DownstreamStatus.Broken
      : false;

  for (const record of event.Records) {
    const recoveryId = record.messageAttributes.recoveryId?.stringValue;
    const originalMessageId = record.messageAttributes.originalMessageId?.stringValue;
    const payload = parseBody(record.body);
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
  if (!tableName) {
    return undefined;
  }
  return DynamoShipmentLedger.fromTableName(tableName);
}

function recoveryStoreFromEnv(): RecoveryStore | undefined {
  const tableName = process.env.DEMO_LEDGER_TABLE_NAME;
  if (!tableName) {
    return undefined;
  }
  return DynamoRecoveryStore.fromTableName(tableName);
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new InvalidShipmentError("Message body is not valid JSON");
  }
}
