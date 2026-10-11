import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord, DynamoDBStreamHandler } from "aws-lambda";
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
import { DYNAMODB_STREAM_EVENT_SOURCE } from "../recovery/source-envelope";
import { processShipment } from "./process-shipment";

/** Queue the processor writes when an initial stream record fails processing. */
export const STREAM_DLQ_URL_ENV = "SHIPMENT_STREAM_DLQ_URL";

/**
 * Sends one stream-failure body to the stream DLQ. Tests replace this so the
 * handler does not call SQS. A thrown sender fails the invocation.
 */
export const streamDelivery = {
  deadLetter: async (body: string): Promise<void> => {
    const queueUrl = process.env[STREAM_DLQ_URL_ENV];
    if (!queueUrl) {
      throw new Error(`${STREAM_DLQ_URL_ENV} is not set`);
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
 * DynamoDB Streams target for the shipment failure path. A fresh insert carries
 * the shipment as the item. A recovery replay puts the same item back with a
 * `__recovery` block, which creates a new stream record.
 *
 * A stream has no redrive DLQ. An initial failure is written once, as a stream
 * failure envelope, to ShipmentStreamDLQ, and the invocation returns so the
 * iterator moves on. A recovery replay still throws: that failure belongs to
 * the job already draining the queue. The event source mapping retries a thrown
 * replay a couple of times, then drops it, so one failed replay does not pin
 * the shard until the record expires.
 */
export const handler: DynamoDBStreamHandler = async (event): Promise<void> => {
  const ledger = ledgerFromEnv();
  const recovery = recoveryStoreFromEnv();
  const downstreamBroken =
    recovery !== undefined
      ? (await recovery.getDownstreamStatus()) === DownstreamStatus.Broken
      : false;

  for (const record of event.Records) {
    const image = record.dynamodb?.NewImage;
    if (!image) {
      continue;
    }
    const raw = unmarshall(image as Record<string, AttributeValue>);
    const { payload, recoveryId, originalMessageId } = splitRecovery(raw);
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
      await streamDelivery.deadLetter(streamFailureEnvelope(record, payload));
    }
  }
};

/** Body shape `parseSourceEnvelope` recognizes as a DynamoDB stream failure. */
export function streamFailureEnvelope(record: DynamoDBRecord, item: unknown): string {
  return JSON.stringify({
    eventSource: DYNAMODB_STREAM_EVENT_SOURCE,
    eventID: record.eventID,
    eventName: record.eventName,
    item,
  });
}

function splitRecovery(item: Record<string, unknown>): {
  payload: Record<string, unknown>;
  recoveryId?: string;
  originalMessageId?: string;
} {
  const provenance = isRecord(item[RECOVERY_DETAIL_KEY])
    ? (item[RECOVERY_DETAIL_KEY] as RecoveryProvenance)
    : undefined;
  const payload = { ...item };
  delete payload.pk;
  delete payload[RECOVERY_DETAIL_KEY];
  return {
    payload,
    recoveryId: typeof provenance?.recoveryId === "string" ? provenance.recoveryId : undefined,
    originalMessageId:
      typeof provenance?.originalMessageId === "string" ? provenance.originalMessageId : undefined,
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
