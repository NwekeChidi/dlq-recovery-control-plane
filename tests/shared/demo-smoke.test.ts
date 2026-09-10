import {
  evaluateHealthySmoke,
  evaluateStoppedSmoke,
  formatTalkSummary,
} from "../../src/shared/demo-smoke";
import { FailureClass, RecoveryAction } from "../../src/shared/failure";
import { RecoveryJobStatus, ReplayResult } from "../../src/shared/recovery";

const healthyMessages = [
  {
    shipmentId: "SHP-001",
    action: RecoveryAction.Replay,
    replayResult: ReplayResult.Success,
    failureClass: FailureClass.Transient,
  },
  {
    shipmentId: "SHP-002",
    action: RecoveryAction.Patch,
    replayResult: ReplayResult.Success,
    failureClass: FailureClass.SchemaMismatch,
  },
  {
    shipmentId: "SHP-003",
    action: RecoveryAction.Quarantine,
    replayResult: ReplayResult.NotSent,
    failureClass: FailureClass.Poison,
  },
  {
    shipmentId: "SHP-004",
    action: RecoveryAction.Skip,
    replayResult: ReplayResult.NotSent,
    failureClass: FailureClass.Duplicate,
  },
];

describe("demo smoke assertions", () => {
  test("healthy recovery matches the conference outcome", () => {
    const snapshot = {
      dlqVisible: 0,
      job: {
        recoveryId: "REC-42",
        status: RecoveryJobStatus.Completed,
        processedCount: 4,
      },
      messages: healthyMessages,
    };

    expect(evaluateHealthySmoke(snapshot)).toEqual([]);
    expect(formatTalkSummary(snapshot)).toBe(
      [
        "Failed messages                   4",
        "Recovered                         2",
        "Patched                           1",
        "Quarantined                       1",
        "Duplicate dispatches prevented    1",
        "Replay failures                   0",
        "Status                            COMPLETED",
      ].join("\n"),
    );
  });

  test("healthy smoke fails when a shipment is missing or the DLQ is not empty", () => {
    expect(
      evaluateHealthySmoke({
        dlqVisible: 1,
        job: { recoveryId: "REC-42", status: RecoveryJobStatus.Completed, processedCount: 3 },
        messages: healthyMessages.slice(0, 3),
      }),
    ).toEqual(["missing SHP-004", "expected 1 duplicate suppressed, got 0", "expected empty DLQ, got 1 visible"]);
  });

  test("circuit-breaker smoke requires STOPPED after replay failures", () => {
    const snapshot = {
      dlqVisible: 2,
      job: {
        recoveryId: "REC-stop",
        status: RecoveryJobStatus.Stopped,
        stopReason: "Replay failure rate 1 exceeded maxFailureRate 0.25",
        processedCount: 2,
      },
      messages: [
        {
          shipmentId: "SHP-001",
          action: RecoveryAction.Replay,
          replayResult: ReplayResult.Failed,
        },
        {
          shipmentId: "SHP-002",
          action: RecoveryAction.Patch,
          replayResult: ReplayResult.Failed,
        },
      ],
    };

    expect(evaluateStoppedSmoke(snapshot)).toEqual([]);
    expect(formatTalkSummary(snapshot)).toContain("Status                            STOPPED");
  });

  test("circuit-breaker smoke fails when recovery completes", () => {
    expect(
      evaluateStoppedSmoke({
        dlqVisible: 0,
        job: { recoveryId: "REC-42", status: RecoveryJobStatus.Completed, processedCount: 4 },
        messages: healthyMessages,
      }),
    ).toEqual([
      "expected status STOPPED, got COMPLETED",
      "expected stop reason to mention failure rate, got none",
      "expected at least one FAILED replay result",
      "expected 0 recovered after STOP, got 2",
    ]);
  });
});
