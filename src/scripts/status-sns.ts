import { formatDemoStatus, STREAM_DLQ_LABEL } from "../shared/demo-status";
import {
  formatDemoAwsError,
  getQueueDepth,
  resolveDemoLedger,
  resolveDemoRecoveryStore,
  resolveSnsDlqUrl,
  resolveSnsTopicArn,
  streamDlqVisible,
} from "./aws";

async function main(): Promise<void> {
  const topicArn = await resolveSnsTopicArn();
  const snsDlqUrl = await resolveSnsDlqUrl();
  const ledger = await resolveDemoLedger();
  const recovery = await resolveDemoRecoveryStore();
  const dlq = await getQueueDepth(snsDlqUrl);
  const [shipments, quarantines, recoveryJobs, recoveryMessages, downstreamStatus] =
    await Promise.all([
      ledger.listShipmentStates(),
      recovery.listQuarantines(),
      recovery.listRecoveryJobs(),
      recovery.listRecoveryMessages(),
      recovery.getDownstreamStatus(),
    ]);
  console.log(`SNS topic: ${topicArn}`);
  console.log(
    formatDemoStatus(
      { visible: 0, inFlight: 0 },
      dlq,
      shipments,
      {
        extraQueues: [{ label: STREAM_DLQ_LABEL, visible: await streamDlqVisible() }],
        quarantines,
        recoveryJobs,
        recoveryMessages,
        downstreamStatus,
      },
      { queue: null, dlq: "ShipmentNotificationsDLQ" },
    ),
  );
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
