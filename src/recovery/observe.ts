import {
  ReplayResult,
  type RecoveryMessageRecord,
} from "../shared/recovery";

export interface RecoveryHealth {
  attempted: number;
  succeeded: number;
  failed: number;
  failureRate: number;
  safeToContinue: boolean;
  reason?: string;
}

export function isReplayAttempt(result: ReplayResult | undefined): boolean {
  return (
    result === ReplayResult.Sent ||
    result === ReplayResult.Success ||
    result === ReplayResult.Failed
  );
}

export function observeReplayHealth(
  messages: RecoveryMessageRecord[],
  maxFailureRate: number,
): RecoveryHealth {
  const attempted = messages.filter((message) => isReplayAttempt(message.replayResult));
  const succeeded = attempted.filter(
    (message) => message.replayResult === ReplayResult.Success,
  ).length;
  const failed = attempted.length - succeeded;
  const failureRate = attempted.length === 0 ? 0 : failed / attempted.length;
  const safeToContinue = failureRate <= maxFailureRate;

  return {
    attempted: attempted.length,
    succeeded,
    failed,
    failureRate,
    safeToContinue,
    reason: safeToContinue
      ? undefined
      : `Replay failure rate ${failureRate} exceeded maxFailureRate ${maxFailureRate}`,
  };
}
