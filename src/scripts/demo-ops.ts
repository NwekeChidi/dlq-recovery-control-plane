import { DEMO_SHIPMENTS } from "../fixtures/shipments";
import { EXPECTED_DLQ_DEPTH } from "../shared/demo";
import { shipmentIdOf, waitUntil } from "../shared/demo-status";
import { DownstreamStatus, RecoveryJobStatus } from "../shared/recovery";
import {
  getQueueDepth,
  invokeDemoRecovery,
  purgeQueue,
  resolveDemoLedger,
  resolveDemoQueueUrls,
  resolveDemoRecoveryStore,
  sendJsonMessage,
  type DemoQueueUrls,
} from "./aws";

export async function resetDemoEnvironment(): Promise<DemoQueueUrls> {
  const urls = await resolveDemoQueueUrls();
  const ledger = await resolveDemoLedger();
  const recovery = await resolveDemoRecoveryStore();
  await purgeQueue(urls.queueUrl);
  await purgeQueue(urls.dlqUrl);
  await ledger.clearShipments();
  await recovery.clear();
  await recovery.setDownstreamStatus(DownstreamStatus.Healthy);
  return urls;
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
