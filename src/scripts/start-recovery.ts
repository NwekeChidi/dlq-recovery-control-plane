import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  DEMO_RECOVERY_BATCH_SIZE,
  DEMO_RECOVERY_MAX_FAILURE_RATE,
  DEMO_RECOVERY_REPLAY_DELAY_SECONDS,
  createRecoveryId,
  type RecoveryStartEvent,
} from "../shared/recovery";
import { formatDemoAwsError, resolveRecoveryAliasArn } from "./aws";

const lambda = new LambdaClient({});

async function main(): Promise<void> {
  const functionArn = await resolveRecoveryAliasArn();
  const recoveryId = createRecoveryId();
  const event: RecoveryStartEvent = {
    recoveryId,
    batchSize: DEMO_RECOVERY_BATCH_SIZE,
    maxFailureRate: DEMO_RECOVERY_MAX_FAILURE_RATE,
    replayDelaySeconds: DEMO_RECOVERY_REPLAY_DELAY_SECONDS,
  };

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

  console.log(`Started recovery: ${recoveryId}`);
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
