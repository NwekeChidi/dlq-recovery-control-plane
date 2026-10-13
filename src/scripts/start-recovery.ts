import { formatDemoAwsError, invokeDemoRecovery } from "./aws";

async function main(): Promise<void> {
  const recoveryId = await invokeDemoRecovery();
  console.log(`Started recovery: ${recoveryId}`);
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
