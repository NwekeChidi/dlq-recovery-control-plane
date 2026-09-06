import type { SQSHandler } from "aws-lambda";
import { InvalidShipmentError } from "../shared/errors";
import { DynamoShipmentLedger, type ShipmentLedger } from "../shared/shipments-repo";
import { processShipment } from "./process-shipment";

export const handler: SQSHandler = async (event): Promise<void> => {
  const ledger = ledgerFromEnv();
  for (const record of event.Records) {
    const recoveryId = record.messageAttributes.recoveryId?.stringValue;
    const payload = parseBody(record.body);
    await processShipment(payload, { recoveryId, ledger });
  }
};

function ledgerFromEnv(): ShipmentLedger | undefined {
  const tableName = process.env.DEMO_LEDGER_TABLE_NAME;
  if (!tableName) {
    return undefined;
  }
  return DynamoShipmentLedger.fromTableName(tableName);
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new InvalidShipmentError("Message body is not valid JSON");
  }
}
