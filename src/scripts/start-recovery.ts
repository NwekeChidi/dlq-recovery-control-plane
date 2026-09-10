import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { randomUUID } from "node:crypto";
import { isRecord } from "../shared/shipment";
import {
  DEMO_RECOVERY_BATCH_SIZE,
  DEMO_RECOVERY_MAX_FAILURE_RATE,
  DEMO_RECOVERY_REPLAY_DELAY_SECONDS,
  type RecoveryStartEvent,
} from "../shared/recovery";
import { formatDemoAwsError, resolveRecoveryAliasArn } from "./aws";

const lambda = new LambdaClient({});

async function main(): Promise<void> {
  const functionArn = await resolveRecoveryAliasArn();
  const event: RecoveryStartEvent = {
    batchSize: DEMO_RECOVERY_BATCH_SIZE,
    maxFailureRate: DEMO_RECOVERY_MAX_FAILURE_RATE,
    replayDelaySeconds: DEMO_RECOVERY_REPLAY_DELAY_SECONDS,
  };
  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: "RequestResponse",
      DurableExecutionName: `REC-${randomUUID()}`,
      Payload: Buffer.from(JSON.stringify(event)),
    }),
  );

  if (result.FunctionError) {
    throw new Error(payloadText(result.Payload) || result.FunctionError);
  }

  const recoveryId = recoveryIdFromInvokePayload(parseJsonPayload(result.Payload));
  console.log(`Started recovery: ${recoveryId}`);
}

function parseJsonPayload(payload: Uint8Array | undefined): unknown {
  if (!payload || payload.length === 0) {
    throw new Error("Recovery invoke returned an empty payload");
  }
  return JSON.parse(Buffer.from(payload).toString("utf8")) as unknown;
}

function payloadText(payload: Uint8Array | undefined): string {
  return payload ? Buffer.from(payload).toString("utf8") : "";
}

function recoveryIdFromInvokePayload(payload: unknown): string {
  if (typeof payload === "string") {
    return recoveryIdFromInvokePayload(JSON.parse(payload) as unknown);
  }
  if (!isRecord(payload)) {
    throw new Error(`Unexpected recovery invoke payload: ${JSON.stringify(payload)}`);
  }
  if (typeof payload.recoveryId === "string") {
    return payload.recoveryId;
  }
  if (isRecord(payload.result) && typeof payload.result.recoveryId === "string") {
    return payload.result.recoveryId;
  }
  throw new Error(`Unexpected recovery invoke payload: ${JSON.stringify(payload)}`);
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
