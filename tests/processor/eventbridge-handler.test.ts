import type { Context, EventBridgeEvent } from "aws-lambda";
import { handler } from "../../src/processor/eventbridge-handler";
import {
  shp001Transient,
  shp002LegacyV1,
  shp003Poison,
  shp004AlreadyDispatched,
} from "../../src/fixtures/shipments";
import {
  InvalidShipmentError,
  PostDispatchFailure,
  TransientCarrierError,
  UnsupportedSchemaError,
} from "../../src/shared/errors";

function busEvent(detail: unknown): EventBridgeEvent<string, unknown> {
  return {
    version: "0",
    id: "evt-1",
    account: "123456789012",
    time: new Date(0).toISOString(),
    region: "eu-west-1",
    resources: [],
    source: "fulfilment.shipments",
    "detail-type": "ShipmentRequested",
    detail,
  };
}

function replayEvent(detail: object): EventBridgeEvent<string, unknown> {
  return {
    ...busEvent({
      ...detail,
      __recovery: { recoveryId: "REC-1", originalMessageId: "m-1", replayAttempt: 1 },
    }),
    source: "taming-dlqs.recovery",
    "detail-type": "ShipmentRecoveryReplay",
  };
}

describe("ShipmentEventProcessor handler", () => {
  test("accepts a valid V2 shipment delivered on the bus", async () => {
    await expect(
      handler(
        busEvent({
          shipmentId: "SHP-000",
          customerId: "CUS-000",
          warehouseId: "LON-01",
          service: "STANDARD",
          destinationCountry: "GB",
          schemaVersion: 2,
        }),
        {} as Context,
        () => undefined,
      ),
    ).resolves.toBeUndefined();
  });

  test.each([
    ["SHP-001", shp001Transient, TransientCarrierError],
    ["SHP-002", shp002LegacyV1, UnsupportedSchemaError],
    ["SHP-003", shp003Poison, InvalidShipmentError],
    ["SHP-004", shp004AlreadyDispatched, PostDispatchFailure],
  ] as const)("%s fails on first delivery with %s", async (_id, payload, errorType) => {
    await expect(
      handler(busEvent(payload), {} as Context, () => undefined),
    ).rejects.toBeInstanceOf(errorType);
  });

  test("a recovery replay carrying provenance clears the transient failure", async () => {
    await expect(
      handler(replayEvent(shp001Transient), {} as Context, () => undefined),
    ).resolves.toBeUndefined();
  });
});
