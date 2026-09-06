import { DEMO_SHIPMENTS } from "../fixtures/shipments";
import { EXPECTED_DLQ_DEPTH } from "../shared/demo";
import {
  formatDemoStatus,
  queuesAreDirty,
  shipmentIdOf,
  waitUntil,
} from "../shared/demo-status";
import { getQueueDepth, resolveDemoQueueUrls, sendJsonMessage } from "./aws";

async function main(): Promise<void> {
  const wait = !process.argv.includes("--no-wait");
  const urls = await resolveDemoQueueUrls();
  const queueBefore = await getQueueDepth(urls.queueUrl);
  const dlqBefore = await getQueueDepth(urls.dlqUrl);

  if (queuesAreDirty(queueBefore, dlqBefore)) {
    console.warn("Queues are not empty. Run npm run demo:reset first to avoid duplicate seeds.");
  }

  console.log("Seeded:");
  for (const shipment of DEMO_SHIPMENTS) {
    const messageId = await sendJsonMessage(urls.queueUrl, shipment);
    console.log(`${shipmentIdOf(shipment)}  ${messageId}`);
  }

  if (!wait) {
    return;
  }

  const reached = await waitUntil(
    async () => {
      const dlq = await getQueueDepth(urls.dlqUrl);
      return dlq.visible >= EXPECTED_DLQ_DEPTH;
    },
    { timeoutMs: 90_000, intervalMs: 2_000 },
  );

  const queue = await getQueueDepth(urls.queueUrl);
  const dlq = await getQueueDepth(urls.dlqUrl);
  console.log("");
  console.log(formatDemoStatus(queue, dlq));

  if (!reached) {
    throw new Error(
      `Timed out waiting for ShipmentsDLQ depth ${EXPECTED_DLQ_DEPTH}. Processor may still be retrying.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
