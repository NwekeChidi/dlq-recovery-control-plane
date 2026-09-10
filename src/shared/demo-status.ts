import type { FailureClass, RecoveryAction } from "./failure";
import type { RecoveryJobStatus } from "./recovery";
import { isRecord } from "./shipment";
import type { ShipmentDispatchStatus } from "./shipments-repo";

export interface QueueDepth {
  visible: number;
  inFlight: number;
}

export function totalMessages(depth: QueueDepth): number {
  return depth.visible + depth.inFlight;
}

export function queuesAreDirty(queue: QueueDepth, dlq: QueueDepth): boolean {
  return totalMessages(queue) + totalMessages(dlq) > 0;
}

export interface DemoStatusExtras {
  quarantines?: Array<{
    messageId: string;
    shipmentId?: string;
    failureClass: FailureClass;
    action: RecoveryAction;
    reason: string;
  }>;
  recoveryJobs?: Array<{
    recoveryId: string;
    status: RecoveryJobStatus;
  }>;
  recoveryMessages?: Array<{
    recoveryId: string;
    messageId: string;
    shipmentId?: string;
    failureClass: FailureClass;
    action: RecoveryAction;
  }>;
}

export function formatDemoStatus(
  queue: QueueDepth,
  dlq: QueueDepth,
  shipments: Array<{ shipmentId: string; status: ShipmentDispatchStatus }> = [],
  extras: DemoStatusExtras = {},
): string {
  const lines = [
    `ShipmentsQueue: ${queue.visible} (in-flight: ${queue.inFlight})`,
    `ShipmentsDLQ:    ${dlq.visible}`,
  ];
  if (shipments.length > 0) {
    lines.push("Dispatched:");
    for (const shipment of shipments) {
      lines.push(`  ${shipment.shipmentId}  ${shipment.status}`);
    }
  }
  const quarantines = extras.quarantines ?? [];
  if (quarantines.length > 0) {
    lines.push("Quarantine:");
    for (const item of [...quarantines].sort(byDisplayId)) {
      lines.push(
        `  ${item.shipmentId ?? item.messageId}  ${item.failureClass}  ${item.action}`,
      );
    }
  }
  const recoveryJobs = extras.recoveryJobs ?? [];
  const recoveryMessages = extras.recoveryMessages ?? [];
  if (recoveryJobs.length > 0 || recoveryMessages.length > 0) {
    lines.push("Recovery:");
    const recoveryIds = [
      ...new Set([
        ...recoveryJobs.map((job) => job.recoveryId),
        ...recoveryMessages.map((message) => message.recoveryId),
      ]),
    ].sort();
    for (const recoveryId of recoveryIds) {
      const job = recoveryJobs.find((candidate) => candidate.recoveryId === recoveryId);
      lines.push(job ? `  ${recoveryId}  ${job.status}` : `  ${recoveryId}`);
      const messages = recoveryMessages
        .filter((message) => message.recoveryId === recoveryId)
        .sort(byDisplayId);
      for (const message of messages) {
        lines.push(
          `    ${message.shipmentId ?? message.messageId}  ${message.failureClass}  ${message.action}`,
        );
      }
    }
  }
  return lines.join("\n");
}

function byDisplayId(left: { shipmentId?: string; messageId: string }, right: typeof left): number {
  return (left.shipmentId ?? left.messageId).localeCompare(right.shipmentId ?? right.messageId);
}

export function shipmentIdOf(payload: unknown): string {
  if (!isRecord(payload)) {
    return "unknown";
  }
  if (typeof payload.shipmentId === "string") {
    return payload.shipmentId;
  }
  if (typeof payload.shipment_id === "string") {
    return payload.shipment_id;
  }
  return "unknown";
}

export async function waitUntil(
  predicate: () => Promise<boolean>,
  options: {
    timeoutMs: number;
    intervalMs: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(options.intervalMs);
  }

  return predicate();
}
