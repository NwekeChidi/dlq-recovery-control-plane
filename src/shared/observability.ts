import type { FailureClass, RecoveryAction } from "./failure";
import type { RecoveryJobStatus, ReplayResult } from "./recovery";

export const RECOVERY_METRIC_NAMESPACE = "TamingDlqs/Recovery";

export enum RecoveryLogEvent {
  RecoveryStarted = "RecoveryStarted",
  MessageTriaged = "MessageTriaged",
  MessagePatched = "MessagePatched",
  MessageReplayed = "MessageReplayed",
  MessageRecovered = "MessageRecovered",
  MessageQuarantined = "MessageQuarantined",
  DuplicateDispatchSuppressed = "DuplicateDispatchSuppressed",
  RecoveryObserved = "RecoveryObserved",
  RecoveryStopped = "RecoveryStopped",
  RecoveryCompleted = "RecoveryCompleted",
  ReplayResult = "ReplayResult",
}

export enum RecoveryMetricName {
  RecoveryStarted = "RecoveryStarted",
  MessagesTriaged = "MessagesTriaged",
  MessagesPatched = "MessagesPatched",
  MessagesReplayed = "MessagesReplayed",
  MessagesRecovered = "MessagesRecovered",
  MessagesQuarantined = "MessagesQuarantined",
  DuplicateDispatchSuppressed = "DuplicateDispatchSuppressed",
  ReplayFailureRate = "ReplayFailureRate",
  RecoveryStopped = "RecoveryStopped",
}

export interface RecoveryLogRecord {
  event: RecoveryLogEvent;
  recoveryId: string;
  messageId?: string;
  shipmentId?: string;
  failureClass?: FailureClass;
  action?: RecoveryAction;
  patchVersion?: string;
  replayAttempt?: number;
  replayResult?: ReplayResult;
  reason?: string;
  failureRate?: number;
  attempted?: number;
  succeeded?: number;
  failed?: number;
  safeToContinue?: boolean;
  status?: RecoveryJobStatus;
}

export interface RecoveryMetricsSnapshot {
  RecoveryStarted: number;
  MessagesTriaged: number;
  MessagesPatched: number;
  MessagesReplayed: number;
  MessagesRecovered: number;
  MessagesQuarantined: number;
  DuplicateDispatchSuppressed: number;
  ReplayFailureRate: number;
  RecoveryStopped: number;
}

export function recoveryLogRecord(record: RecoveryLogRecord): RecoveryLogRecord {
  return omitUndefined(record);
}

export function formatRecoveryLog(record: RecoveryLogRecord): string {
  return JSON.stringify(recoveryLogRecord(record));
}

export function writeRecoveryLog(
  record: RecoveryLogRecord,
  write: (line: string) => void = console.log,
): void {
  write(formatRecoveryLog(record));
}

export function recoveryMetricsSnapshot(input: {
  triaged: number;
  patched: number;
  replayed: number;
  recovered: number;
  quarantined: number;
  suppressed: number;
  failureRate: number;
  stopped: boolean;
}): RecoveryMetricsSnapshot {
  return {
    RecoveryStarted: 1,
    MessagesTriaged: input.triaged,
    MessagesPatched: input.patched,
    MessagesReplayed: input.replayed,
    MessagesRecovered: input.recovered,
    MessagesQuarantined: input.quarantined,
    DuplicateDispatchSuppressed: input.suppressed,
    ReplayFailureRate: input.failureRate,
    RecoveryStopped: input.stopped ? 1 : 0,
  };
}

export function formatEmbeddedMetrics(
  snapshot: Partial<RecoveryMetricsSnapshot>,
  recoveryId: string,
  timestamp = Date.now(),
): string {
  const metrics = Object.entries(snapshot).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );
  return JSON.stringify({
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Namespace: RECOVERY_METRIC_NAMESPACE,
          Dimensions: [["RecoveryId"]],
          Metrics: metrics.map(([name]) => ({
            Name: name,
            Unit: name === RecoveryMetricName.ReplayFailureRate ? "None" : "Count",
          })),
        },
      ],
    },
    RecoveryId: recoveryId,
    ...Object.fromEntries(metrics),
  });
}

export function writeRecoveryMetrics(
  snapshot: Partial<RecoveryMetricsSnapshot>,
  recoveryId: string,
  write: (line: string) => void = console.log,
): void {
  write(formatEmbeddedMetrics(snapshot, recoveryId));
}

function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}
