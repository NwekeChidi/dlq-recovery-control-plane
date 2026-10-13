import { RecoveryAction } from "./failure";
import { RecoveryJobStatus, ReplayResult } from "./recovery";

export type SmokeMode = "healthy" | "circuit-breaker";

export interface SmokeMessage {
  shipmentId?: string;
  action: RecoveryAction;
  replayResult?: ReplayResult;
}

export interface SmokeJob {
  recoveryId: string;
  status: RecoveryJobStatus;
  stopReason?: string;
  processedCount?: number;
}

export interface SmokeSnapshot {
  dlqVisible: number;
  job?: SmokeJob;
  messages: SmokeMessage[];
}

export function evaluateHealthySmoke(snapshot: SmokeSnapshot): string[] {
  const problems: string[] = [];
  if (snapshot.job?.status !== RecoveryJobStatus.Completed) {
    problems.push(`expected status COMPLETED, got ${snapshot.job?.status ?? "no job"}`);
  }
  expectShipment(problems, snapshot.messages, "SHP-001", RecoveryAction.Replay, ReplayResult.Success);
  expectShipment(problems, snapshot.messages, "SHP-002", RecoveryAction.Patch, ReplayResult.Success);
  expectShipment(problems, snapshot.messages, "SHP-003", RecoveryAction.Quarantine, ReplayResult.NotSent);
  expectShipment(problems, snapshot.messages, "SHP-004", RecoveryAction.Skip, ReplayResult.NotSent);

  const recovered = count(snapshot.messages, (message) => message.replayResult === ReplayResult.Success);
  const patched = count(snapshot.messages, (message) => message.action === RecoveryAction.Patch);
  const quarantined = count(
    snapshot.messages,
    (message) => message.action === RecoveryAction.Quarantine,
  );
  const suppressed = count(snapshot.messages, (message) => message.action === RecoveryAction.Skip);
  const failures = count(snapshot.messages, (message) => message.replayResult === ReplayResult.Failed);

  if (recovered !== 2) {
    problems.push(`expected 2 recovered, got ${recovered}`);
  }
  if (patched !== 1) {
    problems.push(`expected 1 patched, got ${patched}`);
  }
  if (quarantined !== 1) {
    problems.push(`expected 1 quarantined, got ${quarantined}`);
  }
  if (suppressed !== 1) {
    problems.push(`expected 1 duplicate suppressed, got ${suppressed}`);
  }
  if (failures !== 0) {
    problems.push(`expected 0 replay failures, got ${failures}`);
  }
  if (snapshot.dlqVisible !== 0) {
    problems.push(`expected empty DLQ, got ${snapshot.dlqVisible} visible`);
  }
  return problems;
}

export function evaluateStoppedSmoke(snapshot: SmokeSnapshot): string[] {
  const problems: string[] = [];
  if (snapshot.job?.status !== RecoveryJobStatus.Stopped) {
    problems.push(`expected status STOPPED, got ${snapshot.job?.status ?? "no job"}`);
  }
  const reason = snapshot.job?.stopReason ?? "";
  if (!/failure rate/i.test(reason)) {
    problems.push(`expected stop reason to mention failure rate, got ${reason || "none"}`);
  }
  const failures = count(snapshot.messages, (message) => message.replayResult === ReplayResult.Failed);
  if (failures === 0) {
    problems.push("expected at least one FAILED replay result");
  }
  const recovered = count(snapshot.messages, (message) => message.replayResult === ReplayResult.Success);
  if (recovered !== 0) {
    problems.push(`expected 0 recovered after STOP, got ${recovered}`);
  }
  return problems;
}

export function formatTalkSummary(snapshot: SmokeSnapshot): string {
  const recovered = count(snapshot.messages, (message) => message.replayResult === ReplayResult.Success);
  const patched = count(snapshot.messages, (message) => message.action === RecoveryAction.Patch);
  const quarantined = count(
    snapshot.messages,
    (message) => message.action === RecoveryAction.Quarantine,
  );
  const suppressed = count(snapshot.messages, (message) => message.action === RecoveryAction.Skip);
  const failures = count(snapshot.messages, (message) => message.replayResult === ReplayResult.Failed);
  const processed = snapshot.job?.processedCount ?? snapshot.messages.length;
  return [
    talkRow("Failed messages", processed),
    talkRow("Recovered", recovered),
    talkRow("Patched", patched),
    talkRow("Quarantined", quarantined),
    talkRow("Duplicate dispatches prevented", suppressed),
    talkRow("Replay failures", failures),
    talkRow("Status", snapshot.job?.status ?? "UNKNOWN"),
  ].join("\n");
}

function expectShipment(
  problems: string[],
  messages: SmokeMessage[],
  shipmentId: string,
  action: RecoveryAction,
  replayResult?: ReplayResult,
): void {
  const match = messages.find((message) => message.shipmentId === shipmentId);
  if (!match) {
    problems.push(`missing ${shipmentId}`);
    return;
  }
  if (match.action !== action) {
    problems.push(`${shipmentId} action expected ${action}, got ${match.action}`);
  }
  if (replayResult !== undefined && match.replayResult !== replayResult) {
    problems.push(
      `${shipmentId} replayResult expected ${replayResult}, got ${match.replayResult ?? "none"}`,
    );
  }
}

function count(messages: SmokeMessage[], predicate: (message: SmokeMessage) => boolean): number {
  return messages.filter(predicate).length;
}

function talkRow(label: string, value: string | number): string {
  return `${label.padEnd(34)}${value}`;
}
