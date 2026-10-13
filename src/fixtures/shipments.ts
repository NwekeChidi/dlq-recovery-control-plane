import { FailureCode } from "../shared/failure";
import type { ShipmentV1, ShipmentV2 } from "../shared/shipment";

/** Carrier down or carrier timed out — one recovery class: replay. */
export const shp001Transient: ShipmentV2 = {
  shipmentId: "SHP-001",
  customerId: "CUS-001",
  warehouseId: "LON-01",
  service: "NEXT_DAY",
  destinationCountry: "GB",
  scenario: FailureCode.TransientCarrierFailure,
};

export const shp002LegacyV1: ShipmentV1 = {
  shipment_id: "SHP-002",
  customer: "CUS-002",
  warehouse: "LON-01",
  shipping_service: "NEXT_DAY",
  country: "GB",
  schemaVersion: 1,
};

export const shp003Poison = {
  shipmentId: "SHP-003",
  customerId: null,
  warehouseId: "UNKNOWN",
  service: "TELEPORT",
  destinationCountry: "??",
};

export const shp004AlreadyDispatched: ShipmentV2 = {
  shipmentId: "SHP-004",
  customerId: "CUS-004",
  warehouseId: "LON-01",
  service: "STANDARD",
  destinationCountry: "GB",
  schemaVersion: 2,
};

export const DEMO_SHIPMENTS = [
  shp001Transient,
  shp002LegacyV1,
  shp003Poison,
  shp004AlreadyDispatched,
] as const;
