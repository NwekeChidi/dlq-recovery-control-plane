import {
  ACTION_BY_FAILURE_CLASS,
  FailureClass,
  FailureCode,
  type FailureContext,
  type TriageResult,
} from "../shared/failure";
import {
  KNOWN_COUNTRIES,
  KNOWN_SERVICES,
  KNOWN_WAREHOUSES,
  isRecord,
  isShipmentV1,
} from "../shared/shipment";

export function classify(payload: unknown, context: FailureContext = {}): TriageResult {
  if (context.shipmentCompleted === true) {
    return result(
      FailureClass.Duplicate,
      "Dispatch already completed; replay would send the shipment twice",
    );
  }

  if (isShipmentV1(payload) || context.errorCode === FailureCode.UnsupportedSchema) {
    return result(
      FailureClass.SchemaMismatch,
      "Payload uses shipment schema v1; patch to v2 before replay",
    );
  }

  if (isPoisonPayload(payload) || context.errorCode === FailureCode.InvalidShipment) {
    return result(
      FailureClass.Poison,
      "Payload fails current business rules; do not invent a correction",
    );
  }

  if (
    isTransientPayload(payload) ||
    context.errorCode === FailureCode.TransientCarrierFailure
  ) {
    return result(
      FailureClass.Transient,
      "Carrier dependency failed or timed out; safe to replay when healthy",
    );
  }

  return result(
    FailureClass.Unknown,
    "Failure is not classified; hold for manual review instead of replaying",
  );
}

function result(failureClass: FailureClass, reason: string): TriageResult {
  return {
    failureClass,
    action: ACTION_BY_FAILURE_CLASS[failureClass],
    reason,
  };
}

function isPoisonPayload(payload: unknown): boolean {
  if (!isRecord(payload) || isShipmentV1(payload) || !looksLikeCurrentShipment(payload)) {
    return false;
  }

  if (typeof payload.customerId !== "string" || payload.customerId.trim() === "") {
    return true;
  }

  return (
    !isAllowed(payload.warehouseId, KNOWN_WAREHOUSES) ||
    !isAllowed(payload.service, KNOWN_SERVICES) ||
    !isAllowed(payload.destinationCountry, KNOWN_COUNTRIES)
  );
}

function looksLikeCurrentShipment(payload: Record<string, unknown>): boolean {
  return (
    "shipmentId" in payload ||
    "customerId" in payload ||
    "warehouseId" in payload ||
    "service" in payload ||
    "destinationCountry" in payload
  );
}

function isTransientPayload(payload: unknown): boolean {
  return isRecord(payload) && payload.scenario === FailureCode.TransientCarrierFailure;
}

function isAllowed(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}
