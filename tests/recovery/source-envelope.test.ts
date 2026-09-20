import { parseSourceEnvelope, RecoverySourceType } from "../../src/recovery/source-envelope";

describe("parseSourceEnvelope", () => {
  const original = { shipmentId: "SHP-001", customerId: "CUS-001" };

  test("treats a bare SQS object body as the original event", () => {
    const envelope = parseSourceEnvelope(original);
    expect(envelope.sourceType).toBe(RecoverySourceType.Sqs);
    expect(envelope.originalEvent).toEqual(original);
  });

  test("parses a stringified SQS body", () => {
    const envelope = parseSourceEnvelope(JSON.stringify(original));
    expect(envelope.sourceType).toBe(RecoverySourceType.Sqs);
    expect(envelope.originalEvent).toEqual(original);
  });

  test("unwraps an SNS notification envelope", () => {
    const envelope = parseSourceEnvelope({
      Type: "Notification",
      MessageId: "sns-1",
      TopicArn: "arn:aws:sns:eu-west-1:123:shipments",
      Subject: "shipment.failed",
      Message: JSON.stringify(original),
    });
    expect(envelope.sourceType).toBe(RecoverySourceType.Sns);
    expect(envelope.originalEvent).toEqual(original);
    expect(envelope.sns).toEqual({
      subject: "shipment.failed",
      topicArn: "arn:aws:sns:eu-west-1:123:shipments",
    });
  });

  test("unwraps an EventBridge event to its detail", () => {
    const envelope = parseSourceEnvelope({
      version: "0",
      id: "eb-1",
      "detail-type": "ShipmentFailed",
      source: "fulfilment.shipments",
      resources: ["arn:aws:lambda:eu-west-1:123:function:processor"],
      detail: original,
    });
    expect(envelope.sourceType).toBe(RecoverySourceType.EventBridge);
    expect(envelope.originalEvent).toEqual(original);
    expect(envelope.eventBridge).toEqual({
      source: "fulfilment.shipments",
      detailType: "ShipmentFailed",
      resources: ["arn:aws:lambda:eu-west-1:123:function:processor"],
    });
  });

  test("falls back to SQS for an unparseable string body", () => {
    const envelope = parseSourceEnvelope("not-json");
    expect(envelope.sourceType).toBe(RecoverySourceType.Sqs);
    expect(envelope.originalEvent).toBe("not-json");
  });
});
