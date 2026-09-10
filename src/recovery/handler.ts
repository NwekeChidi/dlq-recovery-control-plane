import { SQSClient } from "@aws-sdk/client-sqs";
import type { DurableContext } from "@aws/durable-execution-sdk-js";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { randomUUID } from "node:crypto";
import { deleteDlqMessage, loadDlqBatch, parseDlqBody, type DlqMessage } from "./load";
import { recordRecoveryDecision, triageLoadedMessage } from "./job";
import { isTerminalHold } from "./quarantine";
import { buildReplayEnvelope, replayOutcome, sendReplay, type ReplayEnvelope } from "./replay";
import { RecoveryAction } from "../shared/failure";
import { DynamoRecoveryStore } from "../shared/recovery-repo";
import {
  completeRecoveryJob,
  createStartedRecoveryJob,
  resolveRecoveryKnobs,
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
    const id = (deps.createRecoveryId ?? createRecoveryId)();
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

  const loaded = await context.step("load-batch", async () => deps.loadBatch(knobs.batchSize));

  const decisions = [];
  let recoveredCount = 0;
  for (const message of loaded) {
    const classified = await context.step(`triage-${message.messageId}`, async () =>
      triageLoadedMessage(parseDlqBody(message.body), deps.ledger),
    );
    const recorded = await context.step(`record-${message.messageId}`, async () =>
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
    const sent = await context.step(`replay-${message.messageId}`, async () => {
      const envelope = buildReplayEnvelope({
        recoveryId,
        originalMessageId: message.messageId,
        record: recorded,
      });
      if (!envelope) {
        await deps.store.putRecoveryMessage(replayOutcome(recorded));
        return false;
      }
      await deps.replay(envelope);
      await deps.store.putRecoveryMessage(replayOutcome(recorded));
      return true;
    });
    await context.step(`delete-${message.messageId}`, async () => {
      await deps.deleteMessage(message.receiptHandle);
    });
    decisions.push(recorded);
    if (sent) {
      recoveredCount += 1;
    }
  }

  const summary = summarizeDecisions(recoveryId, decisions, recoveredCount);
  await context.step("complete-job", async () => {
    const job = await deps.store.getRecoveryJob(recoveryId);
    if (!job) {
      throw new Error(`Recovery job ${recoveryId} was not found`);
    }
    await deps.store.putRecoveryJob(
      completeRecoveryJob(
        job,
        {
          processedCount: summary.processedCount,
          quarantinedCount: summary.quarantinedCount,
          suppressedCount: summary.suppressedCount,
          recoveredCount: summary.recoveredCount,
        },
        now(),
      ),
    );
  });

  return summary;
}

function summarizeDecisions(
  recoveryId: string,
  decisions: Array<{ action: RecoveryAction }>,
  recoveredCount: number,
): RecoveryStartResult {
  return {
    recoveryId,
    processedCount: decisions.length,
    quarantinedCount: decisions.filter((decision) => isTerminalHold(decision.action)).length,
    suppressedCount: decisions.filter((decision) => decision.action === RecoveryAction.Skip).length,
    replayCandidateCount: decisions.filter((decision) => decision.action === RecoveryAction.Replay)
      .length,
    patchCandidateCount: decisions.filter((decision) => decision.action === RecoveryAction.Patch)
      .length,
    recoveredCount,
  };
}

function createRecoveryId(): string {
  return `REC-${randomUUID()}`;
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
