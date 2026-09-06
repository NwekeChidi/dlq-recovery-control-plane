import { isShipmentV1, type ShipmentV1, type ShipmentV2 } from "../shared/shipment";

export const PATCH_VERSION = "shipment-v1-to-v2" as const;

export interface PatchResult {
  originalPayload: unknown;
  patchedPayload: ShipmentV2;
  patchVersion: typeof PATCH_VERSION;
  patchedAt: string;
  reason: string;
}

export interface PatchOptions {
  now?: () => string;
}

export function migrateShipmentV1ToV2(
  payload: unknown,
  options: PatchOptions = {},
): PatchResult {
  if (!isShipmentV1(payload)) {
    throw new Error("Patch shipment-v1-to-v2 requires a schema v1 payload");
  }

  const originalPayload = structuredClone(payload);
  const patchedAt = (options.now ?? (() => new Date().toISOString()))();

  return {
    originalPayload,
    patchedPayload: mapV1ToV2(payload),
    patchVersion: PATCH_VERSION,
    patchedAt,
    reason: "Migrate legacy shipment field names to the current v2 contract",
  };
}

function mapV1ToV2(payload: ShipmentV1): ShipmentV2 {
  return {
    shipmentId: payload.shipment_id,
    customerId: payload.customer,
    warehouseId: payload.warehouse as ShipmentV2["warehouseId"],
    service: payload.shipping_service as ShipmentV2["service"],
    destinationCountry: payload.country as ShipmentV2["destinationCountry"],
    schemaVersion: 2,
  };
}
