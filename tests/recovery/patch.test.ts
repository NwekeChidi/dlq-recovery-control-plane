import { shp001Transient, shp002LegacyV1, shp003Poison } from "../../src/fixtures/shipments";
import { migrateShipmentV1ToV2, PATCH_VERSION } from "../../src/recovery/patch";
import { validateShipmentV2 } from "../../src/recovery/validate";

describe("migrateShipmentV1ToV2", () => {
  const now = () => "2026-09-06T08:00:00.000Z";

  test("maps v1 fields onto the v2 contract", () => {
    const patch = migrateShipmentV1ToV2(shp002LegacyV1, { now });

    expect(patch.patchedPayload).toEqual({
      shipmentId: "SHP-002",
      customerId: "CUS-002",
      warehouseId: "LON-01",
      service: "NEXT_DAY",
      destinationCountry: "GB",
      schemaVersion: 2,
    });
    expect(patch.patchVersion).toBe(PATCH_VERSION);
    expect(patch.patchedAt).toBe("2026-09-06T08:00:00.000Z");
    expect(patch.reason.length).toBeGreaterThan(0);
  });

  test("preserves the original payload unchanged", () => {
    const original = { ...shp002LegacyV1 };
    const patch = migrateShipmentV1ToV2(original, { now });

    expect(patch.originalPayload).toEqual(shp002LegacyV1);
    original.customer = "MUTATED";
    expect(patch.originalPayload).toEqual(shp002LegacyV1);
    expect(patch.patchedPayload.customerId).toBe("CUS-002");
  });

  test("rejects non-v1 payloads", () => {
    expect(() => migrateShipmentV1ToV2(shp001Transient)).toThrow(/schema v1/);
  });
});

describe("validateShipmentV2", () => {
  test("accepts a valid v2 shipment", () => {
    expect(validateShipmentV2(shp001Transient)).toEqual({
      ok: true,
      shipment: {
        shipmentId: "SHP-001",
        customerId: "CUS-001",
        warehouseId: "LON-01",
        service: "NEXT_DAY",
        destinationCountry: "GB",
      },
    });
  });

  test("accepts the patched SHP-002 payload", () => {
    const patch = migrateShipmentV1ToV2(shp002LegacyV1, {
      now: () => "2026-09-06T08:00:00.000Z",
    });
    const result = validateShipmentV2(patch.patchedPayload);
    expect(result.ok).toBe(true);
  });

  test("rejects a poison payload", () => {
    const result = validateShipmentV2(shp003Poison);
    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(/invalid|required/i),
    });
  });

  test("rejects an invalid patched mapping", () => {
    const patch = migrateShipmentV1ToV2({
      shipment_id: "SHP-999",
      customer: "CUS-999",
      warehouse: "UNKNOWN",
      shipping_service: "TELEPORT",
      country: "??",
      schemaVersion: 1,
    });
    expect(validateShipmentV2(patch.patchedPayload).ok).toBe(false);
  });
});
