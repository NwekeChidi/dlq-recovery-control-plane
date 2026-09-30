import type { Context, EventBridgeEvent } from "aws-lambda";
import { eventBridgeDelivery, handler } from "../../src/processor/eventbridge-handler";
import { parseSourceEnvelope, RecoverySourceType } from "../../src/recovery/source-envelope";
import {
  shp001Transient,
  shp002LegacyV1,
  shp003Poison,
  shp004AlreadyDispatched,
} from "../../src/fixtures/shipments";
import { InvalidShipmentError } from "../../src/shared/errors";

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
  const deadLettered: string[] = [];
  const originalDeadLetter = eventBridgeDelivery.deadLetter;

  beforeEach(() => {
    deadLettered.length = 0;
    eventBridgeDelivery.deadLetter = async (body) => {
      deadLettered.push(body);
    };
  });

  afterEach(() => {
    eventBridgeDelivery.deadLetter = originalDeadLetter;
  });

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
    expect(deadLettered).toEqual([]);
  });

  test.each([
    ["SHP-001", shp001Transient],
    ["SHP-002", shp002LegacyV1],
    ["SHP-003", shp003Poison],
    ["SHP-004", shp004AlreadyDispatched],
  ] as const)("%s writes the failed event onto the DLQ once", async (_id, payload) => {
    const event = busEvent(payload);
    await expect(handler(event, {} as Context, () => undefined)).resolves.toBeUndefined();
    expect(deadLettered).toEqual([JSON.stringify(event)]);
    const envelope = parseSourceEnvelope(deadLettered[0]);
    expect(envelope.sourceType).toBe(RecoverySourceType.EventBridge);
    expect(envelope.originalEvent).toEqual(payload);
  });

  test("a failed recovery replay still throws and is not copied back onto the DLQ", async () => {
    await expect(
      handler(replayEvent(shp003Poison), {} as Context, () => undefined),
    ).rejects.toBeInstanceOf(InvalidShipmentError);
    expect(deadLettered).toEqual([]);
  });

  test("a DLQ write failure fails the invocation", async () => {
    eventBridgeDelivery.deadLetter = async () => {
      throw new Error("sqs unavailable");
    };
    await expect(
      handler(busEvent(shp001Transient), {} as Context, () => undefined),
    ).rejects.toThrow("sqs unavailable");
  });

  test("a recovery replay carrying provenance clears the transient failure", async () => {
    await expect(
      handler(replayEvent(shp001Transient), {} as Context, () => undefined),
    ).resolves.toBeUndefined();
  });
});
