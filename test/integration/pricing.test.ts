import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCatalogService,
  createServiceCategory,
  createServiceOption,
  getCatalogAdmin,
  updateCatalogService,
} from "@isela/catalog";
import { and, eq, schema, sql } from "@isela/database";
import {
  CONFIG_REQUIRED,
  activatePriceRuleSet,
  createPriceRuleSetDraft,
  emptyPriceRules,
  getActivePriceRuleSet,
  listPriceRuleSets,
  updatePriceRuleSetDraft,
  type PriceRules,
} from "@isela/pricing";
import {
  DEFAULT_QUOTE_CONFIG,
  addQuoteItem,
  addQuoteItemFromCalculation,
  calculateQuoteItemPrice,
  createQuoteDraft,
  getQuote,
  transitionQuote,
} from "@isela/quotes";
import { isDomainError } from "@isela/shared";
import { expectDomainError, expectPgError } from "../support/assertions.ts";
import { contextForRole, openTestDatabase } from "../support/fixtures.ts";
import { activeServiceArea, geocodedCustomer, type StaffCtx } from "../support/operations.ts";

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

// Remote test coordinates (test data only).
const CENTER = { latitude: 64.14, longitude: -21.94 };

let dispatcher: StaffCtx;
let admin: StaffCtx;
let finance: StaffCtx;
let categoryId: string;
let serviceId: string;
let optionId: string;

/** Complete TEST rule set for the test service (values are not business prices). */
function testRules(basePriceCents: number): PriceRules {
  return {
    ...emptyPriceRules(),
    costs: { laborCostCentsPerHour: 2400 },
    services: { [serviceId]: { basePriceCents, perUnitCents: 2500 } },
    extras: { [optionId]: { priceCents: 1200, laborMinutes: 15 } },
    frequencyAdjustmentBasisPoints: {
      ONCE: 0,
      WEEKLY: -1000,
      BIWEEKLY: -500,
      MONTHLY: 0,
      CUSTOM: 0,
    },
    urgencySurchargeBasisPoints: { STANDARD: 0, EXPRESS: 2500 },
  };
}

async function draftQuote() {
  const customer = await geocodedCustomer(db, dispatcher, CENTER);
  const quoteId = await createQuoteDraft(dispatcher, {
    customerId: customer.customerId,
    propertyId: customer.propertyId,
  });
  return { quoteId, ...customer };
}

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  admin = await contextForRole(db, "ADMIN");
  finance = await contextForRole(db, "FINANCE");
  await activeServiceArea(admin, CENTER);
  categoryId = await createServiceCategory(admin, {
    key: "test-pricing-category",
    name: "Testkategorie Preise",
  });
  serviceId = await createCatalogService(admin, {
    categoryId,
    key: "test-pricing-service",
    name: "Testleistung mit Preisregeln",
    unit: "HOUR",
    durationModel: "PER_UNIT",
    baseDurationMinutes: 15,
    durationPerUnitSeconds: 3600,
    pricingStrategy: "RULE_BASED",
  });
  optionId = await createServiceOption(admin, {
    serviceId,
    key: "fridge",
    name: "Kühlschrank innen (Test)",
  });
});

describe("service catalogue administration", () => {
  it("is data driven and restricted to catalog:manage", async () => {
    await expectDomainError(
      createServiceCategory(dispatcher, { key: "test-forbidden", name: "Verboten" }),
      "FORBIDDEN",
    );
    await expectDomainError(
      createServiceCategory(admin, { key: "test-pricing-category", name: "Doppelt" }),
      "CONFLICT",
    );
    await expectDomainError(
      createCatalogService(admin, {
        categoryId,
        key: "test-fixed-without-minutes",
        name: "Ungültig",
        unit: "FLAT",
        durationModel: "FIXED",
        baseDurationMinutes: null,
        durationPerUnitSeconds: null,
        pricingStrategy: "MANUAL_QUOTE",
      }),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      createCatalogService(admin, {
        categoryId,
        key: "test-with-price",
        name: "Mit Preis",
        unit: "FLAT",
        durationModel: "MANUAL",
        baseDurationMinutes: null,
        durationPerUnitSeconds: null,
        pricingStrategy: "MANUAL_QUOTE",
        priceCents: 1000,
      }),
      "VALIDATION_FAILED",
    );
    await updateCatalogService(admin, {
      serviceId,
      requiredQualifications: ["kitchen", "kitchen"],
      supportedPropertyTypes: ["APARTMENT", "PRIVATE_HOME"],
    });
    const catalog = await getCatalogAdmin(dispatcher);
    const category = catalog.categories.find((c) => c.id === categoryId);
    expect(category?.services[0]).toMatchObject({
      key: "test-pricing-service",
      pricingStrategy: "RULE_BASED",
      requiredQualifications: ["kitchen"],
      supportedPropertyTypes: ["APARTMENT", "PRIVATE_HOME"],
      options: [{ key: "fridge", active: true }],
    });
    expect(category?.services[0]).not.toHaveProperty("priceCents");
    // Initial categories of day 5 are seeded.
    const keys = catalog.categories.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining(["holiday-rental-cleaning", "commercial-cleaning"]),
    );
  });
});

describe("price rule sets", () => {
  it("prices nothing without an active rule set (CONFIG_REQUIRED, no 0 EUR)", async () => {
    expect(await getActivePriceRuleSet(db, null)).toBeNull();
    const { quoteId } = await draftQuote();
    const calc = await calculateQuoteItemPrice(
      dispatcher,
      { quoteId, serviceId, quantity: 2, frequency: "ONCE", urgency: "STANDARD" },
      DEFAULT_QUOTE_CONFIG,
    );
    expect(calc.result).toMatchObject({ status: "CONFIG_REQUIRED", missing: ["priceRuleSet"] });
    await expectDomainError(
      addQuoteItemFromCalculation(
        dispatcher,
        { quoteId, calculationId: calc.calculationId },
        DEFAULT_QUOTE_CONFIG,
      ),
      "CONFIG_REQUIRED",
    );
    expect((await getQuote(dispatcher, { quoteId })).items).toHaveLength(0);
  });

  it("separates drafting from activation and keeps active versions immutable", async () => {
    await expectDomainError(
      createPriceRuleSetDraft(dispatcher, { changeReason: "Test" }),
      "FORBIDDEN",
    );
    const draft = await createPriceRuleSetDraft(finance, { changeReason: "Erster Entwurf (Test)" });
    await expectDomainError(
      updatePriceRuleSetDraft(finance, {
        ruleSetId: draft.id,
        rules: { ...testRules(4000), margin: 1 },
        changeReason: "Ungültig",
      }),
      "VALIDATION_FAILED",
    );
    await updatePriceRuleSetDraft(finance, {
      ruleSetId: draft.id,
      rules: testRules(4000),
      changeReason: "Werte ergänzt (Test)",
    });
    await expectDomainError(activatePriceRuleSet(finance, { ruleSetId: draft.id }), "FORBIDDEN");
    const activation = await activatePriceRuleSet(admin, { ruleSetId: draft.id });
    expect(activation).toMatchObject({ version: draft.version, retiredVersion: null });
    await expectDomainError(
      updatePriceRuleSetDraft(finance, {
        ruleSetId: draft.id,
        rules: testRules(1),
        changeReason: "Test",
      }),
      "INVALID_STATE_TRANSITION",
    );
    // Database guard: an active rule set cannot be changed or deleted directly.
    await expectPgError(
      db
        .update(schema.priceRuleSet)
        .set({ rules: testRules(1) })
        .where(eq(schema.priceRuleSet.id, draft.id)),
      "23000",
    );
    await expectPgError(
      db.delete(schema.priceRuleSet).where(eq(schema.priceRuleSet.id, draft.id)),
      "23000",
    );
    const listed = await listPriceRuleSets(finance);
    expect(listed.find((r) => r.id === draft.id)?.status).toBe("ACTIVE");
    await expectDomainError(listPriceRuleSets(dispatcher), "FORBIDDEN");
  });

  it("allows only one active default rule set under concurrent activation", async () => {
    const a = await createPriceRuleSetDraft(finance, {
      rules: testRules(4000),
      changeReason: "Parallel A (Test)",
    });
    const b = await createPriceRuleSetDraft(finance, {
      rules: testRules(4000),
      changeReason: "Parallel B (Test)",
    });
    const results = await Promise.allSettled([
      activatePriceRuleSet(admin, { ruleSetId: a.id }),
      activatePriceRuleSet(admin, { ruleSetId: b.id }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const active = await db
      .select({ id: schema.priceRuleSet.id })
      .from(schema.priceRuleSet)
      .where(
        and(
          eq(schema.priceRuleSet.status, "ACTIVE"),
          sql`${schema.priceRuleSet.serviceAreaId} IS NULL`,
        ),
      );
    expect(active).toHaveLength(1);
  });
});

describe("engine pricing of quote items", () => {
  it("calculates on the server, stores the calculation and never changes old quotes", async () => {
    const current = await createPriceRuleSetDraft(finance, {
      rules: testRules(4000),
      changeReason: "Basis (Test)",
    });
    await activatePriceRuleSet(admin, { ruleSetId: current.id });
    const { quoteId } = await draftQuote();
    // Cost inputs need quote:write AND finance:internal_read (ADMIN/SUPER_ADMIN).
    await expectDomainError(
      calculateQuoteItemPrice(
        finance,
        { quoteId, serviceId, quantity: 2, frequency: "WEEKLY", urgency: "STANDARD" },
        DEFAULT_QUOTE_CONFIG,
      ),
      "FORBIDDEN",
    );
    const calc = await calculateQuoteItemPrice(
      admin,
      {
        quoteId,
        serviceId,
        quantity: 2,
        frequency: "WEEKLY",
        urgency: "STANDARD",
        extraIds: [optionId],
        directCostsCents: 300,
      },
      DEFAULT_QUOTE_CONFIG,
    );
    // (4000 + 2 × 2500 + 1200) × 0.9 = 9180; tax 19 % = 1744.2 → 1744
    expect(calc.result).toMatchObject({
      status: "CALCULATED",
      net: 9180,
      tax: 1744,
      gross: 10_924,
      pricingVersion: `v1+r${String(current.version)}`,
      // 15 + 2 × 60 + 15 = 150 min × 24.00 €/h = 60.00 € + 3.00 € direct
      estimatedLaborMinutes: 150,
      internalCost: 6300,
      contributionMargin: 2880,
    });
    const itemId = await addQuoteItemFromCalculation(
      dispatcher,
      { quoteId, calculationId: calc.calculationId },
      DEFAULT_QUOTE_CONFIG,
    );
    const [item] = await db.select().from(schema.quoteItem).where(eq(schema.quoteItem.id, itemId));
    expect(item).toMatchObject({
      pricingSource: "ENGINE",
      pricingVersion: `v1+r${String(current.version)}`,
      unitPriceCents: 9180,
      grossCents: 10_924,
    });
    await expectDomainError(
      addQuoteItemFromCalculation(
        dispatcher,
        { quoteId, calculationId: calc.calculationId },
        DEFAULT_QUOTE_CONFIG,
      ),
      "CONFLICT",
    );

    // A new rule version does not touch the existing quote.
    const next = await createPriceRuleSetDraft(finance, {
      rules: testRules(9000),
      changeReason: "Neue Werte (Test)",
    });
    await activatePriceRuleSet(admin, { ruleSetId: next.id });
    const quote = await getQuote(dispatcher, { quoteId });
    expect(quote.grossCents).toBe(10_924);
    const [unchanged] = await db
      .select()
      .from(schema.quoteItem)
      .where(eq(schema.quoteItem.id, itemId));
    expect(unchanged?.pricingVersion).toBe(`v1+r${String(current.version)}`);
    // The stored calculation is append-only evidence.
    await expectPgError(
      db
        .update(schema.pricingCalculation)
        .set({ netCents: 1 })
        .where(eq(schema.pricingCalculation.id, calc.calculationId)),
      "23000",
    );
  });

  it("hides internal costs from dispatchers and refuses their cost inputs", async () => {
    const { quoteId } = await draftQuote();
    const calc = await calculateQuoteItemPrice(
      dispatcher,
      { quoteId, serviceId, quantity: 1, frequency: "ONCE", urgency: "EXPRESS" },
      DEFAULT_QUOTE_CONFIG,
    );
    expect(calc.internalVisible).toBe(false);
    expect(calc.result).toMatchObject({
      status: "CALCULATED",
      internalCost: null,
      contributionMargin: null,
    });
    for (const forged of [
      { partnerCostCents: 100 },
      { directCostsCents: 1 },
      { estimatedLaborMinutes: 1 },
    ]) {
      await expectDomainError(
        calculateQuoteItemPrice(
          dispatcher,
          { quoteId, serviceId, quantity: 1, frequency: "ONCE", urgency: "STANDARD", ...forged },
          DEFAULT_QUOTE_CONFIG,
        ),
        "FORBIDDEN",
      );
    }
    for (const forged of [
      { netCents: 1 },
      { taxRateBasisPoints: 0 },
      { contributionMarginCents: 1 },
      { customerId: quoteId },
    ]) {
      await expectDomainError(
        calculateQuoteItemPrice(
          dispatcher,
          { quoteId, serviceId, quantity: 1, frequency: "ONCE", urgency: "STANDARD", ...forged },
          DEFAULT_QUOTE_CONFIG,
        ),
        "VALIDATION_FAILED",
      );
    }
  });

  it("overrides a calculated price only with pricing:override and a reason (audited)", async () => {
    const { quoteId } = await draftQuote();
    const calc = await calculateQuoteItemPrice(
      dispatcher,
      { quoteId, serviceId, quantity: 1, frequency: "ONCE", urgency: "STANDARD" },
      DEFAULT_QUOTE_CONFIG,
    );
    await expectDomainError(
      addQuoteItemFromCalculation(
        dispatcher,
        {
          quoteId,
          calculationId: calc.calculationId,
          overrideNetCents: 5000,
          overrideReason: "Test",
        },
        DEFAULT_QUOTE_CONFIG,
      ),
      "FORBIDDEN",
    );
    await expectDomainError(
      addQuoteItemFromCalculation(
        admin,
        { quoteId, calculationId: calc.calculationId, overrideNetCents: 5000 },
        DEFAULT_QUOTE_CONFIG,
      ),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      addQuoteItemFromCalculation(
        admin,
        { quoteId, calculationId: calc.calculationId, overrideNetCents: 0, overrideReason: "Null" },
        DEFAULT_QUOTE_CONFIG,
      ),
      "VALIDATION_FAILED",
    );
    const itemId = await addQuoteItemFromCalculation(
      admin,
      {
        quoteId,
        calculationId: calc.calculationId,
        overrideNetCents: 5000,
        overrideReason: "Rahmenvereinbarung (Test)",
      },
      DEFAULT_QUOTE_CONFIG,
    );
    const [item] = await db.select().from(schema.quoteItem).where(eq(schema.quoteItem.id, itemId));
    expect(item).toMatchObject({ pricingSource: "ENGINE_OVERRIDDEN", unitPriceCents: 5000 });
    const [audit] = await db
      .select({ before: schema.auditLog.before, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.entityId, quoteId), eq(schema.auditLog.action, "pricing.override")),
      );
    expect(audit?.after).toMatchObject({ netCents: 5000, reason: "Rahmenvereinbarung (Test)" });
  });

  it("rejects calculations of other quotes and manual-only services", async () => {
    const first = await draftQuote();
    const second = await draftQuote();
    const calc = await calculateQuoteItemPrice(
      dispatcher,
      { quoteId: first.quoteId, serviceId, quantity: 1, frequency: "ONCE", urgency: "STANDARD" },
      DEFAULT_QUOTE_CONFIG,
    );
    await expectDomainError(
      addQuoteItemFromCalculation(
        dispatcher,
        { quoteId: second.quoteId, calculationId: calc.calculationId },
        DEFAULT_QUOTE_CONFIG,
      ),
      "NOT_FOUND",
    );
    const manual = await createCatalogService(admin, {
      categoryId,
      key: "test-manual-service",
      name: "Manuell bepreist (Test)",
      unit: "FLAT",
      durationModel: "MANUAL",
      baseDurationMinutes: null,
      durationPerUnitSeconds: null,
      pricingStrategy: "MANUAL_QUOTE",
    });
    await expectDomainError(
      calculateQuoteItemPrice(
        dispatcher,
        { quoteId: first.quoteId, serviceId: manual, frequency: "ONCE", urgency: "STANDARD" },
        DEFAULT_QUOTE_CONFIG,
      ),
      "POLICY_VIOLATION",
    );
  });
});

describe("0 EUR guard", () => {
  it("never reviews, sends or accepts a quote of 0 EUR", async () => {
    const { quoteId } = await draftQuote();
    await addQuoteItem(
      dispatcher,
      {
        quoteId,
        serviceCategoryId: categoryId,
        description: "Kostenlose Position (Test)",
        quantity: 1,
        unit: "FLAT",
        unitPriceCents: 0,
      },
      DEFAULT_QUOTE_CONFIG,
    );
    const error = await transitionQuote(
      dispatcher,
      { quoteId, to: "PENDING_REVIEW" },
      DEFAULT_QUOTE_CONFIG,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isDomainError(error, "POLICY_VIOLATION")).toBe(true);
    // Database guard for direct writes.
    await expectPgError(
      db.update(schema.quote).set({ status: "PENDING_REVIEW" }).where(eq(schema.quote.id, quoteId)),
      "23514",
    );
  });

  it("stores CONFIG_REQUIRED instead of a price when a needed rule value is open", async () => {
    const rules = testRules(4000);
    rules.urgencySurchargeBasisPoints.EXPRESS = CONFIG_REQUIRED;
    const draft = await createPriceRuleSetDraft(finance, {
      rules,
      changeReason: "Express offen (Test)",
    });
    const activation = await activatePriceRuleSet(admin, { ruleSetId: draft.id });
    expect(activation.configRequired).toContain("urgencySurchargeBasisPoints.EXPRESS");
    const { quoteId } = await draftQuote();
    const calc = await calculateQuoteItemPrice(
      dispatcher,
      { quoteId, serviceId, quantity: 1, frequency: "ONCE", urgency: "EXPRESS" },
      DEFAULT_QUOTE_CONFIG,
    );
    expect(calc.result).toMatchObject({
      status: "CONFIG_REQUIRED",
      missing: ["urgencySurchargeBasisPoints.EXPRESS"],
    });
    const [stored] = await db
      .select()
      .from(schema.pricingCalculation)
      .where(eq(schema.pricingCalculation.id, calc.calculationId));
    expect(stored).toMatchObject({ status: "CONFIG_REQUIRED", netCents: null, grossCents: null });
  });
});
