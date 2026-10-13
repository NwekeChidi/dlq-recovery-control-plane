import type { Context, SNSEvent, SNSMessageAttributes } from "aws-lambda";
import { handler, notificationEnvelope, snsDelivery } from "../../src/processor/sns-handler";
import { parseSourceEnvelope, RecoverySourceType } from "../../src/recovery/source-envelope";
import {
  shp001Transient,
  shp002LegacyV1,
  shp003Poison,
  shp004AlreadyDispatched,
} from "../../src/fixtures/shipments";
import {
  InvalidShipmentError,
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
  const deadLettered: string[] = [];
  const originalDeadLetter = snsDelivery.deadLetter;

  beforeEach(() => {
    deadLettered.length = 0;
    snsDelivery.deadLetter = async (body: string) => {
      deadLettered.push(body);
    };
  });

  afterEach(() => {
    snsDelivery.deadLetter = originalDeadLetter;
  });

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
    ["SHP-001", shp001Transient],
    ["SHP-002", shp002LegacyV1],
    ["SHP-003", shp003Poison],
    ["SHP-004", shp004AlreadyDispatched],
  ] as const)("%s dead-letters the first delivery as an SNS notification", async (_id, payload) => {
    const event = snsEvent(payload);
    await expect(handler(event, {} as Context, () => undefined)).resolves.toBeUndefined();
    expect(deadLettered).toEqual([notificationEnvelope(event.Records[0])]);
    expect(parseSourceEnvelope(deadLettered[0])).toMatchObject({
      sourceType: RecoverySourceType.Sns,
      originalEvent: payload,
      sns: { topicArn: event.Records[0].Sns.TopicArn },
    });
  });

  test("a failed recovery replay still throws and is not copied back onto the DLQ", async () => {
    await expect(
      handler(snsEvent(shp003Poison, replayAttributes()), {} as Context, () => undefined),
    ).rejects.toBeInstanceOf(InvalidShipmentError);
    expect(deadLettered).toEqual([]);
  });

  test("a dead-letter send failure fails the invocation", async () => {
    snsDelivery.deadLetter = async () => {
      throw new Error("sqs unavailable");
    };
    await expect(
      handler(snsEvent(shp001Transient), {} as Context, () => undefined),
    ).rejects.toThrow("sqs unavailable");
  });

  test("a recovery replay carrying provenance attributes clears the transient failure", async () => {
    await expect(
      handler(snsEvent(shp001Transient, replayAttributes()), {} as Context, () => undefined),
    ).resolves.toBeUndefined();
  });
});
