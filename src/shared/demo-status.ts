import { RecoveryAction, type FailureClass } from "./failure";
import { ReplayResult, type DownstreamStatus, type RecoveryJobStatus } from "./recovery";
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
  downstreamStatus?: DownstreamStatus;
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
    startedAt?: string;
    stopReason?: string;
    recoveredCount?: number;
    quarantinedCount?: number;
    suppressedCount?: number;
    failureCount?: number;
  }>;
  recoveryMessages?: Array<{
    recoveryId: string;
    messageId: string;
    shipmentId?: string;
    failureClass: FailureClass;
    action: RecoveryAction;
    replayResult?: ReplayResult;
    patchVersion?: string;
  }>;
}

const LABEL_WIDTH = 18;

export function formatDemoStatus(
  queue: QueueDepth,
  dlq: QueueDepth,
  shipments: Array<{ shipmentId: string; status: ShipmentDispatchStatus }> = [],
  extras: DemoStatusExtras = {},
): string {
  const lines = [
    labeled("ShipmentsQueue", formatQueueValue(queue)),
    labeled("ShipmentsDLQ", dlq.visible),
  ];

  if (extras.downstreamStatus !== undefined) {
    lines.push(labeled("Downstream", extras.downstreamStatus));
  }

  if (shipments.length > 0) {
    lines.push("Dispatched:");
    for (const shipment of shipments) {
      lines.push(`  ${shipment.shipmentId}  ${shipment.status}`);
    }
  }

  if (extras.quarantines !== undefined) {
    lines.push(labeled("Quarantine", extras.quarantines.length));
  }

  const recoveryJobs = extras.recoveryJobs ?? [];
  const recoveryMessages = extras.recoveryMessages ?? [];
  if (recoveryJobs.length > 0 || recoveryMessages.length > 0) {
    const recoveryIds = orderedRecoveryIds(recoveryJobs, recoveryMessages);
    for (const recoveryId of recoveryIds) {
      const job = recoveryJobs.find((candidate) => candidate.recoveryId === recoveryId);
      const messages = recoveryMessages
        .filter((message) => message.recoveryId === recoveryId)
        .sort(byDisplayId);
      const counts = projectorCounts(job, messages);
      lines.push("");
      lines.push(labeled("Recovery", recoveryId));
      if (job) {
        lines.push(labeled("Status", job.status));
      }
      lines.push(labeled("Recovered", counts.recovered));
      lines.push(labeled("Patched", counts.patched));
      lines.push(labeled("Quarantined", counts.quarantined));
      lines.push(labeled("Suppressed", counts.suppressed));
      lines.push(labeled("Replay failures", counts.replayFailures));
      if (job?.stopReason) {
        lines.push(labeled("Stop reason", job.stopReason));
      }
      for (const message of messages) {
        const columns = [
          message.shipmentId ?? message.messageId,
          message.failureClass,
          message.action,
        ];
        if (message.replayResult) {
          columns.push(message.replayResult);
        }
        lines.push(`  ${columns.join("  ")}`);
      }
    }
  }

  return lines.join("\n");
}

export function labeled(label: string, value: string | number): string {
  return `${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;
}

function formatQueueValue(queue: QueueDepth): string {
  if (queue.inFlight > 0) {
    return `${queue.visible} (in-flight: ${queue.inFlight})`;
  }
  return String(queue.visible);
}

function orderedRecoveryIds(
  jobs: NonNullable<DemoStatusExtras["recoveryJobs"]>,
  messages: NonNullable<DemoStatusExtras["recoveryMessages"]>,
): string[] {
  const ids = [
    ...new Set([...jobs.map((job) => job.recoveryId), ...messages.map((message) => message.recoveryId)]),
  ];
  return ids.sort((left, right) => {
    const leftStarted = jobs.find((job) => job.recoveryId === left)?.startedAt;
    const rightStarted = jobs.find((job) => job.recoveryId === right)?.startedAt;
    if (leftStarted && rightStarted && leftStarted !== rightStarted) {
      return rightStarted.localeCompare(leftStarted);
    }
    return left.localeCompare(right);
  });
}

function projectorCounts(
  job: NonNullable<DemoStatusExtras["recoveryJobs"]>[number] | undefined,
  messages: NonNullable<DemoStatusExtras["recoveryMessages"]>,
): {
  recovered: number;
  patched: number;
  quarantined: number;
  suppressed: number;
  replayFailures: number;
} {
  if (messages.length > 0) {
    return {
      recovered: messages.filter((message) => message.replayResult === ReplayResult.Success).length,
      patched: messages.filter((message) => message.action === RecoveryAction.Patch).length,
      quarantined: messages.filter((message) => message.action === RecoveryAction.Quarantine)
        .length,
      suppressed: messages.filter((message) => message.action === RecoveryAction.Skip).length,
      replayFailures: messages.filter((message) => message.replayResult === ReplayResult.Failed)
        .length,
    };
  }
  return {
    recovered: job?.recoveredCount ?? 0,
    patched: 0,
    quarantined: job?.quarantinedCount ?? 0,
    suppressed: job?.suppressedCount ?? 0,
    replayFailures: job?.failureCount ?? 0,
  };
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
