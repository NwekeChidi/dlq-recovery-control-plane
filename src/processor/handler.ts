import type { SQSHandler } from "aws-lambda";
import { InvalidShipmentError } from "../shared/errors";
import { processShipment } from "./process-shipment";

export const handler: SQSHandler = async (event): Promise<void> => {
  for (const record of event.Records) {
    const recoveryId = record.messageAttributes.recoveryId?.stringValue;
    const payload = parseBody(record.body);
    await processShipment(payload, { recoveryId });
  }
};

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new InvalidShipmentError("Message body is not valid JSON");
  }
}
