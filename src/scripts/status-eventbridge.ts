import { formatDemoStatus } from "../shared/demo-status";
import {
  formatDemoAwsError,
  getQueueDepth,
  resolveDemoLedger,
  resolveDemoRecoveryStore,
  resolveEventBusName,
  resolveEventDlqUrl,
} from "./aws";

async function main(): Promise<void> {
  const busName = await resolveEventBusName();
  const eventDlqUrl = await resolveEventDlqUrl();
  const ledger = await resolveDemoLedger();
  const recovery = await resolveDemoRecoveryStore();
  const dlq = await getQueueDepth(eventDlqUrl);
  const [shipments, quarantines, recoveryJobs, recoveryMessages, downstreamStatus] =
    await Promise.all([
      ledger.listShipmentStates(),
      recovery.listQuarantines(),
      recovery.listRecoveryJobs(),
      recovery.listRecoveryMessages(),
      recovery.getDownstreamStatus(),
    ]);
  console.log(`EventBridge bus: ${busName}`);
  console.log(
    formatDemoStatus(
      { visible: 0, inFlight: 0 },
      dlq,
      shipments,
      { quarantines, recoveryJobs, recoveryMessages, downstreamStatus },
      { queue: null, dlq: "ShipmentEventsDLQ" },
    ),
  );
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
