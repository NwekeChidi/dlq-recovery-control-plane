import { observeReplayHealth } from "../../src/recovery/observe";
import { FailureClass, RecoveryAction } from "../../src/shared/failure";
import { ReplayResult, type RecoveryMessageRecord } from "../../src/shared/recovery";

function message(
  messageId: string,
  replayResult: ReplayResult,
): RecoveryMessageRecord {
  return {
    recoveryId: "REC-1",
    messageId,
    failureClass: FailureClass.Transient,
    action: RecoveryAction.Replay,
    originalPayload: { shipmentId: "SHP-001" },
    replayResult,
    createdAt: "2026-09-10T08:00:00.000Z",
  };
}

describe("observeReplayHealth", () => {
  test("0% failure is safe to continue", () => {
    expect(
      observeReplayHealth(
        [message("m-001", ReplayResult.Success), message("m-002", ReplayResult.Success)],
        0.25,
      ),
    ).toEqual({
      attempted: 2,
      succeeded: 2,
      failed: 0,
      failureRate: 0,
      safeToContinue: true,
    });
  });

  test("failure rate at the threshold continues", () => {
    expect(
      observeReplayHealth(
        [
          message("m-001", ReplayResult.Success),
          message("m-002", ReplayResult.Success),
          message("m-003", ReplayResult.Success),
          message("m-004", ReplayResult.Failed),
        ],
        0.25,
      ),
    ).toEqual({
      attempted: 4,
      succeeded: 3,
      failed: 1,
      failureRate: 0.25,
      safeToContinue: true,
    });
  });

  test("failure rate above the limit stops recovery", () => {
    expect(
      observeReplayHealth(
        [message("m-001", ReplayResult.Success), message("m-002", ReplayResult.Failed)],
        0.25,
      ),
    ).toEqual({
      attempted: 2,
      succeeded: 1,
      failed: 1,
      failureRate: 0.5,
      safeToContinue: false,
      reason: "Replay failure rate 0.5 exceeded maxFailureRate 0.25",
    });
  });

  test("unacknowledged SENT results count as failed after the observation window", () => {
    expect(observeReplayHealth([message("m-001", ReplayResult.Sent)], 0.25)).toMatchObject({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      failureRate: 1,
      safeToContinue: false,
    });
  });

  test("no replay attempts are safe to continue", () => {
    expect(
      observeReplayHealth(
        [
          {
            ...message("m-003", ReplayResult.NotSent),
            failureClass: FailureClass.Poison,
            action: RecoveryAction.Quarantine,
          },
        ],
        0.25,
      ),
    ).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      failureRate: 0,
      safeToContinue: true,
    });
  });
});
