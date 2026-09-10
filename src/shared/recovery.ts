import { FailureClass, RecoveryAction } from "./failure";

export const DEMO_RECOVERY_BATCH_SIZE = 2;
export const DEMO_RECOVERY_REPLAY_DELAY_SECONDS = 5;
export const DEMO_RECOVERY_MAX_FAILURE_RATE = 0.25;

export enum RecoveryJobStatus {
  Started = "STARTED",
  Completed = "COMPLETED",
  Stopped = "STOPPED",
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
  replayResult?: string;
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
