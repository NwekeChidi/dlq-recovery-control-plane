import {
  shp001Transient,
  shp002LegacyV1,
  shp003Poison,
  shp004AlreadyDispatched,
} from "../../src/fixtures/shipments";
import { classify } from "../../src/recovery/triage";
import { FailureClass, FailureCode, RecoveryAction } from "../../src/shared/failure";

describe("classify", () => {
  test.each([
    [
      "SHP-001 transient carrier",
      shp001Transient,
      {},
      FailureClass.Transient,
      RecoveryAction.Replay,
    ],
    [
      "SHP-002 legacy schema v1",
      shp002LegacyV1,
      {},
      FailureClass.SchemaMismatch,
      RecoveryAction.Patch,
    ],
    [
      "SHP-003 poison payload",
      shp003Poison,
      {},
      FailureClass.Poison,
      RecoveryAction.Quarantine,
    ],
    [
      "unrecognized payload",
      { hello: "world" },
      {},
      FailureClass.Unknown,
      RecoveryAction.ManualReview,
    ],
    [
      "SHP-004 without completion evidence",
      shp004AlreadyDispatched,
      {},
      FailureClass.Unknown,
      RecoveryAction.ManualReview,
    ],
    [
      "completed shipment with ledger evidence",
      shp004AlreadyDispatched,
      { shipmentCompleted: true },
      FailureClass.Duplicate,
      RecoveryAction.Skip,
    ],
  ] as const)("%s", (_label, payload, context, failureClass, action) => {
    const triage = classify(payload, context);
    expect(triage.failureClass).toBe(failureClass);
    expect(triage.action).toBe(action);
    expect(triage.reason.length).toBeGreaterThan(0);
  });

  test("classifies from reusable failure codes when the payload is opaque", () => {
    expect(classify({}, { errorCode: FailureCode.UnsupportedSchema }).failureClass).toBe(
      FailureClass.SchemaMismatch,
    );
    expect(classify({}, { errorCode: FailureCode.InvalidShipment }).failureClass).toBe(
      FailureClass.Poison,
    );
    expect(classify({}, { errorCode: FailureCode.TransientCarrierFailure }).failureClass).toBe(
      FailureClass.Transient,
    );
  });

  test("unknown failures never default to replay", () => {
    expect(classify({}).action).not.toBe(RecoveryAction.Replay);
    expect(classify("not-json").action).toBe(RecoveryAction.ManualReview);
  });

  test("does not treat SHP-004 as a duplicate from the id alone", () => {
    const triage = classify({
      shipmentId: "SHP-004",
      customerId: "CUS-004",
      warehouseId: "LON-01",
      service: "STANDARD",
      destinationCountry: "GB",
    });
    expect(triage.failureClass).not.toBe(FailureClass.Duplicate);
  });
});
