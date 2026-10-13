import { FailureCode } from "./failure";

export const KNOWN_WAREHOUSES = ["LON-01"] as const;
export const KNOWN_SERVICES = ["NEXT_DAY", "STANDARD"] as const;
export const KNOWN_COUNTRIES = ["GB"] as const;

export type WarehouseId = (typeof KNOWN_WAREHOUSES)[number];
export type ShipmentService = (typeof KNOWN_SERVICES)[number];
export type DestinationCountry = (typeof KNOWN_COUNTRIES)[number];

export const SHIPMENT_SCENARIOS = [
  FailureCode.TransientCarrierFailure,
  FailureCode.PostDispatchFailure,
] as const;

export type ShipmentScenario = (typeof SHIPMENT_SCENARIOS)[number];

export function isShipmentScenario(value: unknown): value is ShipmentScenario {
  return SHIPMENT_SCENARIOS.some((scenario) => scenario === value);
}

export interface ShipmentV1 {
  shipment_id: string;
  customer: string;
  warehouse: string;
  shipping_service: string;
  country: string;
  schemaVersion: 1;
}

export interface ShipmentV2 {
  shipmentId: string;
  customerId: string;
  warehouseId: WarehouseId;
  service: ShipmentService;
  destinationCountry: DestinationCountry;
  schemaVersion?: 2;
  scenario?: ShipmentScenario;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isShipmentV1(payload: unknown): payload is ShipmentV1 {
  return isRecord(payload) && (payload.schemaVersion === 1 || "shipment_id" in payload);
}
