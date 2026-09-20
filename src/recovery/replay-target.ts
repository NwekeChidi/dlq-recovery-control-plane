import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import {
  PublishCommand,
  SNSClient,
  type MessageAttributeValue as SnsMessageAttributeValue,
} from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import { sendReplay, type ReplayEnvelope } from "./replay";
import { RecoverySourceType } from "./source-envelope";
import {
  RECOVERY_DETAIL_KEY,
  RECOVERY_EVENT_DETAIL_TYPE,
  RECOVERY_EVENT_SOURCE,
} from "../shared/demo";
import { isRecord } from "../shared/shipment";

/**
 * Where a validated, authorized replay is sent. The recovery loop only knows
 * about this interface, so the same triage/patch/replay/observe/stop control
 * plane works whether the original failure came from an SQS-triggered Lambda,
 * an SNS subscription, or an EventBridge rule.
 */
export interface ReplayTarget {
  readonly kind: RecoverySourceType;
  /** Publishes the replay and returns the new message/event id. */
  send(envelope: ReplayEnvelope): Promise<string>;
}

/** Re-drive onto the original SQS source queue (the demo path). */
export class SqsReplayTarget implements ReplayTarget {
  readonly kind = RecoverySourceType.Sqs;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  send(envelope: ReplayEnvelope): Promise<string> {
    return sendReplay(this.sqs, this.queueUrl, envelope);
  }
}

/** Re-publish onto an SNS topic; provenance rides as message attributes. */
export class SnsReplayTarget implements ReplayTarget {
  readonly kind = RecoverySourceType.Sns;

  constructor(
    private readonly sns: SNSClient,
    private readonly topicArn: string,
  ) {}

  async send(envelope: ReplayEnvelope): Promise<string> {
    const result = await this.sns.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        Message: JSON.stringify(envelope.body),
        MessageAttributes: toSnsAttributes(envelope),
      }),
    );
    if (!result.MessageId) {
      throw new Error("SNS Publish did not return a MessageId");
    }
    return result.MessageId;
  }
}

export interface EventBridgeReplayOptions {
  eventBusName?: string;
  source?: string;
  detailType?: string;
}

/**
 * Re-publish onto an EventBridge bus. EventBridge has no per-message attributes,
 * so recovery provenance (recoveryId, originalMessageId, replayAttempt,
 * patchVersion) rides inside the event `detail` under `__recovery`; the target
 * strips it back off before processing. The DynamoDB ledger is still the system
 * of record — the in-detail copy is what lets the target write the replay result
 * back so the recovery job can observe success or failure.
 */
export class EventBridgeReplayTarget implements ReplayTarget {
  readonly kind = RecoverySourceType.EventBridge;

  constructor(
    private readonly eventBridge: EventBridgeClient,
    private readonly options: EventBridgeReplayOptions = {},
  ) {}

  async send(envelope: ReplayEnvelope): Promise<string> {
    const result = await this.eventBridge.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.options.eventBusName,
            Source: this.options.source ?? RECOVERY_EVENT_SOURCE,
            DetailType: this.options.detailType ?? RECOVERY_EVENT_DETAIL_TYPE,
            Detail: JSON.stringify(withRecoveryProvenance(envelope)),
          },
        ],
      }),
    );
    const entry = result.Entries?.[0];
    if (result.FailedEntryCount || !entry?.EventId) {
      throw new Error(
        `EventBridge PutEvents failed: ${entry?.ErrorMessage ?? "no EventId returned"}`,
      );
    }
    return entry.EventId;
  }
}

function withRecoveryProvenance(envelope: ReplayEnvelope): Record<string, unknown> {
  const provenance: Record<string, unknown> = {
    recoveryId: envelope.attributes.recoveryId,
    originalMessageId: envelope.attributes.originalMessageId,
    replayAttempt: envelope.attributes.replayAttempt,
  };
  if (envelope.attributes.patchVersion) {
    provenance.patchVersion = envelope.attributes.patchVersion;
  }
  const event = isRecord(envelope.body) ? envelope.body : { value: envelope.body };
  return { ...event, [RECOVERY_DETAIL_KEY]: provenance };
}

function toSnsAttributes(envelope: ReplayEnvelope): Record<string, SnsMessageAttributeValue> {
  const attributes: Record<string, SnsMessageAttributeValue> = {
    recoveryId: stringAttribute(envelope.attributes.recoveryId),
    originalMessageId: stringAttribute(envelope.attributes.originalMessageId),
    replayAttempt: stringAttribute(String(envelope.attributes.replayAttempt)),
  };
  if (envelope.attributes.patchVersion) {
    attributes.patchVersion = stringAttribute(envelope.attributes.patchVersion);
  }
  return attributes;
}

function stringAttribute(value: string): SnsMessageAttributeValue {
  return { DataType: "String", StringValue: value };
}
