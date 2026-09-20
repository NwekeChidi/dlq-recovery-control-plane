import { EXPECTED_DLQ_DEPTH } from "../shared/demo";
import { formatDemoStatus } from "../shared/demo-status";
import {
  formatDemoAwsError,
  getQueueDepth,
  resolveSnsDlqUrl,
  resolveSnsTopicArn,
} from "./aws";
import { seedSnsDemo, waitForSeededSnsDlq } from "./demo-ops";

async function main(): Promise<void> {
  const wait = !process.argv.includes("--no-wait");
  const topicArn = await resolveSnsTopicArn();
  const snsDlqUrl = await resolveSnsDlqUrl();

  console.log(`SNS topic: ${topicArn}`);
  console.log("Seeded:");
  for (const seeded of await seedSnsDemo()) {
    console.log(`${seeded.shipmentId}  ${seeded.messageId}`);
  }

  if (!wait) {
    return;
  }

  const reached = await waitForSeededSnsDlq();
  const dlq = await getQueueDepth(snsDlqUrl);
  console.log("");
  console.log(
    formatDemoStatus({ visible: 0, inFlight: 0 }, dlq, [], {}, {
      queue: null,
      dlq: "ShipmentNotificationsDLQ",
    }),
  );

  if (!reached) {
    throw new Error(
      `Timed out waiting for ShipmentNotificationsDLQ depth ${EXPECTED_DLQ_DEPTH}. SNS may still be retrying delivery.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
