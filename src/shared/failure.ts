export enum FailureCode {
  TransientCarrierFailure = "TRANSIENT_CARRIER_FAILURE",
  UnsupportedSchema = "UNSUPPORTED_SCHEMA",
  InvalidShipment = "INVALID_SHIPMENT",
  PostDispatchFailure = "POST_DISPATCH_FAILURE",
}

export enum FailureClass {
  Transient = "TRANSIENT",
  SchemaMismatch = "SCHEMA_MISMATCH",
  Poison = "POISON",
  Duplicate = "DUPLICATE",
  Unknown = "UNKNOWN",
}

export enum RecoveryAction {
  Replay = "REPLAY",
  Patch = "PATCH",
  Quarantine = "QUARANTINE",
  Skip = "SKIP",
  ManualReview = "MANUAL_REVIEW",
}

export interface TriageResult {
  failureClass: FailureClass;
  action: RecoveryAction;
  reason: string;
}

export interface FailureContext {
  errorName?: string;
  errorCode?: FailureCode;
  /** Durable dispatch completion from P6+. Absent means "not known". */
  shipmentCompleted?: boolean;
}

export const ACTION_BY_FAILURE_CLASS: Record<FailureClass, RecoveryAction> = {
  [FailureClass.Transient]: RecoveryAction.Replay,
  [FailureClass.SchemaMismatch]: RecoveryAction.Patch,
  [FailureClass.Poison]: RecoveryAction.Quarantine,
  [FailureClass.Duplicate]: RecoveryAction.Skip,
  [FailureClass.Unknown]: RecoveryAction.ManualReview,
};
