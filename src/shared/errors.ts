export class TransientCarrierError extends Error {
  readonly code = "TRANSIENT_CARRIER_FAILURE" as const;

  constructor(message = "Carrier dependency unavailable or timed out") {
    super(message);
    this.name = "TransientCarrierError";
  }
}

export class UnsupportedSchemaError extends Error {
  readonly code = "UNSUPPORTED_SCHEMA" as const;

  constructor(message = "Shipment payload uses an unsupported schema") {
    super(message);
    this.name = "UnsupportedSchemaError";
  }
}

export class InvalidShipmentError extends Error {
  readonly code = "INVALID_SHIPMENT" as const;

  constructor(message = "Shipment payload is invalid") {
    super(message);
    this.name = "InvalidShipmentError";
  }
}

export class PostDispatchFailure extends Error {
  readonly code = "POST_DISPATCH_FAILURE" as const;

  constructor(message = "Dispatch completed but the handler failed afterwards") {
    super(message);
    this.name = "PostDispatchFailure";
  }
}
