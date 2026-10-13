import { formatDemoStatus, STREAM_DLQ_LABEL } from "../shared/demo-status";
import {
  formatDemoAwsError,
  getQueueDepth,
  resolveDemoLedger,
  resolveDemoQueueUrls,
  resolveDemoRecoveryStore,
  resolveEventDlqUrl,
  resolveSnsDlqUrl,
  streamDlqVisible,
} from "./aws";

async function main(): Promise<void> {
  const urls = await resolveDemoQueueUrls();
  const [eventDlqUrl, snsDlqUrl] = await Promise.all([resolveEventDlqUrl(), resolveSnsDlqUrl()]);
  const ledger = await resolveDemoLedger();
  const recovery = await resolveDemoRecoveryStore();
  const [queue, dlq, eventDlq, snsDlq, streamVisible] = await Promise.all([
    getQueueDepth(urls.queueUrl),
    getQueueDepth(urls.dlqUrl),
    getQueueDepth(eventDlqUrl),
    getQueueDepth(snsDlqUrl),
    streamDlqVisible(),
  ]);
  const [shipments, quarantines, recoveryJobs, recoveryMessages, downstreamStatus] =
    await Promise.all([
      ledger.listShipmentStates(),
      recovery.listQuarantines(),
      recovery.listRecoveryJobs(),
      recovery.listRecoveryMessages(),
      recovery.getDownstreamStatus(),
    ]);
  console.log(
    formatDemoStatus(queue, dlq, shipments, {
      extraQueues: [
        { label: "ShipmentEventsDLQ", visible: eventDlq.visible },
        { label: "ShipmentNotificationsDLQ", visible: snsDlq.visible },
        { label: STREAM_DLQ_LABEL, visible: streamVisible },
      ],
      quarantines,
      recoveryJobs,
      recoveryMessages,
      downstreamStatus,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
