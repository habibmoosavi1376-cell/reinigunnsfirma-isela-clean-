import { describe, expect, it } from "vitest";
import { geoPointSchema, serviceAreaInputSchema } from "@isela/catalog";

const square = [
  [
    [
      [7.0, 51.4],
      [7.2, 51.4],
      [7.2, 51.6],
      [7.0, 51.6],
      [7.0, 51.4],
    ],
  ],
];

describe("service area configuration", () => {
  it("accepts a circle with centre and radius", () => {
    const result = serviceAreaInputSchema.safeParse({
      kind: "CIRCLE",
      key: "any-market-50km",
      name: "Any market 50 km",
      center: { latitude: 51.5, longitude: 7.1 },
      radiusM: 50_000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a closed multipolygon", () => {
    const result = serviceAreaInputSchema.safeParse({
      kind: "POLYGON",
      key: "region-a",
      name: "Region A",
      coordinates: square,
    });
    expect(result.success).toBe(true);
  });

  it("rejects mixing circle and polygon fields", () => {
    const result = serviceAreaInputSchema.safeParse({
      kind: "CIRCLE",
      key: "mixed",
      name: "Mixed",
      center: { latitude: 51.5, longitude: 7.1 },
      radiusM: 1000,
      coordinates: square,
    });
    expect(result.success).toBe(false);
  });

  it.each([0, -1, 1_000_001, 12.5])("rejects radius %s", (radiusM) => {
    const result = serviceAreaInputSchema.safeParse({
      kind: "CIRCLE",
      key: "bad-radius",
      name: "Bad",
      center: { latitude: 51.5, longitude: 7.1 },
      radiusM,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unclosed polygon rings", () => {
    const open = [
      [
        [
          [7.0, 51.4],
          [7.2, 51.4],
          [7.2, 51.6],
          [7.0, 51.6],
        ],
      ],
    ];
    const result = serviceAreaInputSchema.safeParse({
      kind: "POLYGON",
      key: "open-ring",
      name: "Open",
      coordinates: open,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-slug keys", () => {
    const result = serviceAreaInputSchema.safeParse({
      kind: "CIRCLE",
      key: "Not A Slug",
      name: "x",
      center: { latitude: 51.5, longitude: 7.1 },
      radiusM: 10,
    });
    expect(result.success).toBe(false);
  });

  it.each([
    { latitude: 91, longitude: 0 },
    { latitude: -91, longitude: 0 },
    { latitude: 0, longitude: 181 },
    { latitude: 0, longitude: -181 },
  ])("rejects out-of-range coordinates %o", (point) => {
    expect(geoPointSchema.safeParse(point).success).toBe(false);
  });
});
