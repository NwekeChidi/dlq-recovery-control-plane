import {
  formatDemoAwsError,
  getQueueDepth,
  purgeQueue,
  resolveDemoLedger,
  resolveDemoQueueUrls,
  resolveDemoRecoveryStore,
} from "./aws";
import { DownstreamStatus } from "../shared/recovery";

async function main(): Promise<void> {
  const urls = await resolveDemoQueueUrls();
  const ledger = await resolveDemoLedger();
  const recovery = await resolveDemoRecoveryStore();
  await purgeQueue(urls.queueUrl);
  await purgeQueue(urls.dlqUrl);
  await ledger.clearShipments();
  await recovery.clear();
  await recovery.setDownstreamStatus(DownstreamStatus.Healthy);
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
