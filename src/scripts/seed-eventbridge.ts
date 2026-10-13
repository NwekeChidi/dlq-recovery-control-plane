import { EXPECTED_DLQ_DEPTH } from "../shared/demo";
import { formatDemoStatus, STREAM_DLQ_LABEL } from "../shared/demo-status";
import {
  formatDemoAwsError,
  getQueueDepth,
  resolveEventBusName,
  resolveEventDlqUrl,
  streamDlqVisible,
} from "./aws";
import { seedEventBridgeDemo, waitForSeededEventDlq } from "./demo-ops";

async function main(): Promise<void> {
  const wait = !process.argv.includes("--no-wait");
  const busName = await resolveEventBusName();
  const eventDlqUrl = await resolveEventDlqUrl();

  console.log(`EventBridge bus: ${busName}`);
  console.log("Seeded:");
  for (const seeded of await seedEventBridgeDemo()) {
    console.log(`${seeded.shipmentId}  ${seeded.eventId}`);
  }

  if (!wait) {
    return;
  }

  const reached = await waitForSeededEventDlq();
  const dlq = await getQueueDepth(eventDlqUrl);
  console.log("");
  console.log(
    formatDemoStatus({ visible: 0, inFlight: 0 }, dlq, [], {
      extraQueues: [{ label: STREAM_DLQ_LABEL, visible: await streamDlqVisible() }],
    }, {
      queue: null,
      dlq: "ShipmentEventsDLQ",
    }),
  );

  if (!reached) {
    throw new Error(
      `Timed out waiting for ShipmentEventsDLQ depth ${EXPECTED_DLQ_DEPTH}. The event processor writes failed deliveries there.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
