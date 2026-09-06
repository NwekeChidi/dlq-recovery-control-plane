import { formatDemoStatus } from "../shared/demo-status";
import { formatDemoAwsError, getQueueDepth, resolveDemoQueueUrls } from "./aws";

async function main(): Promise<void> {
  const urls = await resolveDemoQueueUrls();
  const queue = await getQueueDepth(urls.queueUrl);
  const dlq = await getQueueDepth(urls.dlqUrl);
  console.log(formatDemoStatus(queue, dlq));
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
