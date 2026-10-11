import { EXPECTED_DLQ_DEPTH } from "../shared/demo";
import { formatDemoStatus, queuesAreDirty, SQS_DLQ_LABEL, STREAM_DLQ_LABEL } from "../shared/demo-status";
import { formatDemoAwsError, getQueueDepth, resolveDemoQueueUrls, streamDlqVisible } from "./aws";
import { seedDemoShipments, waitForSeededDlq } from "./demo-ops";

async function main(): Promise<void> {
  const wait = !process.argv.includes("--no-wait");
  const urls = await resolveDemoQueueUrls();
  const queueBefore = await getQueueDepth(urls.queueUrl);
  const dlqBefore = await getQueueDepth(urls.dlqUrl);

  if (queuesAreDirty(queueBefore, dlqBefore)) {
    console.warn("Queues are not empty. Run npm run demo:reset first to avoid duplicate seeds.");
  }

  console.log("Seeded:");
  for (const seeded of await seedDemoShipments()) {
    console.log(`${seeded.shipmentId}  ${seeded.messageId}`);
  }

  if (!wait) {
    return;
  }

  const reached = await waitForSeededDlq();
  const queue = await getQueueDepth(urls.queueUrl);
  const dlq = await getQueueDepth(urls.dlqUrl);
  console.log("");
  console.log(
    formatDemoStatus(queue, dlq, [], {
      extraQueues: [{ label: STREAM_DLQ_LABEL, visible: await streamDlqVisible() }],
    }),
  );

  if (!reached) {
    throw new Error(
      `Timed out waiting for ${SQS_DLQ_LABEL} depth ${EXPECTED_DLQ_DEPTH}. Processor may still be retrying.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
