import { formatDemoAwsError } from "../../src/scripts/aws";
import { DEMO_SHIPMENTS } from "../../src/fixtures/shipments";
import {
  formatDemoStatus,
  labeled,
  queuesAreDirty,
  shipmentIdOf,
  waitUntil,
} from "../../src/shared/demo-status";
import { FailureClass, RecoveryAction } from "../../src/shared/failure";
import { DownstreamStatus, RecoveryJobStatus, ReplayResult } from "../../src/shared/recovery";
import { ShipmentDispatchStatus } from "../../src/shared/shipments-repo";

describe("demo status helpers", () => {
  test("formats projector-friendly queue depths and dispatch state", () => {
    expect(
      formatDemoStatus({ visible: 0, inFlight: 1 }, { visible: 4, inFlight: 0 }, [
        { shipmentId: "SHP-004", status: ShipmentDispatchStatus.Completed },
      ]),
    ).toBe(
      [
        labeled("ShipmentsQueue", "0 (in-flight: 1)"),
        labeled("ShipmentsDLQ", 4),
        "Dispatched:",
        "  SHP-004  COMPLETED",
      ].join("\n"),
    );
  });

  test("formats a completed recovery as a projector summary", () => {
    expect(
      formatDemoStatus({ visible: 0, inFlight: 0 }, { visible: 0, inFlight: 0 }, [], {
        downstreamStatus: DownstreamStatus.Healthy,
        quarantines: [
          {
            messageId: "m-003",
            shipmentId: "SHP-003",
            failureClass: FailureClass.Poison,
            action: RecoveryAction.Quarantine,
            reason: "do not invent a correction",
          },
        ],
        recoveryJobs: [
          {
            recoveryId: "REC-42",
            status: RecoveryJobStatus.Completed,
            startedAt: "2026-09-10T09:00:00.000Z",
          },
        ],
        recoveryMessages: [
          {
            recoveryId: "REC-42",
            messageId: "m-001",
            shipmentId: "SHP-001",
            failureClass: FailureClass.Transient,
            action: RecoveryAction.Replay,
            replayResult: ReplayResult.Success,
          },
          {
            recoveryId: "REC-42",
            messageId: "m-002",
            shipmentId: "SHP-002",
            failureClass: FailureClass.SchemaMismatch,
            action: RecoveryAction.Patch,
            replayResult: ReplayResult.Success,
            patchVersion: "shipment-v1-to-v2",
          },
          {
            recoveryId: "REC-42",
            messageId: "m-003",
            shipmentId: "SHP-003",
            failureClass: FailureClass.Poison,
            action: RecoveryAction.Quarantine,
            replayResult: ReplayResult.NotSent,
          },
          {
            recoveryId: "REC-42",
            messageId: "m-004",
            shipmentId: "SHP-004",
            failureClass: FailureClass.Duplicate,
            action: RecoveryAction.Skip,
            replayResult: ReplayResult.NotSent,
          },
        ],
      }),
    ).toBe(
      [
        labeled("ShipmentsQueue", 0),
        labeled("ShipmentsDLQ", 0),
        labeled("Downstream", "healthy"),
        labeled("Quarantine", 1),
        "",
        labeled("Recovery", "REC-42"),
        labeled("Status", "COMPLETED"),
        labeled("Recovered", 2),
        labeled("Patched", 1),
        labeled("Quarantined", 1),
        labeled("Suppressed", 1),
        labeled("Replay failures", 0),
        "  SHP-001  TRANSIENT  REPLAY  SUCCESS",
        "  SHP-002  SCHEMA_MISMATCH  PATCH  SUCCESS",
        "  SHP-003  POISON  QUARANTINE  NOT_SENT",
        "  SHP-004  DUPLICATE  SKIP  NOT_SENT",
      ].join("\n"),
    );
  });

  test("shows why recovery stopped", () => {
    expect(
      formatDemoStatus({ visible: 0, inFlight: 0 }, { visible: 2, inFlight: 0 }, [], {
        downstreamStatus: DownstreamStatus.Broken,
        quarantines: [],
        recoveryJobs: [
          {
            recoveryId: "REC-stop",
            status: RecoveryJobStatus.Stopped,
            stopReason: "Replay failure rate 1 exceeded maxFailureRate 0.25",
          },
        ],
        recoveryMessages: [
          {
            recoveryId: "REC-stop",
            messageId: "m-001",
            shipmentId: "SHP-001",
            failureClass: FailureClass.Transient,
            action: RecoveryAction.Replay,
            replayResult: ReplayResult.Failed,
          },
        ],
      }),
    ).toContain(labeled("Stop reason", "Replay failure rate 1 exceeded maxFailureRate 0.25"));
  });

  test("warns when either queue still has work", () => {
    expect(queuesAreDirty({ visible: 0, inFlight: 0 }, { visible: 0, inFlight: 0 })).toBe(false);
    expect(queuesAreDirty({ visible: 1, inFlight: 0 }, { visible: 0, inFlight: 0 })).toBe(true);
    expect(queuesAreDirty({ visible: 0, inFlight: 0 }, { visible: 4, inFlight: 0 })).toBe(true);
  });

  test("reads shipment ids from v1 and v2 fixtures", () => {
    expect(DEMO_SHIPMENTS.map(shipmentIdOf)).toEqual([
      "SHP-001",
      "SHP-002",
      "SHP-003",
      "SHP-004",
    ]);
  });

  test("explains missing AWS credentials for demo CLI scripts", () => {
    expect(formatDemoAwsError(new Error("Could not load credentials from any providers"))).toBe(
      "Could not load AWS credentials. Run `aws login` (or configure an AWS profile) and retry.",
    );
  });

  test("waitUntil returns true when the predicate passes", async () => {
    let attempts = 0;
    const ok = await waitUntil(
      async () => {
        attempts += 1;
        return attempts >= 2;
      },
      {
        timeoutMs: 1_000,
        intervalMs: 1,
        sleep: async () => undefined,
      },
    );
    expect(ok).toBe(true);
    expect(attempts).toBe(2);
  });
});
