import { DEMO_SHIPMENTS } from "../fixtures/shipments";
import { EXPECTED_DLQ_DEPTH } from "../shared/demo";
import { shipmentIdOf, waitUntil } from "../shared/demo-status";
import {
  DownstreamStatus,
  RecoveryJobStatus,
  RecoveryReplayTargetKind,
} from "../shared/recovery";
import {
  getQueueDepth,
  invokeDemoRecovery,
  purgeQueue,
  resolveDemoLedger,
  resolveDemoQueueUrls,
  resolveDemoRecoveryStore,
  resolveEventDlqUrl,
  resolveSnsDlqUrl,
  seedEventBridgeShipments,
  seedSnsShipments,
  sendJsonMessage,
  type DemoQueueUrls,
} from "./aws";

export async function resetDemoEnvironment(): Promise<DemoQueueUrls> {
  const urls = await resolveDemoQueueUrls();
  const ledger = await resolveDemoLedger();
  const recovery = await resolveDemoRecoveryStore();
  await purgeQueue(urls.queueUrl);
  await purgeQueue(urls.dlqUrl);
  await purgeAlternatePathDlqs();
  await ledger.clearShipments();
  await recovery.clear();
  await recovery.setDownstreamStatus(DownstreamStatus.Healthy);
  return urls;
}

/**
 * Best-effort purge of the EventBridge and SNS DLQs so the SQS demo reset does
 * not fail on stacks deployed before those paths existed.
 */
async function purgeAlternatePathDlqs(): Promise<void> {
  await purgeBestEffort(resolveEventDlqUrl);
  await purgeBestEffort(resolveSnsDlqUrl);
}

async function purgeBestEffort(resolveUrl: () => Promise<string>): Promise<void> {
  try {
    await purgeQueue(await resolveUrl());
  } catch {
    // Path not deployed yet; nothing to purge.
  }
}

export async function seedEventBridgeDemo(): Promise<{ shipmentId: string; eventId: string }[]> {
  return seedEventBridgeShipments();
}

export async function waitForSeededEventDlq(timeoutMs = 360_000): Promise<boolean> {
  const eventDlqUrl = await resolveEventDlqUrl();
  return waitUntil(
    async () => {
      const dlq = await getQueueDepth(eventDlqUrl);
      return dlq.visible >= EXPECTED_DLQ_DEPTH;
    },
    { timeoutMs, intervalMs: 2_000 },
  );
}

export async function startEventBridgeRecovery(): Promise<string> {
  return invokeDemoRecovery({ path: RecoveryReplayTargetKind.EventBridge });
}

export async function seedSnsDemo(): Promise<{ shipmentId: string; messageId: string }[]> {
  return seedSnsShipments();
}

export async function waitForSeededSnsDlq(timeoutMs = 120_000): Promise<boolean> {
  const snsDlqUrl = await resolveSnsDlqUrl();
  return waitUntil(
    async () => {
      const dlq = await getQueueDepth(snsDlqUrl);
      return dlq.visible >= EXPECTED_DLQ_DEPTH;
    },
    { timeoutMs, intervalMs: 2_000 },
  );
}

export async function startSnsRecovery(): Promise<string> {
  return invokeDemoRecovery({ path: RecoveryReplayTargetKind.Sns });
}

export async function seedDemoShipments(): Promise<{ messageId: string; shipmentId: string }[]> {
  const urls = await resolveDemoQueueUrls();
  const seeded = [];
  for (const shipment of DEMO_SHIPMENTS) {
    const messageId = await sendJsonMessage(urls.queueUrl, shipment);
    seeded.push({ shipmentId: shipmentIdOf(shipment), messageId });
  }
  return seeded;
}

export async function waitForSeededDlq(timeoutMs = 90_000): Promise<boolean> {
  const urls = await resolveDemoQueueUrls();
  return waitUntil(
    async () => {
      const dlq = await getQueueDepth(urls.dlqUrl);
      return dlq.visible >= EXPECTED_DLQ_DEPTH;
    },
    { timeoutMs, intervalMs: 2_000 },
  );
}

export async function startDemoRecovery(): Promise<string> {
  return invokeDemoRecovery();
}

export async function waitForRecoveryTerminal(
  recoveryId: string,
  timeoutMs = 120_000,
): Promise<boolean> {
  const recovery = await resolveDemoRecoveryStore();
  return waitUntil(
    async () => {
      const job = await recovery.getRecoveryJob(recoveryId);
      return (
        job?.status === RecoveryJobStatus.Completed || job?.status === RecoveryJobStatus.Stopped
      );
    },
    { timeoutMs, intervalMs: 2_000 },
  );
}

export async function setDemoDownstream(status: DownstreamStatus): Promise<void> {
  const recovery = await resolveDemoRecoveryStore();
  await recovery.setDownstreamStatus(status);
}
