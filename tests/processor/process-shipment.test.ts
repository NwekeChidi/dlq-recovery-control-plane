import {
  shp001Transient,
  shp002LegacyV1,
  shp003Poison,
  shp004AlreadyDispatched,
} from "../../src/fixtures/shipments";
import { processShipment } from "../../src/processor/process-shipment";
import { migrateShipmentV1ToV2 } from "../../src/recovery/patch";
import {
  InvalidShipmentError,
  PostDispatchFailure,
  TransientCarrierError,
  UnsupportedSchemaError,
} from "../../src/shared/errors";
import { InMemoryShipmentLedger, ShipmentDispatchStatus } from "../../src/shared/shipments-repo";

describe("processShipment", () => {
  test("SHP-001 throws TransientCarrierError on the initial path", async () => {
    await expect(processShipment(shp001Transient)).rejects.toBeInstanceOf(TransientCarrierError);
  });

  test("SHP-001 succeeds when recovery is authorized", async () => {
    await expect(
      processShipment(shp001Transient, { recoveryId: "REC-42" }),
    ).resolves.toMatchObject({ shipmentId: "SHP-001" });
  });

  test("authorized replay fails when downstream is broken, without dispatching", async () => {
    const dispatched: string[] = [];
    await expect(
      processShipment(shp001Transient, {
        recoveryId: "REC-42",
        downstreamBroken: true,
        onDispatch: (shipment) => dispatched.push(shipment.shipmentId),
      }),
    ).rejects.toBeInstanceOf(TransientCarrierError);
    expect(dispatched).toEqual([]);
  });

  test("SHP-002 throws UnsupportedSchemaError", async () => {
    await expect(processShipment(shp002LegacyV1)).rejects.toBeInstanceOf(UnsupportedSchemaError);
  });

  test("a patched SHP-002 v2 payload dispatches when recovery is authorized", async () => {
    const dispatched: string[] = [];
    const patch = migrateShipmentV1ToV2(shp002LegacyV1);
    await expect(
      processShipment(patch.patchedPayload, {
        recoveryId: "REC-42",
        onDispatch: (shipment) => dispatched.push(shipment.shipmentId),
      }),
    ).resolves.toMatchObject({ shipmentId: "SHP-002" });
    expect(dispatched).toEqual(["SHP-002"]);
  });

  test("SHP-003 throws InvalidShipmentError", async () => {
    await expect(processShipment(shp003Poison)).rejects.toBeInstanceOf(InvalidShipmentError);
  });

  test("SHP-004 throws PostDispatchFailure after simulated dispatch", async () => {
    await expect(processShipment(shp004AlreadyDispatched)).rejects.toBeInstanceOf(
      PostDispatchFailure,
    );
  });

  test("a valid V2 shipment with no failure scenario succeeds", async () => {
    await expect(
      processShipment({
        shipmentId: "SHP-000",
        customerId: "CUS-000",
        warehouseId: "LON-01",
        service: "STANDARD",
        destinationCountry: "GB",
        schemaVersion: 2,
      }),
    ).resolves.toMatchObject({ shipmentId: "SHP-000" });
  });

  test("SHP-004 records completion then does not dispatch twice", async () => {
    const ledger = new InMemoryShipmentLedger();
    const dispatched: string[] = [];

    await expect(
      processShipment(shp004AlreadyDispatched, {
        ledger,
        onDispatch: (shipment) => dispatched.push(shipment.shipmentId),
      }),
    ).rejects.toBeInstanceOf(PostDispatchFailure);

    expect(dispatched).toEqual(["SHP-004"]);
    await expect(ledger.getShipmentState("SHP-004")).resolves.toMatchObject({
      status: ShipmentDispatchStatus.Completed,
    });

    await expect(
      processShipment(shp004AlreadyDispatched, {
        ledger,
        onDispatch: (shipment) => dispatched.push(shipment.shipmentId),
      }),
    ).resolves.toMatchObject({ shipmentId: "SHP-004" });

    expect(dispatched).toEqual(["SHP-004"]);
  });
});
