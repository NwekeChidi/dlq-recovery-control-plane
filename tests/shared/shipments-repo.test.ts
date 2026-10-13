import {
  ClaimOutcome,
  InMemoryShipmentLedger,
  ShipmentDispatchStatus,
} from "../../src/shared/shipments-repo";

describe("InMemoryShipmentLedger", () => {
  test("first claim succeeds and a second claim cannot take ownership", async () => {
    const ledger = new InMemoryShipmentLedger();
    await expect(ledger.claimShipment("SHP-000")).resolves.toEqual({
      outcome: ClaimOutcome.Claimed,
    });
    await expect(ledger.claimShipment("SHP-000")).resolves.toEqual({
      outcome: ClaimOutcome.InProgress,
    });
  });

  test("a completed shipment stays completed and is not claimed again", async () => {
    const ledger = new InMemoryShipmentLedger();
    await ledger.claimShipment("SHP-004");
    await ledger.completeShipment("SHP-004", "dispatched");
    await expect(ledger.claimShipment("SHP-004")).resolves.toEqual({
      outcome: ClaimOutcome.AlreadyCompleted,
      result: "dispatched",
    });
    await expect(ledger.getShipmentState("SHP-004")).resolves.toMatchObject({
      status: ShipmentDispatchStatus.Completed,
      result: "dispatched",
    });
  });
});
