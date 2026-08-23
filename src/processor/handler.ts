import type { SQSEvent, SQSHandler } from "aws-lambda";

/**
 * P1 production-path consumer.
 * Logs each SQS record and succeeds. Failure scenarios arrive in P2.
 */
export const handler: SQSHandler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    console.log(
      JSON.stringify({
        messageId: record.messageId,
        body: record.body,
      }),
    );
  }
};
