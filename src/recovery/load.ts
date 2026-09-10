import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

export const DLQ_RECEIVE_VISIBILITY_SECONDS = 90;

export interface DlqMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
}

export function parseDlqBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

export async function loadDlqBatch(
  sqs: SQSClient,
  queueUrl: string,
  batchSize: number,
): Promise<DlqMessage[]> {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: batchSize,
      WaitTimeSeconds: 1,
      VisibilityTimeout: DLQ_RECEIVE_VISIBILITY_SECONDS,
    }),
  );

  return (result.Messages ?? []).flatMap((message) => {
    if (!message.MessageId || !message.ReceiptHandle || message.Body === undefined) {
      return [];
    }
    return [
      {
        messageId: message.MessageId,
        receiptHandle: message.ReceiptHandle,
        body: message.Body,
      },
    ];
  });
}

export async function deleteDlqMessage(
  sqs: SQSClient,
  queueUrl: string,
  receiptHandle: string,
): Promise<void> {
  await sqs.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
    }),
  );
}
