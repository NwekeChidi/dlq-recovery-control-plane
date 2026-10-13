import { InvalidShipmentError } from "../shared/errors";
import {
  KNOWN_COUNTRIES,
  KNOWN_SERVICES,
  KNOWN_WAREHOUSES,
  isRecord,
  type ShipmentV2,
} from "../shared/shipment";

export type ValidationResult =
  | { ok: true; shipment: ShipmentV2 }
  | { ok: false; reason: string };

export function validateShipmentV2(payload: unknown): ValidationResult {
  if (!isRecord(payload)) {
    return { ok: false, reason: "Shipment payload must be an object" };
  }

  if (payload.schemaVersion !== undefined && payload.schemaVersion !== 2) {
    return { ok: false, reason: "schemaVersion must be 2" };
  }

  try {
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

    return { ok: true, shipment };
  } catch (error) {
    if (error instanceof InvalidShipmentError) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
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
