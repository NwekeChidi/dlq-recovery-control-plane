import { EXPECTED_DLQ_DEPTH } from "../shared/demo";
import { formatDemoStatus } from "../shared/demo-status";
import {
  formatDemoAwsError,
  getQueueDepth,
  resolveShipmentRecordsTableName,
  resolveStreamDlqUrl,
} from "./aws";
import { seedStreamDemo, waitForSeededStreamDlq } from "./demo-ops";

async function main(): Promise<void> {
  const wait = !process.argv.includes("--no-wait");
  const tableName = await resolveShipmentRecordsTableName();
  const streamDlqUrl = await resolveStreamDlqUrl();

  console.log(`Shipment table: ${tableName}`);
  console.log("Seeded:");
  for (const seeded of await seedStreamDemo()) {
    console.log(seeded.shipmentId);
  }

  if (!wait) {
    return;
  }

  const reached = await waitForSeededStreamDlq();
  const dlq = await getQueueDepth(streamDlqUrl);
  console.log("");
  console.log(
    formatDemoStatus({ visible: 0, inFlight: 0 }, dlq, [], {}, {
      queue: null,
      dlq: "ShipmentStreamDLQ",
    }),
  );

  if (!reached) {
    throw new Error(
      `Timed out waiting for ShipmentStreamDLQ depth ${EXPECTED_DLQ_DEPTH}. The stream processor writes failed deliveries there.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
