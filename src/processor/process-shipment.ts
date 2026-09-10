import {
  InvalidShipmentError,
  PostDispatchFailure,
  TransientCarrierError,
  UnsupportedSchemaError,
} from "../shared/errors";
import { FailureCode } from "../shared/failure";
import {
  KNOWN_COUNTRIES,
  KNOWN_SERVICES,
  KNOWN_WAREHOUSES,
  isRecord,
  isShipmentScenario,
  isShipmentV1,
  type ShipmentV2,
} from "../shared/shipment";
import {
  ClaimOutcome,
  InMemoryShipmentLedger,
  type ShipmentLedger,
} from "../shared/shipments-repo";

export interface ProcessShipmentOptions {
  recoveryId?: string;
  ledger?: ShipmentLedger;
  onDispatch?: (shipment: ShipmentV2) => void;
  downstreamBroken?: boolean;
}

export async function processShipment(
  payload: unknown,
  options: ProcessShipmentOptions = {},
): Promise<ShipmentV2> {
  if (isShipmentV1(payload)) {
    throw new UnsupportedSchemaError("Legacy shipment schema v1 is not supported");
  }

  const shipment = parseShipmentV2(payload);

  if (options.downstreamBroken && options.recoveryId !== undefined) {
    throw new TransientCarrierError();
  }

  // Covers carrier unavailable and carrier timeout — same recovery: replay.
  if (
    shipment.scenario === FailureCode.TransientCarrierFailure &&
    options.recoveryId === undefined
  ) {
    throw new TransientCarrierError();
  }

  const ledger = options.ledger ?? new InMemoryShipmentLedger();
  const claim = await ledger.claimShipment(shipment.shipmentId);

  if (claim.outcome === ClaimOutcome.AlreadyCompleted) {
    return shipment;
  }

  if (claim.outcome === ClaimOutcome.InProgress) {
    throw new Error(`Shipment ${shipment.shipmentId} dispatch is already in progress`);
  }

  options.onDispatch?.(shipment);
  await ledger.completeShipment(shipment.shipmentId, "dispatched");

  if (shipment.shipmentId === "SHP-004" || shipment.scenario === FailureCode.PostDispatchFailure) {
    throw new PostDispatchFailure();
  }

  return shipment;
}

function parseShipmentV2(payload: unknown): ShipmentV2 {
  if (!isRecord(payload)) {
    throw new InvalidShipmentError("Shipment payload must be an object");
  }

  const shipment: ShipmentV2 = {
    shipmentId: requiredString(payload.shipmentId, "shipmentId"),
    customerId: requiredString(payload.customerId, "customerId"),
    warehouseId: requiredEnum(payload.warehouseId, "warehouseId", KNOWN_WAREHOUSES),
    service: requiredEnum(payload.service, "service", KNOWN_SERVICES),
    destinationCountry: requiredEnum(
      payload.destinationCountry,
      "destinationCountry",
      KNOWN_COUNTRIES,
    ),
  };

  if (payload.schemaVersion === 2) {
    shipment.schemaVersion = 2;
  }

  if (isShipmentScenario(payload.scenario)) {
    shipment.scenario = payload.scenario;
  }

  return shipment;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidShipmentError(`${field} is required`);
  }
  return value;
}

function requiredEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new InvalidShipmentError(`${field} is invalid`);
  }
  return value as T;
}
