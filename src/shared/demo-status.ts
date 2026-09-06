import { isRecord } from "./shipment";

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

export function formatDemoStatus(queue: QueueDepth, dlq: QueueDepth): string {
  return [
    `ShipmentsQueue: ${queue.visible} (in-flight: ${queue.inFlight})`,
    `ShipmentsDLQ:    ${dlq.visible}`,
  ].join("\n");
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
