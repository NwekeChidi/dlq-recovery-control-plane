import type { Context, SQSEvent } from "aws-lambda";
import { handler } from "../../src/processor/handler";

function sqsEvent(body: string): SQSEvent {
  return {
    Records: [
      {
        messageId: "msg-1",
        receiptHandle: "rh-1",
        body,
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "0",
          SenderId: "123",
          ApproximateFirstReceiveTimestamp: "0",
        },
        messageAttributes: {},
        md5OfBody: "d41d8cd98f00b204e9800998ecf8427e",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:eu-west-1:123456789012:ShipmentsQueue",
        awsRegion: "eu-west-1",
      },
    ],
  };
}

describe("ShipmentProcessor handler", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  test("accepts a valid placeholder event", async () => {
    const event = sqsEvent(
      JSON.stringify({
        shipmentId: "SHP-000",
        customerId: "CUS-000",
        warehouseId: "LON-01",
        service: "STANDARD",
        destinationCountry: "GB",
        schemaVersion: 2,
      }),
    );

    await expect(handler(event, {} as Context, () => undefined)).resolves.toBeUndefined();
  });
});
