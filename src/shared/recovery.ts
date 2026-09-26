import { randomUUID } from "node:crypto";
import { FailureClass, RecoveryAction } from "./failure";

export const DEMO_RECOVERY_BATCH_SIZE = 2;
export const DEMO_RECOVERY_REPLAY_DELAY_SECONDS = 5;
export const DEMO_RECOVERY_MAX_FAILURE_RATE = 0.25;
export const DEMO_RECOVERY_MAX_BATCH_SIZE = 10;

export enum RecoveryJobStatus {
  Started = "STARTED",
  Completed = "COMPLETED",
  Stopped = "STOPPED",
}

export enum ReplayResult {
  Sent = "SENT",
  Success = "SUCCESS",
  Failed = "FAILED",
  NotSent = "NOT_SENT",
}

export enum DownstreamStatus {
  Healthy = "healthy",
  Broken = "broken",
}

export interface QuarantineRecord {
  messageId: string;
  shipmentId?: string;
  originalPayload: unknown;
  failureClass: FailureClass;
  action: RecoveryAction;
  reason: string;
  sourceQueue: string;
  recoveryId: string;
  quarantinedAt: string;
}

export interface RecoveryJobRecord {
  recoveryId: string;
  status: RecoveryJobStatus;
  startedAt: string;
  completedAt?: string;
  batchSize: number;
  maxFailureRate: number;
  replayDelaySeconds: number;
  processedCount: number;
  recoveredCount: number;
  quarantinedCount: number;
  suppressedCount: number;
  failureCount: number;
  stopReason?: string;
}

export interface RecoveryMessageRecord {
  recoveryId: string;
  messageId: string;
  shipmentId?: string;
  failureClass: FailureClass;
  action: RecoveryAction;
  originalPayload: unknown;
  patchedPayload?: unknown;
  patchVersion?: string;
  validationResult?: string;
  replayAttempt?: number;
  replayResult?: ReplayResult;
  reason?: string;
  createdAt: string;
}

export interface RecoveryStore {
  putQuarantine(record: QuarantineRecord): Promise<void>;
  getQuarantine(messageId: string): Promise<QuarantineRecord | undefined>;
  listQuarantines(): Promise<QuarantineRecord[]>;
  putRecoveryJob(job: RecoveryJobRecord): Promise<void>;
  getRecoveryJob(recoveryId: string): Promise<RecoveryJobRecord | undefined>;
  listRecoveryJobs(): Promise<RecoveryJobRecord[]>;
  putRecoveryMessage(record: RecoveryMessageRecord): Promise<void>;
  getRecoveryMessage(
    recoveryId: string,
    messageId: string,
  ): Promise<RecoveryMessageRecord | undefined>;
  listRecoveryMessages(recoveryId?: string): Promise<RecoveryMessageRecord[]>;
  getDownstreamStatus(): Promise<DownstreamStatus>;
  setDownstreamStatus(status: DownstreamStatus): Promise<void>;
  markReplayResult(
    recoveryId: string,
    messageId: string,
    result: ReplayResult.Success | ReplayResult.Failed,
  ): Promise<void>;
  clear(): Promise<void>;
}

export function createStartedRecoveryJob(input: {
  recoveryId: string;
  startedAt?: string;
  batchSize?: number;
  maxFailureRate?: number;
  replayDelaySeconds?: number;
}): RecoveryJobRecord {
  return {
    recoveryId: input.recoveryId,
    status: RecoveryJobStatus.Started,
    startedAt: input.startedAt ?? new Date().toISOString(),
    batchSize: input.batchSize ?? DEMO_RECOVERY_BATCH_SIZE,
    maxFailureRate: input.maxFailureRate ?? DEMO_RECOVERY_MAX_FAILURE_RATE,
    replayDelaySeconds: input.replayDelaySeconds ?? DEMO_RECOVERY_REPLAY_DELAY_SECONDS,
    processedCount: 0,
    recoveredCount: 0,
    quarantinedCount: 0,
    suppressedCount: 0,
    failureCount: 0,
  };
}

export enum RecoveryReplayTargetKind {
  Sqs = "sqs",
  Sns = "sns",
  EventBridge = "eventbridge",
}

export interface RecoveryStartEvent {
  recoveryId?: string;
  batchSize?: number;
  maxFailureRate?: number;
  replayDelaySeconds?: number;
  /** Override the DLQ this run drains (defaults to SHIPMENTS_DLQ_URL). */
  dlqUrl?: string;
  /** Override where authorized replays are published (defaults to sqs). */
  replayTarget?: RecoveryReplayTargetKind;
  /** EventBridge bus for replays when replayTarget is "eventbridge". */
  eventBusName?: string;
  /** SNS topic ARN for replays when replayTarget is "sns". */
  snsTopicArn?: string;
}

export interface RecoveryKnobs {
  batchSize: number;
  maxFailureRate: number;
  replayDelaySeconds: number;
}

export function resolveRecoveryKnobs(event: RecoveryStartEvent = {}): RecoveryKnobs {
  return {
    batchSize: clampInt(event.batchSize, DEMO_RECOVERY_BATCH_SIZE, 1, DEMO_RECOVERY_MAX_BATCH_SIZE),
    maxFailureRate: event.maxFailureRate ?? DEMO_RECOVERY_MAX_FAILURE_RATE,
    replayDelaySeconds: clampInt(
      event.replayDelaySeconds,
      DEMO_RECOVERY_REPLAY_DELAY_SECONDS,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export function completeRecoveryJob(
  job: RecoveryJobRecord,
  counts: {
    processedCount: number;
    quarantinedCount: number;
    suppressedCount: number;
    recoveredCount?: number;
    failureCount?: number;
  },
  completedAt = new Date().toISOString(),
): RecoveryJobRecord {
  return {
    ...job,
    status: RecoveryJobStatus.Completed,
    completedAt,
    processedCount: counts.processedCount,
    quarantinedCount: counts.quarantinedCount,
    suppressedCount: counts.suppressedCount,
    recoveredCount: counts.recoveredCount ?? job.recoveredCount,
    failureCount: counts.failureCount ?? job.failureCount,
  };
}

export function stopRecoveryJob(
  job: RecoveryJobRecord,
  reason: string,
  counts: {
    processedCount: number;
    quarantinedCount: number;
    suppressedCount: number;
    recoveredCount?: number;
    failureCount?: number;
  },
  completedAt = new Date().toISOString(),
): RecoveryJobRecord {
  return {
    ...completeRecoveryJob(job, counts, completedAt),
    status: RecoveryJobStatus.Stopped,
    stopReason: reason,
  };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function createRecoveryId(): string {
  return `REC-${randomUUID()}`;
}
