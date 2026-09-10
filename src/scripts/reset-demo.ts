import { formatDemoAwsError, getQueueDepth } from "./aws";
import { resetDemoEnvironment } from "./demo-ops";

async function main(): Promise<void> {
  const urls = await resetDemoEnvironment();
  const queue = await getQueueDepth(urls.queueUrl);
  const dlq = await getQueueDepth(urls.dlqUrl);

  console.log("Reset:");
  console.log("  ShipmentsQueue purged");
  console.log("  ShipmentsDLQ purged");
  console.log("  DemoLedger shipment records cleared");
  console.log("  DemoLedger quarantine and recovery records cleared");
  console.log("  Downstream restored to healthy");
  console.log(`  ShipmentsQueue: ${queue.visible}`);
  console.log(`  ShipmentsDLQ:    ${dlq.visible}`);
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
