import { FailureCode } from "./failure";

export class TransientCarrierError extends Error {
  readonly code = FailureCode.TransientCarrierFailure;

  constructor(message = "Carrier dependency unavailable or timed out") {
    super(message);
    this.name = "TransientCarrierError";
  }
}

export class UnsupportedSchemaError extends Error {
  readonly code = FailureCode.UnsupportedSchema;

  constructor(message = "Shipment payload uses an unsupported schema") {
    super(message);
    this.name = "UnsupportedSchemaError";
  }
}

export class InvalidShipmentError extends Error {
  readonly code = FailureCode.InvalidShipment;

  constructor(message = "Shipment payload is invalid") {
    super(message);
    this.name = "InvalidShipmentError";
  }
}

export class PostDispatchFailure extends Error {
  readonly code = FailureCode.PostDispatchFailure;

  constructor(message = "Dispatch completed but the handler failed afterwards") {
    super(message);
    this.name = "PostDispatchFailure";
  }
}
