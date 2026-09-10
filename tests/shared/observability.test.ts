import {
  RECOVERY_METRIC_NAMESPACE,
  RecoveryLogEvent,
  RecoveryMetricName,
  formatEmbeddedMetrics,
  formatRecoveryLog,
  recoveryLogRecord,
  recoveryMetricsSnapshot,
} from "../../src/shared/observability";
import { FailureClass, RecoveryAction } from "../../src/shared/failure";
import { RecoveryJobStatus, ReplayResult } from "../../src/shared/recovery";

describe("structured recovery records", () => {
  test("JSON logs include correlation fields and omit empty ones", () => {
    const line = formatRecoveryLog(
      recoveryLogRecord({
        event: RecoveryLogEvent.MessageReplayed,
        recoveryId: "REC-42",
        messageId: "m-001",
        shipmentId: "SHP-001",
        failureClass: FailureClass.Transient,
        action: RecoveryAction.Replay,
        replayAttempt: 1,
        replayResult: ReplayResult.Sent,
        patchVersion: undefined,
      }),
    );

    expect(JSON.parse(line)).toEqual({
      event: "MessageReplayed",
      recoveryId: "REC-42",
      messageId: "m-001",
      shipmentId: "SHP-001",
      failureClass: "TRANSIENT",
      action: "REPLAY",
      replayAttempt: 1,
      replayResult: "SENT",
    });
    expect(line).not.toContain("patchVersion");
  });

  test("job completion metrics cover the conference counters", () => {
    const snapshot = recoveryMetricsSnapshot({
      triaged: 4,
      patched: 1,
      replayed: 2,
      recovered: 2,
      quarantined: 1,
      suppressed: 1,
      failureRate: 0,
      stopped: false,
    });

    expect(snapshot).toEqual({
      RecoveryStarted: 1,
      MessagesTriaged: 4,
      MessagesPatched: 1,
      MessagesReplayed: 2,
      MessagesRecovered: 2,
      MessagesQuarantined: 1,
      DuplicateDispatchSuppressed: 1,
      ReplayFailureRate: 0,
      RecoveryStopped: 0,
    });

    const emf = JSON.parse(formatEmbeddedMetrics(snapshot, "REC-42", 1_000));
    expect(emf._aws.CloudWatchMetrics[0].Namespace).toBe(RECOVERY_METRIC_NAMESPACE);
    expect(emf.RecoveryId).toBe("REC-42");
    expect(emf._aws.CloudWatchMetrics[0].Metrics.map((metric: { Name: string }) => metric.Name)).toEqual(
      Object.values(RecoveryMetricName),
    );
    expect(emf.RecoveryStopped).toBe(0);
    expect(emf.ReplayFailureRate).toBe(0);
  });

  test("stopped recovery emits RecoveryStopped and the observed failure rate", () => {
    const snapshot = recoveryMetricsSnapshot({
      triaged: 2,
      patched: 0,
      replayed: 2,
      recovered: 0,
      quarantined: 0,
      suppressed: 0,
      failureRate: 1,
      stopped: true,
    });
    expect(snapshot.RecoveryStopped).toBe(1);
    expect(snapshot.ReplayFailureRate).toBe(1);

    expect(
      JSON.parse(
        formatRecoveryLog({
          event: RecoveryLogEvent.RecoveryStopped,
          recoveryId: "REC-42",
          reason: "Replay failure rate 1 exceeded maxFailureRate 0.25",
          failureRate: 1,
          status: RecoveryJobStatus.Stopped,
        }),
      ),
    ).toMatchObject({
      event: "RecoveryStopped",
      recoveryId: "REC-42",
      failureRate: 1,
      status: "STOPPED",
    });
  });
});
