export const SHIPMENT_PK_PREFIX = "SHIPMENT#";
export const QUARANTINE_PK_PREFIX = "QUARANTINE#";
export const RECOVERY_PK_PREFIX = "RECOVERY#";
export const RECOVERY_MESSAGE_INFIX = "#MSG#";

export function shipmentPk(shipmentId: string): string {
  return `${SHIPMENT_PK_PREFIX}${shipmentId}`;
}

export function isShipmentPk(pk: string): boolean {
  return pk.startsWith(SHIPMENT_PK_PREFIX);
}

export function shipmentIdFromPk(pk: string): string {
  return pk.slice(SHIPMENT_PK_PREFIX.length);
}

export function quarantinePk(messageId: string): string {
  return `${QUARANTINE_PK_PREFIX}${messageId}`;
}

export function isQuarantinePk(pk: string): boolean {
  return pk.startsWith(QUARANTINE_PK_PREFIX);
}

export function messageIdFromQuarantinePk(pk: string): string {
  return pk.slice(QUARANTINE_PK_PREFIX.length);
}

export function recoveryJobPk(recoveryId: string): string {
  return `${RECOVERY_PK_PREFIX}${recoveryId}`;
}

export function recoveryMessagePk(recoveryId: string, messageId: string): string {
  return `${RECOVERY_PK_PREFIX}${recoveryId}${RECOVERY_MESSAGE_INFIX}${messageId}`;
}

export function isRecoveryJobPk(pk: string): boolean {
  return pk.startsWith(RECOVERY_PK_PREFIX) && !pk.includes(RECOVERY_MESSAGE_INFIX);
}

export function isRecoveryMessagePk(pk: string): boolean {
  return pk.startsWith(RECOVERY_PK_PREFIX) && pk.includes(RECOVERY_MESSAGE_INFIX);
}

export function recoveryIdFromJobPk(pk: string): string {
  return pk.slice(RECOVERY_PK_PREFIX.length);
}

export function parseRecoveryMessagePk(pk: string): { recoveryId: string; messageId: string } {
  const rest = pk.slice(RECOVERY_PK_PREFIX.length);
  const index = rest.indexOf(RECOVERY_MESSAGE_INFIX);
  return {
    recoveryId: rest.slice(0, index),
    messageId: rest.slice(index + RECOVERY_MESSAGE_INFIX.length),
  };
}
