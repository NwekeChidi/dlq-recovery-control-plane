import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import type { SNSClient } from "@aws-sdk/client-sns";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { ReplayEnvelope } from "../../src/recovery/replay";
import {
  EventBridgeReplayTarget,
  SnsReplayTarget,
  SqsReplayTarget,
} from "../../src/recovery/replay-target";
import { RecoverySourceType } from "../../src/recovery/source-envelope";

const envelope: ReplayEnvelope = {
  body: { shipmentId: "SHP-002", schemaVersion: 2 },
  attributes: {
    recoveryId: "REC-1",
    originalMessageId: "m-002",
    replayAttempt: 1,
    patchVersion: "shipment-v1-to-v2",
  },
};

function fakeClient<T>(response: unknown): { client: T; send: jest.Mock } {
  const send = jest.fn().mockResolvedValue(response);
  return { client: { send } as unknown as T, send };
}

describe("SqsReplayTarget", () => {
  test("redrives onto the source queue with recovery attributes", async () => {
    const { client, send } = fakeClient<SQSClient>({ MessageId: "sqs-1" });
    const target = new SqsReplayTarget(client, "https://sqs/queue");

    const id = await target.send(envelope);

    expect(target.kind).toBe(RecoverySourceType.Sqs);
    expect(id).toBe("sqs-1");
    const input = send.mock.calls[0][0].input;
    expect(input.QueueUrl).toBe("https://sqs/queue");
    expect(JSON.parse(input.MessageBody)).toEqual(envelope.body);
    expect(input.MessageAttributes.recoveryId.StringValue).toBe("REC-1");
    expect(input.MessageAttributes.patchVersion.StringValue).toBe("shipment-v1-to-v2");
  });
});

describe("SnsReplayTarget", () => {
  test("publishes to the topic and carries provenance as attributes", async () => {
    const { client, send } = fakeClient<SNSClient>({ MessageId: "sns-1" });
    const target = new SnsReplayTarget(client, "arn:aws:sns:eu-west-1:123:shipments");

    const id = await target.send(envelope);

    expect(target.kind).toBe(RecoverySourceType.Sns);
    expect(id).toBe("sns-1");
    const input = send.mock.calls[0][0].input;
    expect(input.TopicArn).toBe("arn:aws:sns:eu-west-1:123:shipments");
    expect(JSON.parse(input.Message)).toEqual(envelope.body);
    expect(input.MessageAttributes.replayAttempt.StringValue).toBe("1");
  });

  test("throws when SNS returns no MessageId", async () => {
    const { client } = fakeClient<SNSClient>({});
    const target = new SnsReplayTarget(client, "arn:topic");
    await expect(target.send(envelope)).rejects.toThrow("SNS Publish");
  });
});

describe("EventBridgeReplayTarget", () => {
  test("puts the event as detail with embedded recovery provenance and defaults", async () => {
    const { client, send } = fakeClient<EventBridgeClient>({
      FailedEntryCount: 0,
      Entries: [{ EventId: "eb-1" }],
    });
    const target = new EventBridgeReplayTarget(client, { eventBusName: "recovery-bus" });

    const id = await target.send(envelope);

    expect(target.kind).toBe(RecoverySourceType.EventBridge);
    expect(id).toBe("eb-1");
    const entry = send.mock.calls[0][0].input.Entries[0];
    expect(entry.EventBusName).toBe("recovery-bus");
    expect(entry.Source).toBe("taming-dlqs.recovery");
    expect(entry.DetailType).toBe("ShipmentRecoveryReplay");
    const detail = JSON.parse(entry.Detail);
    expect(detail).toMatchObject(envelope.body as Record<string, unknown>);
    expect(detail.__recovery).toEqual({
      recoveryId: "REC-1",
      originalMessageId: "m-002",
      replayAttempt: 1,
      patchVersion: "shipment-v1-to-v2",
    });
  });

  test("throws when EventBridge reports a failed entry", async () => {
    const { client } = fakeClient<EventBridgeClient>({
      FailedEntryCount: 1,
      Entries: [{ ErrorMessage: "throttled" }],
    });
    const target = new EventBridgeReplayTarget(client);
    await expect(target.send(envelope)).rejects.toThrow("throttled");
  });
});
