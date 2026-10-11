import { formatDemoStatus } from "../shared/demo-status";
import {
  formatDemoAwsError,
  getQueueDepth,
  resolveDemoLedger,
  resolveDemoRecoveryStore,
  resolveShipmentRecordsTableName,
  resolveStreamDlqUrl,
} from "./aws";

async function main(): Promise<void> {
  const tableName = await resolveShipmentRecordsTableName();
  const streamDlqUrl = await resolveStreamDlqUrl();
  const ledger = await resolveDemoLedger();
  const recovery = await resolveDemoRecoveryStore();
  const dlq = await getQueueDepth(streamDlqUrl);
  const [shipments, quarantines, recoveryJobs, recoveryMessages, downstreamStatus] =
    await Promise.all([
      ledger.listShipmentStates(),
      recovery.listQuarantines(),
      recovery.listRecoveryJobs(),
      recovery.listRecoveryMessages(),
      recovery.getDownstreamStatus(),
    ]);
  console.log(`Shipment table: ${tableName}`);
  console.log(
    formatDemoStatus(
      { visible: 0, inFlight: 0 },
      dlq,
      shipments,
      { quarantines, recoveryJobs, recoveryMessages, downstreamStatus },
      { queue: null, dlq: "ShipmentStreamDLQ" },
    ),
  );
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
