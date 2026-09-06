import { formatDemoAwsError } from "../../src/scripts/aws";
import { DEMO_SHIPMENTS } from "../../src/fixtures/shipments";
import {
  formatDemoStatus,
  queuesAreDirty,
  shipmentIdOf,
  waitUntil,
} from "../../src/shared/demo-status";

describe("demo status helpers", () => {
  test("formats projector-friendly queue depths", () => {
    expect(
      formatDemoStatus({ visible: 0, inFlight: 1 }, { visible: 4, inFlight: 0 }),
    ).toBe("ShipmentsQueue: 0 (in-flight: 1)\nShipmentsDLQ:    4");
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
