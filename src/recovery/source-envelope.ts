import { parseDlqBody } from "./load";
import { isRecord } from "../shared/shipment";

/**
 * The failure paths this recovery control plane can ingest from.
 *
 * All three deliver their failed work to an SQS dead-letter queue:
 *   - SQS-triggered Lambda: the DLQ body is the original message body.
 *   - SNS: a failed delivery redrives to an SQS DLQ as an SNS *notification*
 *     envelope; the original event is the stringified `Message` field.
 *   - EventBridge: the processor writes the failed event onto an SQS DLQ; the
 *     original event is that EventBridge event, whose payload is `detail`.
 *
 * Triage, patch, validate, replay, and observe are source-agnostic: they only
 * ever see `originalEvent`. Only ingest (this file) and egress (replay-target)
 * are source-aware.
 */
export enum RecoverySourceType {
  Sqs = "SQS",
  Sns = "SNS",
  EventBridge = "EVENT_BRIDGE",
}

export interface SourceEnvelope {
  sourceType: RecoverySourceType;
  /** The business event that triage and patch operate on. */
  originalEvent: unknown;
  /** Hints for re-publishing onto the same kind of path. */
  eventBridge?: {
    source?: string;
    detailType?: string;
    resources?: string[];
  };
  sns?: {
    subject?: string;
    topicArn?: string;
  };
}

/**
 * Normalize a raw DLQ body (string from SQS `ReceiveMessage`, or an
 * already-parsed object) into a source-tagged envelope. Unknown shapes fall
 * back to `SQS` so the current demo path is unchanged.
 */
export function parseSourceEnvelope(body: unknown): SourceEnvelope {
  const parsed = typeof body === "string" ? parseDlqBody(body) : body;

  if (isRecord(parsed)) {
    if (isSnsNotification(parsed)) {
      return {
        sourceType: RecoverySourceType.Sns,
        originalEvent: unwrapString(parsed.Message),
        sns: {
          subject: asString(parsed.Subject),
          topicArn: asString(parsed.TopicArn),
        },
      };
    }

    if (isEventBridgeEvent(parsed)) {
      return {
        sourceType: RecoverySourceType.EventBridge,
        originalEvent: parsed.detail,
        eventBridge: {
          source: asString(parsed.source),
          detailType: asString(parsed["detail-type"]),
          resources: Array.isArray(parsed.resources)
            ? parsed.resources.filter((value): value is string => typeof value === "string")
            : undefined,
        },
      };
    }
  }

  return { sourceType: RecoverySourceType.Sqs, originalEvent: parsed };
}

function isSnsNotification(record: Record<string, unknown>): boolean {
  return record.Type === "Notification" && typeof record.Message === "string";
}

function isEventBridgeEvent(record: Record<string, unknown>): boolean {
  return "detail-type" in record && "detail" in record && "source" in record;
}

function unwrapString(value: unknown): unknown {
  return typeof value === "string" ? parseDlqBody(value) : value;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
