import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { DurableContext } from "@aws/durable-execution-sdk-js";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { deleteDlqMessage, loadDlqBatch, type DlqMessage } from "./load";
import { observeReplayHealth, type RecoveryHealth } from "./observe";
import { recordRecoveryDecision, triageLoadedMessage } from "./job";
import { isTerminalHold } from "./quarantine";
import { buildReplayEnvelope, replayOutcome, type ReplayEnvelope } from "./replay";
import {
  DynamoDbReplayTarget,
  EventBridgeReplayTarget,
  SnsReplayTarget,
  SqsReplayTarget,
  type ReplayTarget,
} from "./replay-target";
import { parseSourceEnvelope } from "./source-envelope";
import { RecoveryAction } from "../shared/failure";
import {
  RecoveryLogEvent,
  recoveryMetricsSnapshot,
  writeRecoveryLog,
  writeRecoveryMetrics,
  type RecoveryLogRecord,
  type RecoveryMetricsSnapshot,
} from "../shared/observability";
import { DynamoRecoveryStore } from "../shared/recovery-repo";
import {
  completeRecoveryJob,
  createRecoveryId,
  createStartedRecoveryJob,
  RecoveryJobStatus,
  RecoveryReplayTargetKind,
  resolveRecoveryKnobs,
  stopRecoveryJob,
  type RecoveryStartEvent,
  type RecoveryStore,
  type RecoveryMessageRecord,
} from "../shared/recovery";
import { DynamoShipmentLedger, type ShipmentLedger } from "../shared/shipments-repo";

export interface RecoveryStartResult {
  recoveryId: string;
  processedCount: number;
  quarantinedCount: number;
  suppressedCount: number;
  replayCandidateCount: number;
  patchCandidateCount: number;
  recoveredCount: number;
  failureCount: number;
  failureRate: number;
  status: RecoveryJobStatus;
  stopReason?: string;
}

export interface RecoveryHandlerDeps {
  loadBatch: (batchSize: number) => Promise<DlqMessage[]>;
  replay: (envelope: ReplayEnvelope) => Promise<void>;
  deleteMessage: (receiptHandle: string) => Promise<void>;
  ledger: ShipmentLedger;
  store: RecoveryStore;
  log?: (record: RecoveryLogRecord) => void;
  emitMetrics?: (snapshot: Partial<RecoveryMetricsSnapshot>, recoveryId: string) => void;
  now?: () => string;
  createRecoveryId?: () => string;
}

interface DecisionCounts {
  processedCount: number;
  quarantinedCount: number;
  suppressedCount: number;
  replayCandidateCount: number;
  patchCandidateCount: number;
  replayedCount: number;
}

export function createRecoveryHandler(deps: RecoveryHandlerDeps) {
  return withDurableExecution<RecoveryStartEvent, RecoveryStartResult>(async (event, context) =>
    runRecovery(event ?? {}, context, deps),
  );
}

export const handler = withDurableExecution<RecoveryStartEvent, RecoveryStartResult>(
  async (event, context) => runRecovery(event ?? {}, context, depsFromEnv(event ?? {})),
);

export async function runRecovery(
  event: RecoveryStartEvent,
  context: DurableContext,
  deps: RecoveryHandlerDeps,
): Promise<RecoveryStartResult> {
  const knobs = resolveRecoveryKnobs(event);
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? writeRecoveryLog;
  const emitMetrics = deps.emitMetrics ?? writeRecoveryMetrics;

  const recoveryId = await context.step("create-job", async () => {
    const id = event.recoveryId ?? (deps.createRecoveryId ?? createRecoveryId)();
    await deps.store.putRecoveryJob(
      createStartedRecoveryJob({
        recoveryId: id,
        startedAt: now(),
        batchSize: knobs.batchSize,
        maxFailureRate: knobs.maxFailureRate,
        replayDelaySeconds: knobs.replayDelaySeconds,
      }),
    );
    log({ event: RecoveryLogEvent.RecoveryStarted, recoveryId: id });
    emitMetrics({ RecoveryStarted: 1 }, id);
    return id;
  });

  const counts: DecisionCounts = {
    processedCount: 0,
    quarantinedCount: 0,
    suppressedCount: 0,
    replayCandidateCount: 0,
    patchCandidateCount: 0,
    replayedCount: 0,
  };
  let lastHealth: RecoveryHealth = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    failureRate: 0,
    safeToContinue: true,
  };

  for (let batchIndex = 0; ; batchIndex += 1) {
    const loaded = await context.step(`load-batch-${batchIndex}`, async () =>
      deps.loadBatch(knobs.batchSize),
    );
    if (loaded.length === 0) {
      break;
    }

    const decisions = [];
    let replayedThisBatch = 0;
    for (const message of loaded) {
      const classified = await context.step(`triage-${batchIndex}-${message.messageId}`, async () =>
        triageLoadedMessage(parseSourceEnvelope(message.body).originalEvent, deps.ledger),
      );
      const recorded = await context.step(`record-${batchIndex}-${message.messageId}`, async () => {
        const record = await recordRecoveryDecision({
          store: deps.store,
          recoveryId,
          messageId: message.messageId,
          payload: classified.payload,
          shipmentId: classified.shipmentId,
          triage: classified.triage,
          now: now(),
        });
        logDecision(log, record);
        return record;
      });
      const sent = await context.step(`replay-${batchIndex}-${message.messageId}`, async () => {
        const envelope = buildReplayEnvelope({
          recoveryId,
          originalMessageId: message.messageId,
          record: recorded,
        });
        if (!envelope) {
          await deps.store.putRecoveryMessage(replayOutcome(recorded));
          return false;
        }
        const outcome = replayOutcome(recorded);
        await deps.store.putRecoveryMessage(outcome);
        await deps.replay(envelope);
        log({
          event: RecoveryLogEvent.MessageReplayed,
          recoveryId,
          messageId: recorded.messageId,
          shipmentId: recorded.shipmentId,
          failureClass: recorded.failureClass,
          action: recorded.action,
          patchVersion: recorded.patchVersion,
          replayAttempt: outcome.replayAttempt,
          replayResult: outcome.replayResult,
        });
        return true;
      });
      await context.step(`delete-${batchIndex}-${message.messageId}`, async () => {
        await deps.deleteMessage(message.receiptHandle);
      });
      decisions.push(recorded);
      if (sent) {
        replayedThisBatch += 1;
        counts.replayedCount += 1;
      }
    }

    addDecisionCounts(counts, decisions);

    if (replayedThisBatch > 0 && knobs.replayDelaySeconds > 0) {
      await context.wait(`wait-batch-${batchIndex}`, { seconds: knobs.replayDelaySeconds });
    }

    lastHealth = await context.step(`observe-batch-${batchIndex}`, async () => {
      const messages = await deps.store.listRecoveryMessages(recoveryId);
      const health = observeReplayHealth(messages, knobs.maxFailureRate);
      log({
        event: RecoveryLogEvent.RecoveryObserved,
        recoveryId,
        failureRate: health.failureRate,
        attempted: health.attempted,
        succeeded: health.succeeded,
        failed: health.failed,
        safeToContinue: health.safeToContinue,
        reason: health.reason,
      });
      return health;
    });

    if (!lastHealth.safeToContinue) {
      await context.step("stop-job", async () => {
        const job = await requireJob(deps.store, recoveryId);
        await deps.store.putRecoveryJob(
          stopRecoveryJob(
            job,
            lastHealth.reason ?? "Replay failure rate exceeded maxFailureRate",
            {
              processedCount: counts.processedCount,
              quarantinedCount: counts.quarantinedCount,
              suppressedCount: counts.suppressedCount,
              recoveredCount: lastHealth.succeeded,
              failureCount: lastHealth.failed,
            },
            now(),
          ),
        );
        log({
          event: RecoveryLogEvent.RecoveryStopped,
          recoveryId,
          reason: lastHealth.reason,
          failureRate: lastHealth.failureRate,
          status: RecoveryJobStatus.Stopped,
        });
        emitMetrics(metricsFrom(counts, lastHealth, true), recoveryId);
      });
      return toResult(recoveryId, counts, lastHealth, RecoveryJobStatus.Stopped);
    }
  }

  await context.step("complete-job", async () => {
    const job = await requireJob(deps.store, recoveryId);
    await deps.store.putRecoveryJob(
      completeRecoveryJob(
        job,
        {
          processedCount: counts.processedCount,
          quarantinedCount: counts.quarantinedCount,
          suppressedCount: counts.suppressedCount,
          recoveredCount: lastHealth.succeeded,
          failureCount: lastHealth.failed,
        },
        now(),
      ),
    );
    log({
      event: RecoveryLogEvent.RecoveryCompleted,
      recoveryId,
      status: RecoveryJobStatus.Completed,
      failureRate: lastHealth.failureRate,
    });
    emitMetrics(metricsFrom(counts, lastHealth, false), recoveryId);
  });

  return toResult(recoveryId, counts, lastHealth, RecoveryJobStatus.Completed);
}

function addDecisionCounts(
  counts: DecisionCounts,
  decisions: Array<{ action: RecoveryAction }>,
): void {
  counts.processedCount += decisions.length;
  counts.quarantinedCount += decisions.filter((decision) => isTerminalHold(decision.action)).length;
  counts.suppressedCount += decisions.filter(
    (decision) => decision.action === RecoveryAction.Skip,
  ).length;
  counts.replayCandidateCount += decisions.filter(
    (decision) => decision.action === RecoveryAction.Replay,
  ).length;
  counts.patchCandidateCount += decisions.filter(
    (decision) => decision.action === RecoveryAction.Patch,
  ).length;
}

function toResult(
  recoveryId: string,
  counts: DecisionCounts,
  health: RecoveryHealth,
  status: RecoveryJobStatus,
): RecoveryStartResult {
  return {
    recoveryId,
    processedCount: counts.processedCount,
    quarantinedCount: counts.quarantinedCount,
    suppressedCount: counts.suppressedCount,
    replayCandidateCount: counts.replayCandidateCount,
    patchCandidateCount: counts.patchCandidateCount,
    recoveredCount: health.succeeded,
    failureCount: health.failed,
    failureRate: health.failureRate,
    status,
    stopReason: status === RecoveryJobStatus.Stopped ? health.reason : undefined,
  };
}

function metricsFrom(
  counts: DecisionCounts,
  health: RecoveryHealth,
  stopped: boolean,
): RecoveryMetricsSnapshot {
  return recoveryMetricsSnapshot({
    triaged: counts.processedCount,
    patched: counts.patchCandidateCount,
    replayed: counts.replayedCount,
    recovered: health.succeeded,
    quarantined: counts.quarantinedCount,
    suppressed: counts.suppressedCount,
    failureRate: health.failureRate,
    stopped,
  });
}

function logDecision(
  log: (record: RecoveryLogRecord) => void,
  record: RecoveryMessageRecord,
): void {
  const base = {
    recoveryId: record.recoveryId,
    messageId: record.messageId,
    shipmentId: record.shipmentId,
    failureClass: record.failureClass,
    action: record.action,
    patchVersion: record.patchVersion,
    reason: record.reason,
  };
  log({ event: RecoveryLogEvent.MessageTriaged, ...base });
  if (record.action === RecoveryAction.Patch) {
    log({ event: RecoveryLogEvent.MessagePatched, ...base });
  }
  if (isTerminalHold(record.action)) {
    log({ event: RecoveryLogEvent.MessageQuarantined, ...base });
  }
  if (record.action === RecoveryAction.Skip) {
    log({ event: RecoveryLogEvent.DuplicateDispatchSuppressed, ...base });
  }
}

async function requireJob(store: RecoveryStore, recoveryId: string) {
  const job = await store.getRecoveryJob(recoveryId);
  if (!job) {
    throw new Error(`Recovery job ${recoveryId} was not found`);
  }
  return job;
}

function depsFromEnv(event: RecoveryStartEvent): RecoveryHandlerDeps {
  const tableName = process.env.DEMO_LEDGER_TABLE_NAME;
  const dlqUrl = event.dlqUrl ?? process.env.SHIPMENTS_DLQ_URL;
  const queueUrl = process.env.SHIPMENTS_QUEUE_URL;
  if (!tableName || !dlqUrl || !queueUrl) {
    throw new Error(
      "DEMO_LEDGER_TABLE_NAME, SHIPMENTS_DLQ_URL, and SHIPMENTS_QUEUE_URL are required",
    );
  }
  const sqs = new SQSClient({});
  const replayTarget = resolveReplayTarget(event, sqs, queueUrl);
  return {
    loadBatch: (batchSize) => loadDlqBatch(sqs, dlqUrl, batchSize),
    replay: (envelope) => replayTarget.send(envelope).then(() => undefined),
    deleteMessage: (receiptHandle) => deleteDlqMessage(sqs, dlqUrl, receiptHandle),
    ledger: DynamoShipmentLedger.fromTableName(tableName),
    store: DynamoRecoveryStore.fromTableName(tableName),
  };
}

/**
 * Selects where authorized replays are published. The demo defaults to the SQS
 * source queue; a start event (or RECOVERY_REPLAY_TARGET env) can swap the
 * egress to SNS, EventBridge, or DynamoDB without touching the triage/patch/
 * replay/observe/stop control plane. The start event wins so one deployed
 * function can recover any of the failure paths.
 */
function resolveReplayTarget(
  event: RecoveryStartEvent,
  sqs: SQSClient,
  queueUrl: string,
): ReplayTarget {
  const kind = parseReplayTargetKind(event.replayTarget ?? process.env.RECOVERY_REPLAY_TARGET);
  if (kind === RecoveryReplayTargetKind.Sns) {
    const topicArn = event.snsTopicArn ?? process.env.RECOVERY_SNS_TOPIC_ARN;
    if (!topicArn) {
      throw new Error("snsTopicArn is required when replayTarget is sns");
    }
    return new SnsReplayTarget(new SNSClient({}), topicArn);
  }
  if (kind === RecoveryReplayTargetKind.EventBridge) {
    const eventBusName = event.eventBusName ?? process.env.RECOVERY_EVENT_BUS_NAME;
    if (!eventBusName) {
      throw new Error("eventBusName is required when replayTarget is eventbridge");
    }
    return new EventBridgeReplayTarget(new EventBridgeClient({}), {
      eventBusName,
      source: process.env.RECOVERY_EVENT_SOURCE,
      detailType: process.env.RECOVERY_EVENT_DETAIL_TYPE,
    });
  }
  if (kind === RecoveryReplayTargetKind.DynamoDb) {
    const functionArn = event.streamProcessorArn ?? process.env.SHIPMENT_STREAM_PROCESSOR_ARN;
    if (!functionArn) {
      throw new Error("streamProcessorArn is required when replayTarget is dynamodb");
    }
    return new DynamoDbReplayTarget(new LambdaClient({}), functionArn);
  }
  return new SqsReplayTarget(sqs, queueUrl);
}

function parseReplayTargetKind(value: string | undefined): RecoveryReplayTargetKind {
  switch (value?.toLowerCase()) {
    case RecoveryReplayTargetKind.Sns:
      return RecoveryReplayTargetKind.Sns;
    case RecoveryReplayTargetKind.EventBridge:
      return RecoveryReplayTargetKind.EventBridge;
    case RecoveryReplayTargetKind.DynamoDb:
      return RecoveryReplayTargetKind.DynamoDb;
    case RecoveryReplayTargetKind.Sqs:
    default:
      return RecoveryReplayTargetKind.Sqs;
  }
}
