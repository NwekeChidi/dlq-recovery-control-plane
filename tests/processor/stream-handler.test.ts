import { marshall } from "@aws-sdk/util-dynamodb";
import type { Context, DynamoDBStreamEvent } from "aws-lambda";
import { handler, streamDelivery, streamFailureEnvelope } from "../../src/processor/stream-handler";
import { parseSourceEnvelope, RecoverySourceType } from "../../src/recovery/source-envelope";
import {
  shp001Transient,
  shp002LegacyV1,
  shp003Poison,
  shp004AlreadyDispatched,
} from "../../src/fixtures/shipments";
import { InvalidShipmentError } from "../../src/shared/errors";

function streamEvent(
  item: object,
  provenance?: { recoveryId: string; originalMessageId: string },
): DynamoDBStreamEvent {
  const shipmentId = "shipmentId" in item ? item.shipmentId : "shipment_id" in item ? item.shipment_id : "unknown";
  return {
    Records: [
      {
        eventID: "ev-1",
        eventName: "INSERT",
        eventVersion: "1.1",
        eventSource: "aws:dynamodb",
        awsRegion: "us-west-2",
        eventSourceARN: "arn:aws:dynamodb:us-west-2:123:table/ShipmentRecords/stream/2026",
        dynamodb: {
          NewImage: marshall(
            {
              pk: shipmentId,
              ...item,
              ...(provenance ? { __recovery: provenance } : {}),
            },
            { removeUndefinedValues: true },
          ) as never,
        },
      },
    ],
  };
}

describe("ShipmentStreamProcessor handler", () => {
  const deadLettered: string[] = [];
  const originalDeadLetter = streamDelivery.deadLetter;

  beforeEach(() => {
    deadLettered.length = 0;
    streamDelivery.deadLetter = async (body: string) => {
      deadLettered.push(body);
    };
  });

  afterEach(() => {
    streamDelivery.deadLetter = originalDeadLetter;
  });

  test("accepts a valid V2 shipment delivered from the stream", async () => {
    await expect(
      handler(
        streamEvent({
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
  ] as const)("%s writes the failed item onto the DLQ once", async (_id, payload) => {
    const event = streamEvent(payload);
    await expect(handler(event, {} as Context, () => undefined)).resolves.toBeUndefined();
    expect(deadLettered).toEqual([streamFailureEnvelope(event.Records[0], payload)]);
    expect(parseSourceEnvelope(deadLettered[0])).toMatchObject({
      sourceType: RecoverySourceType.DynamoDb,
      originalEvent: payload,
    });
  });

  test("a failed recovery replay still throws and is not copied back onto the DLQ", async () => {
    await expect(
      handler(
        streamEvent(shp003Poison, { recoveryId: "REC-1", originalMessageId: "m-1" }),
        {} as Context,
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(InvalidShipmentError);
    expect(deadLettered).toEqual([]);
  });

  test("a dead-letter send failure fails the invocation", async () => {
    streamDelivery.deadLetter = async () => {
      throw new Error("sqs unavailable");
    };
    await expect(
      handler(streamEvent(shp001Transient), {} as Context, () => undefined),
    ).rejects.toThrow("sqs unavailable");
  });

  test("a recovery replay carrying provenance clears the transient failure", async () => {
    await expect(
      handler(
        streamEvent(shp001Transient, { recoveryId: "REC-1", originalMessageId: "m-1" }),
        {} as Context,
        () => undefined,
      ),
    ).resolves.toBeUndefined();
    expect(deadLettered).toEqual([]);
  });

  test("ignores a remove record that has no new image", async () => {
    const event = streamEvent(shp003Poison);
    delete event.Records[0].dynamodb?.NewImage;
    event.Records[0].eventName = "REMOVE";
    await expect(handler(event, {} as Context, () => undefined)).resolves.toBeUndefined();
    expect(deadLettered).toEqual([]);
  });
});
