import { formatDemoAwsError } from "./aws";
import { startSnsRecovery } from "./demo-ops";

async function main(): Promise<void> {
  const recoveryId = await startSnsRecovery();
  console.log(`Started SNS recovery: ${recoveryId}`);
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
