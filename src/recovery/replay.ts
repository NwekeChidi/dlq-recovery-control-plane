import { SendMessageCommand, SQSClient, type MessageAttributeValue } from "@aws-sdk/client-sqs";
import { isReplayAuthorized } from "./quarantine";
import { RecoveryAction } from "../shared/failure";
import { ReplayResult, type RecoveryMessageRecord } from "../shared/recovery";

export const INITIAL_REPLAY_ATTEMPT = 1;

export enum ReplayAttributeName {
  RecoveryId = "recoveryId",
  OriginalMessageId = "originalMessageId",
  ReplayAttempt = "replayAttempt",
  PatchVersion = "patchVersion",
}

export interface ReplayEnvelope {
  body: unknown;
  attributes: {
    recoveryId: string;
    originalMessageId: string;
    replayAttempt: number;
    patchVersion?: string;
  };
}

export function canReplay(record: RecoveryMessageRecord): boolean {
  if (!isReplayAuthorized(record.action)) {
    return false;
  }
  if (record.action === RecoveryAction.Patch) {
    return record.validationResult === "ok" && record.patchedPayload !== undefined;
  }
  return true;
}

export function buildReplayEnvelope(input: {
  recoveryId: string;
  originalMessageId: string;
  record: RecoveryMessageRecord;
  replayAttempt?: number;
}): ReplayEnvelope | undefined {
  if (!canReplay(input.record)) {
    return undefined;
  }

  return {
    body:
      input.record.action === RecoveryAction.Patch
        ? input.record.patchedPayload
        : input.record.originalPayload,
    attributes: {
      recoveryId: input.recoveryId,
      originalMessageId: input.originalMessageId,
      replayAttempt: input.replayAttempt ?? INITIAL_REPLAY_ATTEMPT,
      ...(input.record.patchVersion ? { patchVersion: input.record.patchVersion } : {}),
    },
  };
}

export function replayOutcome(record: RecoveryMessageRecord): RecoveryMessageRecord {
  const envelope = buildReplayEnvelope({
    recoveryId: record.recoveryId,
    originalMessageId: record.messageId,
    record,
  });
  if (!envelope) {
    return { ...record, replayResult: ReplayResult.NotSent };
  }
  return {
    ...record,
    replayAttempt: envelope.attributes.replayAttempt,
    replayResult: ReplayResult.Sent,
  };
}

export async function sendReplay(
  sqs: SQSClient,
  queueUrl: string,
  envelope: ReplayEnvelope,
): Promise<string> {
  const result = await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(envelope.body),
      MessageAttributes: toMessageAttributes(envelope),
    }),
  );
  if (!result.MessageId) {
    throw new Error("SQS SendMessage did not return a MessageId");
  }
  return result.MessageId;
}

function toMessageAttributes(envelope: ReplayEnvelope): Record<string, MessageAttributeValue> {
  const attributes: Record<string, MessageAttributeValue> = {
    [ReplayAttributeName.RecoveryId]: stringAttribute(envelope.attributes.recoveryId),
    [ReplayAttributeName.OriginalMessageId]: stringAttribute(envelope.attributes.originalMessageId),
    [ReplayAttributeName.ReplayAttempt]: stringAttribute(String(envelope.attributes.replayAttempt)),
  };
  if (envelope.attributes.patchVersion) {
    attributes[ReplayAttributeName.PatchVersion] = stringAttribute(envelope.attributes.patchVersion);
  }
  return attributes;
}

function stringAttribute(value: string): MessageAttributeValue {
  return { DataType: "String", StringValue: value };
}
