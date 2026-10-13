import { formatDemoAwsError } from "./aws";
import { startEventBridgeRecovery } from "./demo-ops";

async function main(): Promise<void> {
  const recoveryId = await startEventBridgeRecovery();
  console.log(`Started EventBridge recovery: ${recoveryId}`);
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
