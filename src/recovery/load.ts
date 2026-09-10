import {
  ChangeMessageVisibilityCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

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
      VisibilityTimeout: 30,
    }),
  );

  const messages = (result.Messages ?? []).flatMap((message) => {
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

  // P8 records decisions only. Restore visibility so the DLQ is not drained.
  await Promise.all(
    messages.map((message) =>
      sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.receiptHandle,
          VisibilityTimeout: 0,
        }),
      ),
    ),
  );

  return messages;
}
