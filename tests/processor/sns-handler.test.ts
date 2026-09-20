import type { Context, SNSEvent, SNSMessageAttributes } from "aws-lambda";
import { handler } from "../../src/processor/sns-handler";
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

function snsEvent(message: unknown, attributes: SNSMessageAttributes = {}): SNSEvent {
  return {
    Records: [
      {
        EventSource: "aws:sns",
        EventVersion: "1.0",
        EventSubscriptionArn: "arn:aws:sns:eu-west-1:123456789012:ShipmentTopic:sub",
        Sns: {
          Type: "Notification",
          MessageId: "sns-msg-1",
          TopicArn: "arn:aws:sns:eu-west-1:123456789012:ShipmentTopic",
          Subject: "",
          Message: JSON.stringify(message),
          Timestamp: new Date(0).toISOString(),
          SignatureVersion: "1",
          Signature: "sig",
          SigningCertUrl: "https://sns/cert.pem",
          UnsubscribeUrl: "https://sns/unsubscribe",
          MessageAttributes: attributes,
        },
      },
    ],
  };
}

function replayAttributes(): SNSMessageAttributes {
  return {
    recoveryId: { Type: "String", Value: "REC-1" },
    originalMessageId: { Type: "String", Value: "m-1" },
    replayAttempt: { Type: "String", Value: "1" },
  };
}

describe("ShipmentNotificationProcessor handler", () => {
  test("accepts a valid V2 shipment delivered from the topic", async () => {
    await expect(
      handler(
        snsEvent({
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
      handler(snsEvent(payload), {} as Context, () => undefined),
    ).rejects.toBeInstanceOf(errorType);
  });

  test("a recovery replay carrying provenance attributes clears the transient failure", async () => {
    await expect(
      handler(snsEvent(shp001Transient, replayAttributes()), {} as Context, () => undefined),
    ).resolves.toBeUndefined();
  });
});
