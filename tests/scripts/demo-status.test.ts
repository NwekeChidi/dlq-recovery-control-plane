import { formatDemoAwsError } from "../../src/scripts/aws";
import { DEMO_SHIPMENTS } from "../../src/fixtures/shipments";
import {
  formatDemoStatus,
  queuesAreDirty,
  shipmentIdOf,
  waitUntil,
} from "../../src/shared/demo-status";
import { FailureClass, RecoveryAction } from "../../src/shared/failure";
import { RecoveryJobStatus } from "../../src/shared/recovery";
import { ShipmentDispatchStatus } from "../../src/shared/shipments-repo";

describe("demo status helpers", () => {
  test("formats projector-friendly queue depths and dispatch state", () => {
    expect(
      formatDemoStatus({ visible: 0, inFlight: 1 }, { visible: 4, inFlight: 0 }, [
        { shipmentId: "SHP-004", status: ShipmentDispatchStatus.Completed },
      ]),
    ).toBe(
      "ShipmentsQueue: 0 (in-flight: 1)\nShipmentsDLQ:    4\nDispatched:\n  SHP-004  COMPLETED",
    );
  });

  test("formats quarantine and recovery audit rows", () => {
    expect(
      formatDemoStatus({ visible: 0, inFlight: 0 }, { visible: 3, inFlight: 0 }, [], {
        quarantines: [
          {
            messageId: "msg-003",
            shipmentId: "SHP-003",
            failureClass: FailureClass.Poison,
            action: RecoveryAction.Quarantine,
            reason: "do not invent a correction",
          },
        ],
        recoveryJobs: [{ recoveryId: "rec-1", status: RecoveryJobStatus.Started }],
        recoveryMessages: [
          {
            recoveryId: "rec-1",
            messageId: "msg-003",
            shipmentId: "SHP-003",
            failureClass: FailureClass.Poison,
            action: RecoveryAction.Quarantine,
          },
        ],
      }),
    ).toBe(
      [
        "ShipmentsQueue: 0 (in-flight: 0)",
        "ShipmentsDLQ:    3",
        "Quarantine:",
        "  SHP-003  POISON  QUARANTINE",
        "Recovery:",
        "  rec-1  STARTED",
        "    SHP-003  POISON  QUARANTINE",
      ].join("\n"),
    );
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
