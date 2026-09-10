import { formatDemoStatus } from "../shared/demo-status";
import {
  formatDemoAwsError,
  getQueueDepth,
  resolveDemoLedger,
  resolveDemoQueueUrls,
  resolveDemoRecoveryStore,
} from "./aws";

async function main(): Promise<void> {
  const urls = await resolveDemoQueueUrls();
  const ledger = await resolveDemoLedger();
  const recovery = await resolveDemoRecoveryStore();
  const queue = await getQueueDepth(urls.queueUrl);
  const dlq = await getQueueDepth(urls.dlqUrl);
  const [shipments, quarantines, recoveryJobs, recoveryMessages] = await Promise.all([
    ledger.listShipmentStates(),
    recovery.listQuarantines(),
    recovery.listRecoveryJobs(),
    recovery.listRecoveryMessages(),
  ]);
  console.log(
    formatDemoStatus(queue, dlq, shipments, {
      quarantines,
      recoveryJobs,
      recoveryMessages,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
