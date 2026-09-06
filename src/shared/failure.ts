export type FailureClass =
  | "TRANSIENT"
  | "SCHEMA_MISMATCH"
  | "POISON"
  | "DUPLICATE"
  | "UNKNOWN";

export type RecoveryAction =
  | "REPLAY"
  | "PATCH"
  | "QUARANTINE"
  | "SKIP"
  | "MANUAL_REVIEW";

export interface TriageResult {
  failureClass: FailureClass;
  action: RecoveryAction;
  reason: string;
}

export interface FailureContext {
  errorName?: string;
  errorCode?: string;
  /** Durable dispatch completion from P6+. Absent means "not known". */
  shipmentCompleted?: boolean;
}

export const ACTION_BY_FAILURE_CLASS: Record<FailureClass, RecoveryAction> = {
  TRANSIENT: "REPLAY",
  SCHEMA_MISMATCH: "PATCH",
  POISON: "QUARANTINE",
  DUPLICATE: "SKIP",
  UNKNOWN: "MANUAL_REVIEW",
};
