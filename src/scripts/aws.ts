import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import {
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { DEMO_SHIPMENTS } from "../fixtures/shipments";
import {
  DEMO_STACK_NAME,
  DLQ_URL_OUTPUT,
  EVENT_BUS_NAME_OUTPUT,
  EVENT_DLQ_URL_OUTPUT,
  LEDGER_TABLE_OUTPUT,
  QUEUE_URL_OUTPUT,
  RECOVERY_ALIAS_OUTPUT,
  SHIPMENT_EVENT_DETAIL_TYPE,
  SHIPMENT_EVENT_SOURCE,
  SHIPMENT_RECORDS_TABLE_OUTPUT,
  SNS_DLQ_URL_OUTPUT,
  SNS_TOPIC_ARN_OUTPUT,
  STREAM_DLQ_URL_OUTPUT,
  STREAM_PROCESSOR_ARN_OUTPUT,
} from "../shared/demo";
import { shipmentIdOf, type QueueDepth } from "../shared/demo-status";
import {
  DEMO_RECOVERY_BATCH_SIZE,
  DEMO_RECOVERY_MAX_FAILURE_RATE,
  DEMO_RECOVERY_REPLAY_DELAY_SECONDS,
  RecoveryReplayTargetKind,
  createRecoveryId,
  type RecoveryStartEvent,
} from "../shared/recovery";
import { DynamoRecoveryStore } from "../shared/recovery-repo";
import { DynamoShipmentLedger } from "../shared/shipments-repo";

export interface DemoQueueUrls {
  queueUrl: string;
  dlqUrl: string;
}

const sqs = new SQSClient({});
const cloudFormation = new CloudFormationClient({});
const lambda = new LambdaClient({});
const eventBridge = new EventBridgeClient({});
const sns = new SNSClient({});
const shipmentRecords = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export function formatDemoAwsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/could not load credentials from any providers/i.test(message)) {
    return "Could not load AWS credentials. Run `aws login` (or configure an AWS profile) and retry.";
  }
  return message;
}

export async function resolveDemoQueueUrls(): Promise<DemoQueueUrls> {
  const fromEnv = {
    queueUrl: process.env.SHIPMENTS_QUEUE_URL,
    dlqUrl: process.env.SHIPMENTS_DLQ_URL,
  };

  if (fromEnv.queueUrl && fromEnv.dlqUrl) {
    return { queueUrl: fromEnv.queueUrl, dlqUrl: fromEnv.dlqUrl };
  }

  const outputs = await stackOutputs();
  const queueUrl = outputs[QUEUE_URL_OUTPUT];
  const dlqUrl = outputs[DLQ_URL_OUTPUT];
  if (!queueUrl || !dlqUrl) {
    throw new Error(
      `Stack is missing ${QUEUE_URL_OUTPUT} / ${DLQ_URL_OUTPUT}. Deploy first, or set SHIPMENTS_QUEUE_URL and SHIPMENTS_DLQ_URL.`,
    );
  }

  return { queueUrl, dlqUrl };
}

export async function resolveDemoTableName(): Promise<string> {
  const tableName =
    process.env.DEMO_LEDGER_TABLE_NAME ?? (await stackOutputs())[LEDGER_TABLE_OUTPUT];
  if (!tableName) {
    throw new Error(`Missing ${LEDGER_TABLE_OUTPUT}. Deploy first, or set DEMO_LEDGER_TABLE_NAME.`);
  }
  return tableName;
}

export async function resolveDemoLedger(): Promise<DynamoShipmentLedger> {
  return DynamoShipmentLedger.fromTableName(await resolveDemoTableName());
}

export async function resolveDemoRecoveryStore(): Promise<DynamoRecoveryStore> {
  return DynamoRecoveryStore.fromTableName(await resolveDemoTableName());
}

export async function resolveRecoveryAliasArn(): Promise<string> {
  const fromEnv = process.env.RECOVERY_FUNCTION_ARN;
  if (fromEnv) {
    return fromEnv;
  }
  const aliasArn = (await stackOutputs())[RECOVERY_ALIAS_OUTPUT];
  if (!aliasArn) {
    throw new Error(
      `Missing ${RECOVERY_ALIAS_OUTPUT}. Deploy first, or set RECOVERY_FUNCTION_ARN to the live alias ARN.`,
    );
  }
  return aliasArn;
}

export async function resolveEventBusName(): Promise<string> {
  const fromEnv = process.env.RECOVERY_EVENT_BUS_NAME;
  if (fromEnv) {
    return fromEnv;
  }
  const busName = (await stackOutputs())[EVENT_BUS_NAME_OUTPUT];
  if (!busName) {
    throw new Error(
      `Missing ${EVENT_BUS_NAME_OUTPUT}. Deploy first, or set RECOVERY_EVENT_BUS_NAME.`,
    );
  }
  return busName;
}

export async function resolveEventDlqUrl(): Promise<string> {
  const fromEnv = process.env.SHIPMENT_EVENTS_DLQ_URL;
  if (fromEnv) {
    return fromEnv;
  }
  const dlqUrl = (await stackOutputs())[EVENT_DLQ_URL_OUTPUT];
  if (!dlqUrl) {
    throw new Error(
      `Missing ${EVENT_DLQ_URL_OUTPUT}. Deploy first, or set SHIPMENT_EVENTS_DLQ_URL.`,
    );
  }
  return dlqUrl;
}

export async function resolveSnsTopicArn(): Promise<string> {
  const fromEnv = process.env.RECOVERY_SNS_TOPIC_ARN;
  if (fromEnv) {
    return fromEnv;
  }
  const topicArn = (await stackOutputs())[SNS_TOPIC_ARN_OUTPUT];
  if (!topicArn) {
    throw new Error(
      `Missing ${SNS_TOPIC_ARN_OUTPUT}. Deploy first, or set RECOVERY_SNS_TOPIC_ARN.`,
    );
  }
  return topicArn;
}

export async function resolveShipmentRecordsTableName(): Promise<string> {
  const fromEnv = process.env.SHIPMENT_RECORDS_TABLE_NAME;
  if (fromEnv) {
    return fromEnv;
  }
  const tableName = (await stackOutputs())[SHIPMENT_RECORDS_TABLE_OUTPUT];
  if (!tableName) {
    throw new Error(
      `Missing ${SHIPMENT_RECORDS_TABLE_OUTPUT}. Deploy first, or set SHIPMENT_RECORDS_TABLE_NAME.`,
    );
  }
  return tableName;
}

export async function resolveStreamProcessorArn(): Promise<string> {
  const fromEnv = process.env.SHIPMENT_STREAM_PROCESSOR_ARN;
  if (fromEnv) {
    return fromEnv;
  }
  const functionArn = (await stackOutputs())[STREAM_PROCESSOR_ARN_OUTPUT];
  if (!functionArn) {
    throw new Error(
      `Missing ${STREAM_PROCESSOR_ARN_OUTPUT}. Deploy first, or set SHIPMENT_STREAM_PROCESSOR_ARN.`,
    );
  }
  return functionArn;
}

export async function resolveStreamDlqUrl(): Promise<string> {
  const fromEnv = process.env.SHIPMENT_STREAM_DLQ_URL;
  if (fromEnv) {
    return fromEnv;
  }
  const dlqUrl = (await stackOutputs())[STREAM_DLQ_URL_OUTPUT];
  if (!dlqUrl) {
    throw new Error(
      `Missing ${STREAM_DLQ_URL_OUTPUT}. Deploy first, or set SHIPMENT_STREAM_DLQ_URL.`,
    );
  }
  return dlqUrl;
}

export async function resolveSnsDlqUrl(): Promise<string> {
  const fromEnv = process.env.SHIPMENT_NOTIFICATIONS_DLQ_URL;
  if (fromEnv) {
    return fromEnv;
  }
  const dlqUrl = (await stackOutputs())[SNS_DLQ_URL_OUTPUT];
  if (!dlqUrl) {
    throw new Error(
      `Missing ${SNS_DLQ_URL_OUTPUT}. Deploy first, or set SHIPMENT_NOTIFICATIONS_DLQ_URL.`,
    );
  }
  return dlqUrl;
}

async function stackOutputs(): Promise<Record<string, string>> {
  const stackName = process.env.DEMO_STACK_NAME ?? DEMO_STACK_NAME;
  const result = await cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = result.Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(
    outputs.flatMap((output) =>
      output.OutputKey && output.OutputValue ? [[output.OutputKey, output.OutputValue]] : [],
    ),
  );
}

export async function streamDlqVisible(): Promise<number> {
  return (await getQueueDepth(await resolveStreamDlqUrl())).visible;
}

export async function getQueueDepth(queueUrl: string): Promise<QueueDepth> {
  const result = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  const attributes = result.Attributes ?? {};
  return {
    visible: Number(attributes.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

export interface RecoveryInvokeOptions {
  /** Which failure path to recover. Defaults to the SQS-triggered Lambda path. */
  path?: RecoveryReplayTargetKind;
}

export async function invokeDemoRecovery(options: RecoveryInvokeOptions = {}): Promise<string> {
  const functionArn = await resolveRecoveryAliasArn();
  const recoveryId = createRecoveryId();
  const event: RecoveryStartEvent = {
    recoveryId,
    batchSize: DEMO_RECOVERY_BATCH_SIZE,
    maxFailureRate: DEMO_RECOVERY_MAX_FAILURE_RATE,
    replayDelaySeconds: DEMO_RECOVERY_REPLAY_DELAY_SECONDS,
  };

  if (options.path === RecoveryReplayTargetKind.EventBridge) {
    // Drain the EventBridge target DLQ and replay back onto the bus.
    event.dlqUrl = await resolveEventDlqUrl();
    event.replayTarget = RecoveryReplayTargetKind.EventBridge;
    event.eventBusName = await resolveEventBusName();
  } else if (options.path === RecoveryReplayTargetKind.Sns) {
    // Drain the SNS subscription DLQ and republish onto the topic.
    event.dlqUrl = await resolveSnsDlqUrl();
    event.replayTarget = RecoveryReplayTargetKind.Sns;
    event.snsTopicArn = await resolveSnsTopicArn();
  } else if (options.path === RecoveryReplayTargetKind.DynamoDb) {
    // Drain the stream DLQ and invoke the stream processor with each saved item.
    event.dlqUrl = await resolveStreamDlqUrl();
    event.replayTarget = RecoveryReplayTargetKind.DynamoDb;
    event.streamProcessorArn = await resolveStreamProcessorArn();
  }

  // Durable functions with executionTimeout > 15 minutes cannot use RequestResponse.
  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: "Event",
      DurableExecutionName: recoveryId,
      Payload: Buffer.from(JSON.stringify(event)),
    }),
  );

  if (result.FunctionError) {
    throw new Error(
      result.Payload ? Buffer.from(result.Payload).toString("utf8") : result.FunctionError,
    );
  }
  if (result.StatusCode && result.StatusCode >= 300) {
    throw new Error(`Recovery invoke failed with status ${result.StatusCode}`);
  }
  return recoveryId;
}

export async function seedEventBridgeShipments(): Promise<
  { shipmentId: string; eventId: string }[]
> {
  const eventBusName = await resolveEventBusName();
  const seeded: { shipmentId: string; eventId: string }[] = [];
  for (const shipment of DEMO_SHIPMENTS) {
    const result = await eventBridge.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: eventBusName,
            Source: SHIPMENT_EVENT_SOURCE,
            DetailType: SHIPMENT_EVENT_DETAIL_TYPE,
            Detail: JSON.stringify(shipment),
          },
        ],
      }),
    );
    const entry = result.Entries?.[0];
    if (result.FailedEntryCount || !entry?.EventId) {
      throw new Error(
        `PutEvents failed for ${shipmentIdOf(shipment)}: ${entry?.ErrorMessage ?? "unknown error"}`,
      );
    }
    seeded.push({ shipmentId: shipmentIdOf(shipment), eventId: entry.EventId });
  }
  return seeded;
}

export async function seedShipmentRecords(): Promise<{ shipmentId: string }[]> {
  const tableName = await resolveShipmentRecordsTableName();
  const seeded: { shipmentId: string }[] = [];
  for (const shipment of DEMO_SHIPMENTS) {
    const shipmentId = shipmentIdOf(shipment);
    await shipmentRecords.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...(shipment as Record<string, unknown>),
          pk: shipmentId,
        },
      }),
    );
    seeded.push({ shipmentId });
  }
  return seeded;
}

export async function clearShipmentRecords(): Promise<void> {
  const tableName = await resolveShipmentRecordsTableName();
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await shipmentRecords.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "pk",
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      if (typeof item.pk !== "string") {
        continue;
      }
      await shipmentRecords.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { pk: item.pk },
        }),
      );
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
}

export async function seedSnsShipments(): Promise<{ shipmentId: string; messageId: string }[]> {
  const topicArn = await resolveSnsTopicArn();
  const seeded: { shipmentId: string; messageId: string }[] = [];
  for (const shipment of DEMO_SHIPMENTS) {
    const result = await sns.send(
      new PublishCommand({ TopicArn: topicArn, Message: JSON.stringify(shipment) }),
    );
    if (!result.MessageId) {
      throw new Error(`SNS Publish for ${shipmentIdOf(shipment)} did not return a MessageId`);
    }
    seeded.push({ shipmentId: shipmentIdOf(shipment), messageId: result.MessageId });
  }
  return seeded;
}

export async function purgeQueue(queueUrl: string): Promise<void> {
  try {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
  } catch (error: unknown) {
    if (isPurgeInProgress(error)) {
      throw new Error(
        "SQS purge is limited to once per 60 seconds. Wait a minute and retry npm run demo:reset.",
      );
    }
    throw error;
  }
}

export async function sendJsonMessage(queueUrl: string, body: unknown): Promise<string> {
  const result = await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
    }),
  );
  if (!result.MessageId) {
    throw new Error("SQS SendMessage did not return a MessageId");
  }
  return result.MessageId;
}

function isPurgeInProgress(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { name?: string; Code?: string; code?: string; message?: string };
  const code = `${candidate.name ?? ""} ${candidate.Code ?? ""} ${candidate.code ?? ""} ${candidate.message ?? ""}`;
  return /PurgeQueueInProgress/i.test(code);
}
