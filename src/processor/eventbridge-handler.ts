import type { EventBridgeEvent, Handler } from "aws-lambda";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
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

/** Queue the processor writes when an initial EventBridge delivery fails processing. */
export const EVENT_BRIDGE_DLQ_URL_ENV = "SHIPMENT_EVENTS_DLQ_URL";

/**
 * Sends one EventBridge event body to the events DLQ. Tests replace this so the
 * handler does not call SQS. A thrown sender fails the invocation.
 */
export const eventBridgeDelivery = {
  deadLetter: async (body: string): Promise<void> => {
    const queueUrl = process.env[EVENT_BRIDGE_DLQ_URL_ENV];
    if (!queueUrl) {
      throw new Error(`${EVENT_BRIDGE_DLQ_URL_ENV} is not set`);
    }
    await new SQSClient({}).send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
      }),
    );
  },
};

interface RecoveryProvenance {
  recoveryId?: string;
  originalMessageId?: string;
}

/**
 * EventBridge target for the shipment failure path. A fresh event carries the
 * bare shipment in `detail`; a recovery replay carries the shipment plus a
 * `__recovery` block.
 *
 * EventBridge invokes Lambda asynchronously and treats the handoff as success,
 * so a thrown handler never reaches the rule target's DLQ. An initial failure
 * is written once, as the EventBridge event, to ShipmentEventsDLQ, and the
 * invocation returns so Lambda does not retry it. A recovery replay still
 * throws: that failure belongs to the job already draining the queue.
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
    if (recoveryId !== undefined) {
      throw error;
    }
    await eventBridgeDelivery.deadLetter(JSON.stringify(event));
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
