import { formatDemoAwsError } from "./aws";
import { startStreamRecovery } from "./demo-ops";

async function main(): Promise<void> {
  const recoveryId = await startStreamRecovery();
  console.log(`Started DynamoDB stream recovery: ${recoveryId}`);
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
