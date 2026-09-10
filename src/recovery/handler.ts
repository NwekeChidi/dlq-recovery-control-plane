import { SQSClient } from "@aws-sdk/client-sqs";
import type { DurableContext } from "@aws/durable-execution-sdk-js";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { deleteDlqMessage, loadDlqBatch, parseDlqBody, type DlqMessage } from "./load";
import { observeReplayHealth, type RecoveryHealth } from "./observe";
import { recordRecoveryDecision, triageLoadedMessage } from "./job";
import { isTerminalHold } from "./quarantine";
import { buildReplayEnvelope, replayOutcome, sendReplay, type ReplayEnvelope } from "./replay";
import { RecoveryAction } from "../shared/failure";
import { DynamoRecoveryStore } from "../shared/recovery-repo";
import {
  completeRecoveryJob,
  createRecoveryId,
  createStartedRecoveryJob,
  RecoveryJobStatus,
  resolveRecoveryKnobs,
  stopRecoveryJob,
  type RecoveryStartEvent,
  type RecoveryStore,
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
  now?: () => string;
  createRecoveryId?: () => string;
}

interface DecisionCounts {
  processedCount: number;
  quarantinedCount: number;
  suppressedCount: number;
  replayCandidateCount: number;
  patchCandidateCount: number;
}

export function createRecoveryHandler(deps: RecoveryHandlerDeps) {
  return withDurableExecution<RecoveryStartEvent, RecoveryStartResult>(
    async (event, context) => runRecovery(event ?? {}, context, deps),
  );
}

export const handler = withDurableExecution<RecoveryStartEvent, RecoveryStartResult>(
  async (event, context) => runRecovery(event ?? {}, context, depsFromEnv()),
);

export async function runRecovery(
  event: RecoveryStartEvent,
  context: DurableContext,
  deps: RecoveryHandlerDeps,
): Promise<RecoveryStartResult> {
  const knobs = resolveRecoveryKnobs(event);
  const now = deps.now ?? (() => new Date().toISOString());

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
    return id;
  });

  const counts: DecisionCounts = {
    processedCount: 0,
    quarantinedCount: 0,
    suppressedCount: 0,
    replayCandidateCount: 0,
    patchCandidateCount: 0,
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
        triageLoadedMessage(parseDlqBody(message.body), deps.ledger),
      );
      const recorded = await context.step(`record-${batchIndex}-${message.messageId}`, async () =>
        recordRecoveryDecision({
          store: deps.store,
          recoveryId,
          messageId: message.messageId,
          payload: classified.payload,
          shipmentId: classified.shipmentId,
          triage: classified.triage,
          now: now(),
        }),
      );
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
        await deps.store.putRecoveryMessage(replayOutcome(recorded));
        await deps.replay(envelope);
        return true;
      });
      await context.step(`delete-${batchIndex}-${message.messageId}`, async () => {
        await deps.deleteMessage(message.receiptHandle);
      });
      decisions.push(recorded);
      if (sent) {
        replayedThisBatch += 1;
      }
    }

    addDecisionCounts(counts, decisions);

    if (replayedThisBatch > 0 && knobs.replayDelaySeconds > 0) {
      await context.wait(`wait-batch-${batchIndex}`, { seconds: knobs.replayDelaySeconds });
    }

    lastHealth = await context.step(`observe-batch-${batchIndex}`, async () => {
      const messages = await deps.store.listRecoveryMessages(recoveryId);
      return observeReplayHealth(messages, knobs.maxFailureRate);
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

async function requireJob(store: RecoveryStore, recoveryId: string) {
  const job = await store.getRecoveryJob(recoveryId);
  if (!job) {
    throw new Error(`Recovery job ${recoveryId} was not found`);
  }
  return job;
}

function depsFromEnv(): RecoveryHandlerDeps {
  const tableName = process.env.DEMO_LEDGER_TABLE_NAME;
  const dlqUrl = process.env.SHIPMENTS_DLQ_URL;
  const queueUrl = process.env.SHIPMENTS_QUEUE_URL;
  if (!tableName || !dlqUrl || !queueUrl) {
    throw new Error(
      "DEMO_LEDGER_TABLE_NAME, SHIPMENTS_DLQ_URL, and SHIPMENTS_QUEUE_URL are required",
    );
  }
  const sqs = new SQSClient({});
  return {
    loadBatch: (batchSize) => loadDlqBatch(sqs, dlqUrl, batchSize),
    replay: (envelope) => sendReplay(sqs, queueUrl, envelope).then(() => undefined),
    deleteMessage: (receiptHandle) => deleteDlqMessage(sqs, dlqUrl, receiptHandle),
    ledger: DynamoShipmentLedger.fromTableName(tableName),
    store: DynamoRecoveryStore.fromTableName(tableName),
  };
}
