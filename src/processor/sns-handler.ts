import type { SNSEventRecord, SNSHandler } from "aws-lambda";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
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

/** Queue the processor writes when an initial SNS delivery fails processing. */
export const SNS_NOTIFICATIONS_DLQ_URL_ENV = "SHIPMENT_NOTIFICATIONS_DLQ_URL";

/**
 * Sends one SNS Notification body to the notifications DLQ. Tests replace this
 * so the handler does not call SQS. A thrown sender fails the invocation.
 */
export const snsDelivery = {
  deadLetter: async (body: string): Promise<void> => {
    const queueUrl = process.env[SNS_NOTIFICATIONS_DLQ_URL_ENV];
    if (!queueUrl) {
      throw new Error(`${SNS_NOTIFICATIONS_DLQ_URL_ENV} is not set`);
    }
    await new SQSClient({}).send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
      }),
    );
  },
};

/**
 * SNS subscription target for the shipment failure path. A fresh publish carries
 * the shipment as the SNS `Message`; a recovery replay carries the same message
 * plus recovery provenance as SNS message attributes.
 *
 * SNS invokes Lambda asynchronously and does not redrive a thrown handler to the
 * subscription DLQ. An initial failure is written once, as an SNS Notification,
 * to ShipmentNotificationsDLQ, and the invocation returns so Lambda does not
 * retry it. A recovery replay still throws: that failure belongs to the job
 * already draining the queue, and copying it back would duplicate the message.
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
      if (recoveryId !== undefined) {
        throw error;
      }
      await snsDelivery.deadLetter(notificationEnvelope(record));
    }
  }
};

/** Body shape `parseSourceEnvelope` recognizes as an SNS notification. */
export function notificationEnvelope(record: SNSEventRecord): string {
  return JSON.stringify({
    Type: "Notification",
    MessageId: record.Sns.MessageId,
    TopicArn: record.Sns.TopicArn,
    Subject: record.Sns.Subject,
    Message: record.Sns.Message,
    Timestamp: record.Sns.Timestamp,
  });
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

function parseMessage(message: string): unknown {
  try {
    return JSON.parse(message) as unknown;
  } catch {
    throw new InvalidShipmentError("SNS message is not valid JSON");
  }
}
