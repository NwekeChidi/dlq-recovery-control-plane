import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { isShipmentPk, shipmentIdFromPk, shipmentPk } from "./dynamodb";

export enum ShipmentDispatchStatus {
  Processing = "PROCESSING",
  Completed = "COMPLETED",
}

export enum ClaimOutcome {
  Claimed = "claimed",
  AlreadyCompleted = "already_completed",
  InProgress = "in_progress",
}

export interface ShipmentState {
  shipmentId: string;
  status: ShipmentDispatchStatus;
  createdAt: string;
  updatedAt: string;
  result?: string;
}

export type ClaimResult =
  | { outcome: ClaimOutcome.Claimed }
  | { outcome: ClaimOutcome.AlreadyCompleted; result?: string }
  | { outcome: ClaimOutcome.InProgress };

export interface ShipmentLedger {
  claimShipment(shipmentId: string, now?: string): Promise<ClaimResult>;
  completeShipment(shipmentId: string, result: string, now?: string): Promise<void>;
  getShipmentState(shipmentId: string): Promise<ShipmentState | undefined>;
  listShipmentStates(): Promise<ShipmentState[]>;
  clearShipments(): Promise<void>;
}

export class InMemoryShipmentLedger implements ShipmentLedger {
  private readonly items = new Map<string, ShipmentState>();

  async claimShipment(shipmentId: string, now = new Date().toISOString()): Promise<ClaimResult> {
    const existing = this.items.get(shipmentId);
    if (!existing) {
      this.items.set(shipmentId, {
        shipmentId,
        status: ShipmentDispatchStatus.Processing,
        createdAt: now,
        updatedAt: now,
      });
      return { outcome: ClaimOutcome.Claimed };
    }
    if (existing.status === ShipmentDispatchStatus.Completed) {
      return { outcome: ClaimOutcome.AlreadyCompleted, result: existing.result };
    }
    return { outcome: ClaimOutcome.InProgress };
  }

  async completeShipment(
    shipmentId: string,
    result: string,
    now = new Date().toISOString(),
  ): Promise<void> {
    const existing = this.items.get(shipmentId);
    if (!existing || existing.status !== ShipmentDispatchStatus.Processing) {
      throw new Error(`Cannot complete shipment ${shipmentId}`);
    }
    this.items.set(shipmentId, {
      ...existing,
      status: ShipmentDispatchStatus.Completed,
      updatedAt: now,
      result,
    });
  }

  async getShipmentState(shipmentId: string): Promise<ShipmentState | undefined> {
    return this.items.get(shipmentId);
  }

  async listShipmentStates(): Promise<ShipmentState[]> {
    return [...this.items.values()];
  }

  async clearShipments(): Promise<void> {
    this.items.clear();
  }
}

export class DynamoShipmentLedger implements ShipmentLedger {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  static fromTableName(tableName: string): DynamoShipmentLedger {
    return new DynamoShipmentLedger(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName,
    );
  }

  async claimShipment(shipmentId: string, now = new Date().toISOString()): Promise<ClaimResult> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: shipmentPk(shipmentId),
            shipmentId,
            status: ShipmentDispatchStatus.Processing,
            createdAt: now,
            updatedAt: now,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return { outcome: ClaimOutcome.Claimed };
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
      const current = await this.getShipmentState(shipmentId);
      if (current?.status === ShipmentDispatchStatus.Completed) {
        return { outcome: ClaimOutcome.AlreadyCompleted, result: current.result };
      }
      return { outcome: ClaimOutcome.InProgress };
    }
  }

  async completeShipment(
    shipmentId: string,
    result: string,
    now = new Date().toISOString(),
  ): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: shipmentPk(shipmentId) },
        ConditionExpression: "#status = :processing",
        UpdateExpression: "SET #status = :completed, updatedAt = :now, #result = :result",
        ExpressionAttributeNames: {
          "#status": "status",
          "#result": "result",
        },
        ExpressionAttributeValues: {
          ":processing": ShipmentDispatchStatus.Processing,
          ":completed": ShipmentDispatchStatus.Completed,
          ":now": now,
          ":result": result,
        },
      }),
    );
  }

  async getShipmentState(shipmentId: string): Promise<ShipmentState | undefined> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: shipmentPk(shipmentId) },
      }),
    );
    return result.Item ? toShipmentState(result.Item) : undefined;
  }

  async listShipmentStates(): Promise<ShipmentState[]> {
    const result = await this.doc.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: "begins_with(#pk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":prefix": "SHIPMENT#" },
      }),
    );
    return (result.Items ?? []).map(toShipmentState);
  }

  async clearShipments(): Promise<void> {
    const items = await this.listShipmentStates();
    if (items.length === 0) {
      return;
    }
    await this.doc.send(
      new BatchWriteCommand({
        RequestItems: {
          [this.tableName]: items.map((item) => ({
            DeleteRequest: { Key: { pk: shipmentPk(item.shipmentId) } },
          })),
        },
      }),
    );
  }
}

function toShipmentState(item: Record<string, unknown>): ShipmentState {
  const pk = typeof item.pk === "string" ? item.pk : "";
  const shipmentId =
    typeof item.shipmentId === "string"
      ? item.shipmentId
      : isShipmentPk(pk)
        ? shipmentIdFromPk(pk)
        : "unknown";
  return {
    shipmentId,
    status: parseShipmentDispatchStatus(item.status),
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
    result: typeof item.result === "string" ? item.result : undefined,
  };
}

function parseShipmentDispatchStatus(value: unknown): ShipmentDispatchStatus {
  return value === ShipmentDispatchStatus.Completed
    ? ShipmentDispatchStatus.Completed
    : ShipmentDispatchStatus.Processing;
}
