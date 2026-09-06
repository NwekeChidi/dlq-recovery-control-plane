import {
  InvalidShipmentError,
  PostDispatchFailure,
  TransientCarrierError,
  UnsupportedSchemaError,
} from "../shared/errors";
import {
  KNOWN_COUNTRIES,
  KNOWN_SERVICES,
  KNOWN_WAREHOUSES,
  isRecord,
  isShipmentV1,
  type ShipmentV2,
} from "../shared/shipment";

export interface ProcessShipmentOptions {
  recoveryId?: string;
}

export async function processShipment(
  payload: unknown,
  options: ProcessShipmentOptions = {},
): Promise<ShipmentV2> {
  if (isShipmentV1(payload)) {
    throw new UnsupportedSchemaError("Legacy shipment schema v1 is not supported");
  }

  const shipment = parseShipmentV2(payload);

  // Covers carrier unavailable and carrier timeout — same recovery: replay.
  if (
    shipment.scenario === "TRANSIENT_CARRIER_FAILURE" &&
    options.recoveryId === undefined
  ) {
    throw new TransientCarrierError();
  }

  // Simulated warehouse/carrier dispatch. P6 will persist this in DynamoDB.
  if (shipment.shipmentId === "SHP-004" || shipment.scenario === "POST_DISPATCH_FAILURE") {
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

  if (
    payload.scenario === "TRANSIENT_CARRIER_FAILURE" ||
    payload.scenario === "POST_DISPATCH_FAILURE"
  ) {
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
