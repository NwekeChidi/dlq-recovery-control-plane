import { formatDemoStatus } from "../shared/demo-status";
import {
  formatDemoAwsError,
  getQueueDepth,
  resolveDemoLedger,
  resolveDemoQueueUrls,
} from "./aws";

async function main(): Promise<void> {
  const urls = await resolveDemoQueueUrls();
  const ledger = await resolveDemoLedger();
  const queue = await getQueueDepth(urls.queueUrl);
  const dlq = await getQueueDepth(urls.dlqUrl);
  const shipments = await ledger.listShipmentStates();
  console.log(formatDemoStatus(queue, dlq, shipments));
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
