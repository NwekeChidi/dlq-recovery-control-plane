import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CONFIG_PK,
  QUARANTINE_PK_PREFIX,
  RECOVERY_PK_PREFIX,
  isQuarantinePk,
  isRecoveryJobPk,
  isRecoveryMessagePk,
  messageIdFromQuarantinePk,
  parseRecoveryMessagePk,
  quarantinePk,
  recoveryIdFromJobPk,
  recoveryJobPk,
  recoveryMessagePk,
} from "./dynamodb";
import { FailureClass, RecoveryAction } from "./failure";
import {
  DownstreamStatus,
  RecoveryJobStatus,
  ReplayResult,
  type QuarantineRecord,
  type RecoveryJobRecord,
  type RecoveryMessageRecord,
  type RecoveryStore,
} from "./recovery";

const DYNAMO_BATCH_WRITE_LIMIT = 25;

/** DynamoDB TTL attribute (epoch seconds). Enabled on the table in the CDK stack. */
export const LEDGER_TTL_ATTRIBUTE = "expiresAt";

/** Default retention for job + per-message records when nothing overrides it. */
export const DEFAULT_LEDGER_TTL_DAYS = 30;

const SECONDS_PER_DAY = 86_400;

/**
 * Per-record-type retention. `recordTtlDays` covers job and recovery-message
 * rows (routine recovery state). `quarantineTtlDays` is intentionally separate
 * and defaults to "never" — quarantined originals are forensic/audit evidence
 * (slide 11) and must not silently evaporate. A value <= 0 or undefined means
 * that record type never expires.
 */
export interface LedgerTtlConfig {
  recordTtlDays?: number;
  quarantineTtlDays?: number;
}

export function ledgerTtlConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LedgerTtlConfig {
  return {
    recordTtlDays: numFromEnv(env.RECOVERY_LEDGER_TTL_DAYS, DEFAULT_LEDGER_TTL_DAYS),
    quarantineTtlDays: numFromEnv(env.RECOVERY_QUARANTINE_TTL_DAYS, undefined),
  };
}

function numFromEnv(value: string | undefined, fallback: number | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class InMemoryRecoveryStore implements RecoveryStore {
  private readonly quarantines = new Map<string, QuarantineRecord>();
  private readonly jobs = new Map<string, RecoveryJobRecord>();
  private readonly messages = new Map<string, RecoveryMessageRecord>();
  private downstreamStatus = DownstreamStatus.Healthy;

  async putQuarantine(record: QuarantineRecord): Promise<void> {
    this.quarantines.set(record.messageId, structuredClone(record));
  }

  async getQuarantine(messageId: string): Promise<QuarantineRecord | undefined> {
    const record = this.quarantines.get(messageId);
    return record ? structuredClone(record) : undefined;
  }

  async listQuarantines(): Promise<QuarantineRecord[]> {
    return [...this.quarantines.values()].map((record) => structuredClone(record));
  }

  async putRecoveryJob(job: RecoveryJobRecord): Promise<void> {
    this.jobs.set(job.recoveryId, structuredClone(job));
  }

  async getRecoveryJob(recoveryId: string): Promise<RecoveryJobRecord | undefined> {
    const job = this.jobs.get(recoveryId);
    return job ? structuredClone(job) : undefined;
  }

  async listRecoveryJobs(): Promise<RecoveryJobRecord[]> {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }

  async putRecoveryMessage(record: RecoveryMessageRecord): Promise<void> {
    this.messages.set(messageKey(record.recoveryId, record.messageId), structuredClone(record));
  }

  async getRecoveryMessage(
    recoveryId: string,
    messageId: string,
  ): Promise<RecoveryMessageRecord | undefined> {
    const record = this.messages.get(messageKey(recoveryId, messageId));
    return record ? structuredClone(record) : undefined;
  }

  async listRecoveryMessages(recoveryId?: string): Promise<RecoveryMessageRecord[]> {
    const records = [...this.messages.values()].map((record) => structuredClone(record));
    return recoveryId ? records.filter((record) => record.recoveryId === recoveryId) : records;
  }

  async getDownstreamStatus(): Promise<DownstreamStatus> {
    return this.downstreamStatus;
  }

  async setDownstreamStatus(status: DownstreamStatus): Promise<void> {
    this.downstreamStatus = status;
  }

  async markReplayResult(
    recoveryId: string,
    messageId: string,
    result: ReplayResult.Success | ReplayResult.Failed,
  ): Promise<void> {
    const existing = await this.getRecoveryMessage(recoveryId, messageId);
    if (!existing) {
      return;
    }
    await this.putRecoveryMessage({ ...existing, replayResult: result });
  }

  async clear(): Promise<void> {
    this.quarantines.clear();
    this.jobs.clear();
    this.messages.clear();
    this.downstreamStatus = DownstreamStatus.Healthy;
  }
}

export interface DynamoRecoveryStoreOptions {
  ttl?: LedgerTtlConfig;
  /** Injectable clock (ms since epoch) for deterministic TTL in tests. */
  now?: () => number;
}

export class DynamoRecoveryStore implements RecoveryStore {
  private readonly ttl: LedgerTtlConfig;
  private readonly now: () => number;

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    options: DynamoRecoveryStoreOptions = {},
  ) {
    this.ttl = options.ttl ?? {};
    this.now = options.now ?? (() => Date.now());
  }

  static fromTableName(
    tableName: string,
    options: DynamoRecoveryStoreOptions = { ttl: ledgerTtlConfigFromEnv() },
  ): DynamoRecoveryStore {
    return new DynamoRecoveryStore(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName,
      options,
    );
  }

  /** Epoch-second expiry for a record kind, or undefined when it never expires. */
  private expiresAt(kind: "record" | "quarantine"): number | undefined {
    const days = kind === "quarantine" ? this.ttl.quarantineTtlDays : this.ttl.recordTtlDays;
    if (days === undefined || days <= 0) {
      return undefined;
    }
    return Math.floor(this.now() / 1000) + Math.round(days * SECONDS_PER_DAY);
  }

  async putQuarantine(record: QuarantineRecord): Promise<void> {
    await this.putItem({
      pk: quarantinePk(record.messageId),
      messageId: record.messageId,
      shipmentId: record.shipmentId,
      originalPayloadJson: JSON.stringify(record.originalPayload),
      failureClass: record.failureClass,
      action: record.action,
      reason: record.reason,
      sourceQueue: record.sourceQueue,
      recoveryId: record.recoveryId,
      quarantinedAt: record.quarantinedAt,
      [LEDGER_TTL_ATTRIBUTE]: this.expiresAt("quarantine"),
    });
  }

  async getQuarantine(messageId: string): Promise<QuarantineRecord | undefined> {
    const item = await this.getItem(quarantinePk(messageId));
    return item ? toQuarantineRecord(item) : undefined;
  }

  async listQuarantines(): Promise<QuarantineRecord[]> {
    const items = await this.scanByPkPrefix(QUARANTINE_PK_PREFIX);
    return items.filter((item) => isQuarantinePk(String(item.pk ?? ""))).map(toQuarantineRecord);
  }

  async putRecoveryJob(job: RecoveryJobRecord): Promise<void> {
    await this.putItem({
      pk: recoveryJobPk(job.recoveryId),
      recoveryId: job.recoveryId,
      status: job.status,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      batchSize: job.batchSize,
      maxFailureRate: job.maxFailureRate,
      replayDelaySeconds: job.replayDelaySeconds,
      processedCount: job.processedCount,
      recoveredCount: job.recoveredCount,
      quarantinedCount: job.quarantinedCount,
      suppressedCount: job.suppressedCount,
      failureCount: job.failureCount,
      stopReason: job.stopReason,
      [LEDGER_TTL_ATTRIBUTE]: this.expiresAt("record"),
    });
  }

  async getRecoveryJob(recoveryId: string): Promise<RecoveryJobRecord | undefined> {
    const item = await this.getItem(recoveryJobPk(recoveryId));
    return item ? toRecoveryJobRecord(item) : undefined;
  }

  async listRecoveryJobs(): Promise<RecoveryJobRecord[]> {
    const items = await this.scanByPkPrefix(RECOVERY_PK_PREFIX);
    return items.filter((item) => isRecoveryJobPk(String(item.pk ?? ""))).map(toRecoveryJobRecord);
  }

  async putRecoveryMessage(record: RecoveryMessageRecord): Promise<void> {
    await this.putItem({
      pk: recoveryMessagePk(record.recoveryId, record.messageId),
      recoveryId: record.recoveryId,
      messageId: record.messageId,
      shipmentId: record.shipmentId,
      failureClass: record.failureClass,
      action: record.action,
      originalPayloadJson: JSON.stringify(record.originalPayload),
      patchedPayloadJson:
        record.patchedPayload === undefined ? undefined : JSON.stringify(record.patchedPayload),
      patchVersion: record.patchVersion,
      validationResult: record.validationResult,
      replayAttempt: record.replayAttempt,
      replayResult: record.replayResult,
      reason: record.reason,
      createdAt: record.createdAt,
      [LEDGER_TTL_ATTRIBUTE]: this.expiresAt("record"),
    });
  }

  async getRecoveryMessage(
    recoveryId: string,
    messageId: string,
  ): Promise<RecoveryMessageRecord | undefined> {
    const item = await this.getItem(recoveryMessagePk(recoveryId, messageId));
    return item ? toRecoveryMessageRecord(item) : undefined;
  }

  async listRecoveryMessages(recoveryId?: string): Promise<RecoveryMessageRecord[]> {
    const items = await this.scanByPkPrefix(RECOVERY_PK_PREFIX);
    const records = items
      .filter((item) => isRecoveryMessagePk(String(item.pk ?? "")))
      .map(toRecoveryMessageRecord);
    return recoveryId ? records.filter((record) => record.recoveryId === recoveryId) : records;
  }

  async getDownstreamStatus(): Promise<DownstreamStatus> {
    const item = await this.getItem(CONFIG_PK);
    if (!item) {
      return DownstreamStatus.Healthy;
    }
    return parseEnum(
      item.downstreamStatus,
      Object.values(DownstreamStatus),
      DownstreamStatus.Healthy,
    );
  }

  async setDownstreamStatus(status: DownstreamStatus): Promise<void> {
    await this.putItem({
      pk: CONFIG_PK,
      downstreamStatus: status,
    });
  }

  async markReplayResult(
    recoveryId: string,
    messageId: string,
    result: ReplayResult.Success | ReplayResult.Failed,
  ): Promise<void> {
    const existing = await this.getRecoveryMessage(recoveryId, messageId);
    if (!existing) {
      return;
    }
    await this.putRecoveryMessage({ ...existing, replayResult: result });
  }

  async clear(): Promise<void> {
    const [quarantines, jobs, messages] = await Promise.all([
      this.listQuarantines(),
      this.listRecoveryJobs(),
      this.listRecoveryMessages(),
    ]);
    const pks = [
      ...quarantines.map((record) => quarantinePk(record.messageId)),
      ...jobs.map((job) => recoveryJobPk(job.recoveryId)),
      ...messages.map((record) => recoveryMessagePk(record.recoveryId, record.messageId)),
      CONFIG_PK,
    ];
    await this.batchDelete(pks);
  }

  private async putItem(item: Record<string, unknown>): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: omitUndefined(item),
      }),
    );
  }

  private async getItem(pk: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk },
      }),
    );
    return result.Item;
  }

  private async scanByPkPrefix(prefix: string): Promise<Record<string, unknown>[]> {
    const result = await this.doc.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: "begins_with(#pk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":prefix": prefix },
      }),
    );
    return result.Items ?? [];
  }

  private async batchDelete(pks: string[]): Promise<void> {
    for (let index = 0; index < pks.length; index += DYNAMO_BATCH_WRITE_LIMIT) {
      const slice = pks.slice(index, index + DYNAMO_BATCH_WRITE_LIMIT);
      if (slice.length === 0) {
        continue;
      }
      await this.doc.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.tableName]: slice.map((pk) => ({
              DeleteRequest: { Key: { pk } },
            })),
          },
        }),
      );
    }
  }
}

function messageKey(recoveryId: string, messageId: string): string {
  return `${recoveryId}#${messageId}`;
}

function omitUndefined(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined));
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return JSON.parse(value) as unknown;
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function toQuarantineRecord(item: Record<string, unknown>): QuarantineRecord {
  const pk = String(item.pk ?? "");
  const messageId =
    typeof item.messageId === "string"
      ? item.messageId
      : isQuarantinePk(pk)
        ? messageIdFromQuarantinePk(pk)
        : "unknown";
  return {
    messageId,
    shipmentId: typeof item.shipmentId === "string" ? item.shipmentId : undefined,
    originalPayload: parseJson(item.originalPayloadJson),
    failureClass: parseEnum(item.failureClass, Object.values(FailureClass), FailureClass.Unknown),
    action: parseEnum(item.action, Object.values(RecoveryAction), RecoveryAction.ManualReview),
    reason: String(item.reason ?? ""),
    sourceQueue: String(item.sourceQueue ?? ""),
    recoveryId: String(item.recoveryId ?? ""),
    quarantinedAt: String(item.quarantinedAt ?? ""),
  };
}

function toRecoveryJobRecord(item: Record<string, unknown>): RecoveryJobRecord {
  const pk = String(item.pk ?? "");
  const recoveryId =
    typeof item.recoveryId === "string"
      ? item.recoveryId
      : isRecoveryJobPk(pk)
        ? recoveryIdFromJobPk(pk)
        : "unknown";
  return {
    recoveryId,
    status: parseEnum(item.status, Object.values(RecoveryJobStatus), RecoveryJobStatus.Started),
    startedAt: String(item.startedAt ?? ""),
    completedAt: typeof item.completedAt === "string" ? item.completedAt : undefined,
    batchSize: Number(item.batchSize ?? 0),
    maxFailureRate: Number(item.maxFailureRate ?? 0),
    replayDelaySeconds: Number(item.replayDelaySeconds ?? 0),
    processedCount: Number(item.processedCount ?? 0),
    recoveredCount: Number(item.recoveredCount ?? 0),
    quarantinedCount: Number(item.quarantinedCount ?? 0),
    suppressedCount: Number(item.suppressedCount ?? 0),
    failureCount: Number(item.failureCount ?? 0),
    stopReason: typeof item.stopReason === "string" ? item.stopReason : undefined,
  };
}

function toRecoveryMessageRecord(item: Record<string, unknown>): RecoveryMessageRecord {
  const pk = String(item.pk ?? "");
  const fromPk = isRecoveryMessagePk(pk) ? parseRecoveryMessagePk(pk) : undefined;
  return {
    recoveryId: typeof item.recoveryId === "string" ? item.recoveryId : (fromPk?.recoveryId ?? "unknown"),
    messageId: typeof item.messageId === "string" ? item.messageId : (fromPk?.messageId ?? "unknown"),
    shipmentId: typeof item.shipmentId === "string" ? item.shipmentId : undefined,
    failureClass: parseEnum(item.failureClass, Object.values(FailureClass), FailureClass.Unknown),
    action: parseEnum(item.action, Object.values(RecoveryAction), RecoveryAction.ManualReview),
    originalPayload: parseJson(item.originalPayloadJson),
    patchedPayload:
      item.patchedPayloadJson === undefined ? undefined : parseJson(item.patchedPayloadJson),
    patchVersion: typeof item.patchVersion === "string" ? item.patchVersion : undefined,
    validationResult: typeof item.validationResult === "string" ? item.validationResult : undefined,
    replayAttempt: typeof item.replayAttempt === "number" ? item.replayAttempt : undefined,
    replayResult:
      item.replayResult === undefined
        ? undefined
        : parseEnum(item.replayResult, Object.values(ReplayResult), ReplayResult.NotSent),
    reason: typeof item.reason === "string" ? item.reason : undefined,
    createdAt: String(item.createdAt ?? ""),
  };
}
