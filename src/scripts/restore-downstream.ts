import { DownstreamStatus } from "../shared/recovery";
import { formatDemoAwsError, resolveDemoRecoveryStore } from "./aws";

async function main(): Promise<void> {
  const recovery = await resolveDemoRecoveryStore();
  await recovery.setDownstreamStatus(DownstreamStatus.Healthy);
  console.log("Downstream: healthy");
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
