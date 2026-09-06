export const SHIPMENT_PK_PREFIX = "SHIPMENT#";

export function shipmentPk(shipmentId: string): string {
  return `${SHIPMENT_PK_PREFIX}${shipmentId}`;
}

export function isShipmentPk(pk: string): boolean {
  return pk.startsWith(SHIPMENT_PK_PREFIX);
}

export function shipmentIdFromPk(pk: string): string {
  return pk.slice(SHIPMENT_PK_PREFIX.length);
}
