import type { Context, SQSEvent } from "aws-lambda";
import { handler } from "../../src/processor/handler";
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

function sqsEvent(body: unknown, recoveryId?: string): SQSEvent {
  return {
    Records: [
      {
        messageId: "msg-1",
        receiptHandle: "rh-1",
        body: JSON.stringify(body),
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "0",
          SenderId: "123",
          ApproximateFirstReceiveTimestamp: "0",
        },
        messageAttributes: recoveryId
          ? {
              recoveryId: {
                stringValue: recoveryId,
                dataType: "String",
              },
            }
          : {},
        md5OfBody: "d41d8cd98f00b204e9800998ecf8427e",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:eu-west-1:123456789012:ShipmentsQueue",
        awsRegion: "eu-west-1",
      },
    ],
  };
}

describe("ShipmentProcessor handler", () => {
  test("accepts a valid V2 shipment", async () => {
    await expect(
      handler(
        sqsEvent({
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
  ] as const)("%s fails with %s", async (_id, payload, errorType) => {
    await expect(handler(sqsEvent(payload), {} as Context, () => undefined)).rejects.toBeInstanceOf(
      errorType,
    );
  });
});
