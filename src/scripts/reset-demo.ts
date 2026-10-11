import { SQS_DLQ_LABEL, STREAM_DLQ_LABEL } from "../shared/demo-status";
import { formatDemoAwsError, getQueueDepth, streamDlqVisible } from "./aws";
import { resetDemoEnvironment } from "./demo-ops";

async function main(): Promise<void> {
  const urls = await resetDemoEnvironment();
  const queue = await getQueueDepth(urls.queueUrl);
  const dlq = await getQueueDepth(urls.dlqUrl);
  const streamVisible = await streamDlqVisible();

  console.log("Reset:");
  console.log("  ShipmentsQueue purged");
  console.log(`  ${SQS_DLQ_LABEL} purged`);
  console.log("  ShipmentEventsDLQ purged");
  console.log("  ShipmentNotificationsDLQ purged");
  console.log(`  ${STREAM_DLQ_LABEL} purged`);
  console.log("  DemoLedger shipment records cleared");
  console.log("  DemoLedger quarantine and recovery records cleared");
  console.log("  Downstream restored to healthy");
  console.log(`  ShipmentsQueue: ${queue.visible}`);
  console.log(`  ${SQS_DLQ_LABEL}: ${dlq.visible}`);
  console.log(`  ${STREAM_DLQ_LABEL}: ${streamVisible}`);
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
