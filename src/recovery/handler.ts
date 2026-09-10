import { SQSClient } from "@aws-sdk/client-sqs";
import type { DurableContext } from "@aws/durable-execution-sdk-js";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { randomUUID } from "node:crypto";
import { loadDlqBatch, parseDlqBody, type DlqMessage } from "./load";
import { recordRecoveryDecision, triageLoadedMessage } from "./job";
import { isTerminalHold } from "./quarantine";
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
}

export interface RecoveryHandlerDeps {
  loadBatch: (batchSize: number) => Promise<DlqMessage[]>;
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
    decisions.push(recorded);
  }

  const summary = summarizeDecisions(recoveryId, decisions);
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
  };
}

function createRecoveryId(): string {
  return `REC-${randomUUID()}`;
}

function depsFromEnv(): RecoveryHandlerDeps {
  const tableName = process.env.DEMO_LEDGER_TABLE_NAME;
  const dlqUrl = process.env.SHIPMENTS_DLQ_URL;
  if (!tableName || !dlqUrl) {
    throw new Error("DEMO_LEDGER_TABLE_NAME and SHIPMENTS_DLQ_URL are required");
  }
  const sqs = new SQSClient({});
  return {
    loadBatch: (batchSize) => loadDlqBatch(sqs, dlqUrl, batchSize),
    ledger: DynamoShipmentLedger.fromTableName(tableName),
    store: DynamoRecoveryStore.fromTableName(tableName),
  };
}
