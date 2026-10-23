import { describe, expect, it } from "vitest";
import {
  LEAD_PAGE_SIZE_MAX,
  LEAD_STATUSES,
  assertLeadTransition,
  identityHashesFor,
  leadListQuerySchema,
  likePattern,
  normalizePaymentReference,
  normalizeTaxId,
  offeredTransitions,
  serviceRequestInputSchema,
  type LeadStatus,
} from "@isela/crm";
import { expectDomainErrorSync } from "../support/assertions.ts";
import { TEST_CRM_CONFIG } from "../support/fixtures.ts";

const human = (reason: string | null = null) => ({
  sourceKind: "INTERNAL_INBOUND" as const,
  hasContactableContact: true,
  performedByHuman: true,
  reason,
});

describe("lead pipeline transitions (existing state machine)", () => {
  it("walks the documented happy path to WON", () => {
    const path: LeadStatus[] = [
      "DISCOVERED",
      "RESEARCHING",
      "QUALIFIED",
      "OUTREACH_DRAFTED",
      "CONTACTED",
      "RESPONSE",
      "QUALIFIED_OPPORTUNITY",
      "QUOTE_REQUEST",
      "QUOTE_SENT",
      "NEGOTIATION",
      "WON",
    ];
    for (let i = 1; i < path.length; i++) {
      const from = path[i - 1] as LeadStatus;
      const to = path[i] as LeadStatus;
      expect(() => {
        assertLeadTransition(from, to, human());
      }, `${from} → ${to}`).not.toThrow();
    }
  });

  it("rejects forged jumps and terminal changes", () => {
    for (const [from, to] of [
      ["DISCOVERED", "WON"],
      ["QUALIFIED", "QUOTE_SENT"],
      ["WON", "LOST"],
      ["LOST", "WON"],
    ] as const) {
      expectDomainErrorSync(() => {
        assertLeadTransition(from, to, human("Grund"));
      }, "INVALID_STATE_TRANSITION");
    }
  });

  it("requires a reason for LOST and when reopening", () => {
    expectDomainErrorSync(() => {
      assertLeadTransition("DISCOVERED", "LOST", human());
    }, "VALIDATION_FAILED");
    expect(() => {
      assertLeadTransition("LOST", "FOLLOW_UP", human("Neue Anfrage erhalten"));
    }).not.toThrow();
  });

  it("offers only allowed transitions, respecting the inbound shortcut", () => {
    expect(offeredTransitions("DISCOVERED", "INTERNAL_INBOUND")).toContain("QUOTE_REQUEST");
    expect(offeredTransitions("DISCOVERED", "BUSINESS_SEARCH")).not.toContain("QUOTE_REQUEST");
    expect(offeredTransitions("WON", "INTERNAL_INBOUND")).toEqual([]);
    for (const status of LEAD_STATUSES) {
      for (const to of offeredTransitions(status, "INTERNAL_INBOUND")) {
        expect(() => {
          assertLeadTransition(status, to, human("Begründung"));
        }).not.toThrow();
      }
    }
  });
});

describe("lead list query (validated filters, bounded pagination)", () => {
  it("applies defaults", () => {
    expect(leadListQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 25 });
  });

  it.each([
    ["page size above the maximum", { pageSize: LEAD_PAGE_SIZE_MAX + 1 }],
    ["page zero", { page: 0 }],
    ["huge page", { page: 10_001 }],
    ["fractional page", { page: 1.5 }],
    ["unknown filter (mass assignment)", { orderBy: "email" }],
    ["unknown status", { status: ["HACKED"] }],
    ["SQL in enum filter", { customerType: "PRIVATE' OR '1'='1" }],
    ["forged service area id", { serviceAreaId: "1; DROP TABLE lead" }],
    ["invalid date", { createdFrom: "2026-13-01" }],
    ["reversed date range", { createdFrom: "2026-09-10", createdTo: "2026-09-01" }],
    ["oversized search", { q: "x".repeat(101) }],
    ["slug with SQL", { sourceKey: "a' --" }],
  ])("rejects %s", (_label, input) => {
    expect(leadListQuerySchema.safeParse(input).success).toBe(false);
  });

  it("accepts search text with SQL metacharacters (it is bound as a parameter)", () => {
    expect(leadListQuerySchema.parse({ q: "' OR 1=1 --" }).q).toBe("' OR 1=1 --");
  });

  it("escapes LIKE wildcards so search text matches literally", () => {
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });
});

describe("customer-type specific request validation", () => {
  const base = {
    fullName: "Erika Muster",
    email: "erika@example.test",
    street: "Musterweg",
    houseNumber: "3",
    postalCode: "12345",
    city: "Musterstadt",
    serviceCategoryKey: "office-cleaning",
    propertyType: "OFFICE",
    frequency: "WEEKLY",
    privacyNoticeAcknowledged: true,
    privacyNoticeVersion: "v1",
  };

  it("requires a company for business and property management, not for private", () => {
    expect(serviceRequestInputSchema.safeParse({ ...base, customerType: "PRIVATE" }).success).toBe(
      true,
    );
    for (const customerType of ["BUSINESS", "PROPERTY_MANAGEMENT"]) {
      expect(serviceRequestInputSchema.safeParse({ ...base, customerType }).success).toBe(false);
      expect(
        serviceRequestInputSchema.safeParse({ ...base, customerType, companyName: "Muster GmbH" })
          .success,
      ).toBe(true);
    }
  });

  it("allows a property count only for property management", () => {
    const pm = { ...base, customerType: "PROPERTY_MANAGEMENT", companyName: "HV GmbH" };
    expect(serviceRequestInputSchema.safeParse({ ...pm, numberOfProperties: 12 }).success).toBe(
      true,
    );
    expect(serviceRequestInputSchema.safeParse({ ...pm, numberOfProperties: 0 }).success).toBe(
      false,
    );
    expect(
      serviceRequestInputSchema.safeParse({
        ...base,
        customerType: "PRIVATE",
        numberOfProperties: 3,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["latitude", { latitude: 51.5 }],
    ["longitude", { longitude: 7.1 }],
    ["serviceAreaId", { serviceAreaId: "11111111-1111-4111-8111-111111111111" }],
    ["serviceAreaStatus", { serviceAreaStatus: "AVAILABLE" }],
    ["geocodingStatus", { geocodingStatus: "MANUAL" }],
    ["customerId", { customerId: "11111111-1111-4111-8111-111111111111" }],
    ["status", { status: "WON" }],
    ["ownerUserId", { ownerUserId: "u1" }],
  ])("never accepts %s from the browser", (_label, forged) => {
    expect(
      serviceRequestInputSchema.safeParse({ ...base, customerType: "PRIVATE", ...forged }).success,
    ).toBe(false);
  });
});

describe("identity normalisation for duplicate detection", () => {
  const kinds = (input: Parameters<typeof identityHashesFor>[1]) =>
    identityHashesFor(TEST_CRM_CONFIG, input);

  it("treats spelling variants of the same identity as equal", () => {
    expect(kinds({ email: " Erika@Example.TEST " })).toEqual(
      kinds({ email: "erika@example.test" }),
    );
    expect(kinds({ taxId: "DE 123.456-789" })).toEqual(kinds({ taxId: "de123456789" }));
    expect(kinds({ paymentReference: "DE89 3704 0044 0532 0130 00" })).toEqual(
      kinds({ paymentReference: "de89370400440532013000" }),
    );
    expect(kinds({ phone: "0209 123456" })).toEqual(kinds({ phone: "+49 209 123456" }));
  });

  it("keeps identity kinds apart", () => {
    const [tax] = kinds({ taxId: "X1" });
    const [payment] = kinds({ paymentReference: "X1" });
    expect(tax?.valueHash).not.toBe(payment?.valueHash);
    expect(normalizeTaxId(" de-1 ")).toBe("DE1");
    expect(normalizePaymentReference("de 1.2-3")).toBe("DE123");
  });
});
