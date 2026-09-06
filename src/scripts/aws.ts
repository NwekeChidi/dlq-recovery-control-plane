import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  DEMO_STACK_NAME,
  DLQ_URL_OUTPUT,
  QUEUE_URL_OUTPUT,
} from "../shared/demo";
import type { QueueDepth } from "../shared/demo-status";

export interface DemoQueueUrls {
  queueUrl: string;
  dlqUrl: string;
}

const sqs = new SQSClient({});
const cloudFormation = new CloudFormationClient({});

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

  const stackName = process.env.DEMO_STACK_NAME ?? DEMO_STACK_NAME;
  const result = await cloudFormation.send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  const outputs = result.Stacks?.[0]?.Outputs ?? [];
  const byKey = Object.fromEntries(
    outputs.flatMap((output) =>
      output.OutputKey && output.OutputValue ? [[output.OutputKey, output.OutputValue]] : [],
    ),
  );

  const queueUrl = byKey[QUEUE_URL_OUTPUT];
  const dlqUrl = byKey[DLQ_URL_OUTPUT];
  if (!queueUrl || !dlqUrl) {
    throw new Error(
      `Stack ${stackName} is missing ${QUEUE_URL_OUTPUT} / ${DLQ_URL_OUTPUT}. Deploy first, or set SHIPMENTS_QUEUE_URL and SHIPMENTS_DLQ_URL.`,
    );
  }

  return { queueUrl, dlqUrl };
}

export async function getQueueDepth(queueUrl: string): Promise<QueueDepth> {
  const result = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
      ],
    }),
  );
  const attributes = result.Attributes ?? {};
  return {
    visible: Number(attributes.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

export async function purgeQueue(queueUrl: string): Promise<void> {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
}

export async function sendJsonMessage(
  queueUrl: string,
  body: unknown,
): Promise<string> {
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
