import {
  shp001Transient,
  shp002LegacyV1,
  shp003Poison,
  shp004AlreadyDispatched,
} from "../../src/fixtures/shipments";
import { processShipment } from "../../src/processor/process-shipment";
import {
  InvalidShipmentError,
  PostDispatchFailure,
  TransientCarrierError,
  UnsupportedSchemaError,
} from "../../src/shared/errors";

describe("processShipment", () => {
  test("SHP-001 throws TransientCarrierError on the initial path", async () => {
    await expect(processShipment(shp001Transient)).rejects.toBeInstanceOf(TransientCarrierError);
  });

  test("SHP-001 succeeds when recovery is authorized", async () => {
    await expect(
      processShipment(shp001Transient, { recoveryId: "REC-42" }),
    ).resolves.toMatchObject({ shipmentId: "SHP-001" });
  });

  test("SHP-002 throws UnsupportedSchemaError", async () => {
    await expect(processShipment(shp002LegacyV1)).rejects.toBeInstanceOf(UnsupportedSchemaError);
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
});
