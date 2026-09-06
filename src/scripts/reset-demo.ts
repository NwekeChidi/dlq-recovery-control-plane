import { formatDemoAwsError, getQueueDepth, purgeQueue, resolveDemoQueueUrls } from "./aws";

async function main(): Promise<void> {
  const urls = await resolveDemoQueueUrls();
  await purgeQueue(urls.queueUrl);
  await purgeQueue(urls.dlqUrl);
  const queue = await getQueueDepth(urls.queueUrl);
  const dlq = await getQueueDepth(urls.dlqUrl);

  console.log("Reset:");
  console.log("  ShipmentsQueue purged");
  console.log("  ShipmentsDLQ purged");
  console.log(`  ShipmentsQueue: ${queue.visible}`);
  console.log(`  ShipmentsDLQ:    ${dlq.visible}`);
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
