import {
  shp001Transient,
  shp002LegacyV1,
  shp003Poison,
  shp004AlreadyDispatched,
} from "../../src/fixtures/shipments";
import { classify } from "../../src/recovery/triage";

describe("classify", () => {
  test.each([
    [
      "SHP-001 transient carrier",
      shp001Transient,
      {},
      "TRANSIENT",
      "REPLAY",
    ],
    [
      "SHP-002 legacy schema v1",
      shp002LegacyV1,
      {},
      "SCHEMA_MISMATCH",
      "PATCH",
    ],
    [
      "SHP-003 poison payload",
      shp003Poison,
      {},
      "POISON",
      "QUARANTINE",
    ],
    [
      "unrecognized payload",
      { hello: "world" },
      {},
      "UNKNOWN",
      "MANUAL_REVIEW",
    ],
    [
      "SHP-004 without completion evidence",
      shp004AlreadyDispatched,
      {},
      "UNKNOWN",
      "MANUAL_REVIEW",
    ],
    [
      "completed shipment with ledger evidence",
      shp004AlreadyDispatched,
      { shipmentCompleted: true },
      "DUPLICATE",
      "SKIP",
    ],
  ] as const)("%s", (_label, payload, context, failureClass, action) => {
    const triage = classify(payload, context);
    expect(triage.failureClass).toBe(failureClass);
    expect(triage.action).toBe(action);
    expect(triage.reason.length).toBeGreaterThan(0);
  });

  test("unknown failures never default to replay", () => {
    expect(classify({}).action).not.toBe("REPLAY");
    expect(classify("not-json").action).toBe("MANUAL_REVIEW");
  });

  test("does not treat SHP-004 as a duplicate from the id alone", () => {
    const triage = classify({
      shipmentId: "SHP-004",
      customerId: "CUS-004",
      warehouseId: "LON-01",
      service: "STANDARD",
      destinationCountry: "GB",
    });
    expect(triage.failureClass).not.toBe("DUPLICATE");
  });
});
