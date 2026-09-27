import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProperty, linkLeadToCustomer, submitServiceRequest } from "@isela/crm";
import { eq, schema } from "@isela/database";
import {
  DEFAULT_QUOTE_CONFIG,
  addQuoteItem,
  createQuoteDraft,
  expireQuotes,
  getQuote,
  listQuotes,
  removeQuoteItem,
  transitionQuote,
  updateQuoteDetails,
} from "@isela/quotes";
import { systemClock } from "@isela/shared";
import { expectDomainError, expectPgError } from "../support/assertions.ts";
import {
  TEST_CRM_CONFIG,
  TestClock,
  contextForRole,
  openTestDatabase,
  uniqueEmail,
} from "../support/fixtures.ts";

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

type Ctx = Awaited<ReturnType<typeof contextForRole>>;
let dispatcher: Ctx;
let admin: Ctx;
let finance: Ctx;
let categoryId: string;

let counter = 0;
async function customerWithProperty() {
  counter += 1;
  const lead = await submitServiceRequest(
    {
      customerType: "PRIVATE",
      fullName: "Angebot Testdaten",
      email: uniqueEmail("quote"),
      street: "Angebotsweg",
      houseNumber: String(counter),
      postalCode: "12345",
      city: "Teststadt",
      serviceCategoryKey: "apartment-cleaning",
      propertyType: "APARTMENT",
      frequency: "WEEKLY",
      privacyNoticeAcknowledged: true,
      privacyNoticeVersion: "test-v1",
    },
    {
      db,
      clock: systemClock,
      config: TEST_CRM_CONFIG,
      requester: null,
      clientKey: `203.0.113.${String(counter % 250)}-quote`,
      rateLimitPerHour: 500,
    },
  );
  const { customerId } = await linkLeadToCustomer(
    dispatcher,
    { leadId: lead.leadId },
    TEST_CRM_CONFIG,
  );
  const [address] = await db
    .select({ id: schema.customerAddress.id })
    .from(schema.customerAddress)
    .where(eq(schema.customerAddress.customerId, customerId));
  const propertyId = await createProperty(dispatcher, {
    customerId,
    addressId: address?.id ?? "",
    name: "Objekt Testdaten",
    propertyType: "APARTMENT",
  });
  return { customerId, propertyId, leadId: lead.leadId };
}

async function draftWithItem(customerId: string, propertyId: string) {
  const quoteId = await createQuoteDraft(dispatcher, { customerId, propertyId });
  await addQuoteItem(
    dispatcher,
    {
      quoteId,
      serviceCategoryId: categoryId,
      description: "Wohnungsreinigung",
      quantity: 3.5,
      unit: "HOUR",
      unitPriceCents: 3290,
    },
    DEFAULT_QUOTE_CONFIG,
  );
  return quoteId;
}

async function sentQuote(customerId: string, propertyId: string) {
  const quoteId = await draftWithItem(customerId, propertyId);
  await transitionQuote(dispatcher, { quoteId, to: "PENDING_REVIEW" }, DEFAULT_QUOTE_CONFIG);
  await transitionQuote(admin, { quoteId, to: "SENT" }, DEFAULT_QUOTE_CONFIG);
  return quoteId;
}

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  admin = await contextForRole(db, "ADMIN");
  finance = await contextForRole(db, "FINANCE");
  const [category] = await db
    .select({ id: schema.serviceCategory.id })
    .from(schema.serviceCategory)
    .where(eq(schema.serviceCategory.key, "apartment-cleaning"));
  categoryId = category?.id ?? "";
});

describe("quote drafts", () => {
  it("computes totals on the server and persists consistent amounts", async () => {
    const { customerId, propertyId } = await customerWithProperty();
    const quoteId = await draftWithItem(customerId, propertyId);
    await addQuoteItem(
      dispatcher,
      {
        quoteId,
        serviceCategoryId: categoryId,
        description: "Anfahrt",
        quantity: 1,
        unit: "FLAT",
        unitPriceCents: 1000,
        taxRateBasisPoints: 700,
      },
      DEFAULT_QUOTE_CONFIG,
    );
    const quote = await getQuote(dispatcher, { quoteId });
    // 3.5 × 32.90 € = 115.15 € (19 %: 21.88 €) + 10.00 € (7 %: 0.70 €)
    expect(quote).toMatchObject({
      status: "DRAFT",
      netCents: 12515,
      taxCents: 2258,
      grossCents: 14773,
      customerId,
      propertyId,
    });
    expect(quote.items.map((i) => i.position)).toEqual([1, 2]);
    expect(quote.internal?.createdByName).toBe("Test User");

    await removeQuoteItem(dispatcher, { quoteId, itemId: quote.items[1]?.id ?? "" });
    expect(await getQuote(dispatcher, { quoteId })).toMatchObject({
      netCents: 11515,
      taxCents: 2188,
      grossCents: 13703,
    });
    const audit = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, quoteId));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["quote.created", "quote.item_added", "quote.item_removed"]),
    );
  });

  it("rejects client-supplied owners, creators, amounts and statuses (mass assignment)", async () => {
    const { customerId, propertyId } = await customerWithProperty();
    for (const forged of [
      { createdByUserId: admin.actor.userId },
      { status: "SENT" },
      { netCents: 1 },
      { grossCents: 1 },
    ]) {
      await expectDomainError(
        createQuoteDraft(dispatcher, { customerId, propertyId, ...forged }),
        "VALIDATION_FAILED",
      );
    }
    const quoteId = await createQuoteDraft(dispatcher, { customerId });
    await expectDomainError(
      addQuoteItem(
        dispatcher,
        {
          quoteId,
          serviceCategoryId: categoryId,
          description: "Manipuliert",
          quantity: 1,
          unit: "HOUR",
          unitPriceCents: 100,
          netCents: 1,
        },
        DEFAULT_QUOTE_CONFIG,
      ),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      updateQuoteDetails(dispatcher, { quoteId, customerId: randomUUID() }, DEFAULT_QUOTE_CONFIG),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      addQuoteItem(
        dispatcher,
        {
          quoteId,
          serviceCategoryId: categoryId,
          description: "Unzulässiger Steuersatz",
          quantity: 1,
          unit: "HOUR",
          unitPriceCents: 100,
          taxRateBasisPoints: 1600,
        },
        DEFAULT_QUOTE_CONFIG,
      ),
      "VALIDATION_FAILED",
    );
  });

  it("rejects foreign properties and leads (forged ids)", async () => {
    const a = await customerWithProperty();
    const b = await customerWithProperty();
    await expectDomainError(
      createQuoteDraft(dispatcher, { customerId: a.customerId, propertyId: b.propertyId }),
      "NOT_FOUND",
    );
    await expectDomainError(
      createQuoteDraft(dispatcher, { customerId: a.customerId, leadId: b.leadId }),
      "NOT_FOUND",
    );
    const quoteId = await createQuoteDraft(dispatcher, {
      customerId: a.customerId,
      leadId: a.leadId,
    });
    await expectDomainError(
      updateQuoteDetails(dispatcher, { quoteId, propertyId: b.propertyId }, DEFAULT_QUOTE_CONFIG),
      "NOT_FOUND",
    );
    // Database backstop for the same invariant.
    await expectPgError(
      db.update(schema.quote).set({ propertyId: b.propertyId }).where(eq(schema.quote.id, quoteId)),
      "23503",
    );
    await expectPgError(
      db.update(schema.quote).set({ grossCents: 999 }).where(eq(schema.quote.id, quoteId)),
      "23514",
    );
  });
});

describe("quote lifecycle", () => {
  it("runs through review and release with audit and append-only history", async () => {
    const { customerId, propertyId } = await customerWithProperty();
    const quoteId = await createQuoteDraft(dispatcher, { customerId, propertyId });
    await expectDomainError(
      transitionQuote(dispatcher, { quoteId, to: "PENDING_REVIEW" }, DEFAULT_QUOTE_CONFIG),
      "POLICY_VIOLATION",
    );
    await expectDomainError(
      transitionQuote(dispatcher, { quoteId, to: "SENT" }, DEFAULT_QUOTE_CONFIG),
      "FORBIDDEN",
    );
    await addQuoteItem(
      dispatcher,
      {
        quoteId,
        serviceCategoryId: categoryId,
        description: "Grundreinigung",
        quantity: 1,
        unit: "FLAT",
        unitPriceCents: 19900,
      },
      DEFAULT_QUOTE_CONFIG,
    );
    await expectDomainError(
      transitionQuote(admin, { quoteId, to: "SENT" }, DEFAULT_QUOTE_CONFIG),
      "INVALID_STATE_TRANSITION",
    );
    await transitionQuote(dispatcher, { quoteId, to: "PENDING_REVIEW" }, DEFAULT_QUOTE_CONFIG);
    // No edits outside DRAFT.
    await expectDomainError(
      updateQuoteDetails(dispatcher, { quoteId, notes: "zu spät" }, DEFAULT_QUOTE_CONFIG),
      "INVALID_STATE_TRANSITION",
    );
    // Releasing needs quote:approve – DISPATCHER and FINANCE do not have it.
    for (const ctx of [dispatcher, finance]) {
      await expectDomainError(
        transitionQuote(ctx, { quoteId, to: "SENT" }, DEFAULT_QUOTE_CONFIG),
        "FORBIDDEN",
      );
    }
    await transitionQuote(admin, { quoteId, to: "SENT" }, DEFAULT_QUOTE_CONFIG);
    const sent = await getQuote(admin, { quoteId });
    expect(sent.status).toBe("SENT");
    expect(sent.sentAt).not.toBeNull();
    expect(sent.validUntil).not.toBeNull();

    await expectDomainError(
      transitionQuote(dispatcher, { quoteId, to: "ACCEPTED" }, DEFAULT_QUOTE_CONFIG),
      "VALIDATION_FAILED",
    );
    await transitionQuote(
      dispatcher,
      { quoteId, to: "ACCEPTED", reason: "Schriftliche Annahme liegt vor" },
      DEFAULT_QUOTE_CONFIG,
    );
    const history = (await getQuote(admin, { quoteId })).internal?.history ?? [];
    expect(history.map((h) => `${h.fromStatus}>${h.toStatus}`)).toEqual([
      "SENT>ACCEPTED",
      "PENDING_REVIEW>SENT",
      "DRAFT>PENDING_REVIEW",
    ]);
    await expectDomainError(
      transitionQuote(admin, { quoteId, to: "CANCELLED", reason: "x" }, DEFAULT_QUOTE_CONFIG),
      "INVALID_STATE_TRANSITION",
    );
    await expectPgError(
      db
        .update(schema.quoteStatusTransition)
        .set({ reason: "manipuliert" })
        .where(eq(schema.quoteStatusTransition.quoteId, quoteId)),
      "23000",
    );
  });

  it("enforces four-eyes approval when configured", async () => {
    const { customerId, propertyId } = await customerWithProperty();
    const quoteId = await createQuoteDraft(admin, { customerId, propertyId });
    await addQuoteItem(
      admin,
      {
        quoteId,
        serviceCategoryId: categoryId,
        description: "Reinigung",
        quantity: 2,
        unit: "HOUR",
        unitPriceCents: 3000,
      },
      DEFAULT_QUOTE_CONFIG,
    );
    const config = { ...DEFAULT_QUOTE_CONFIG, requireFourEyesApproval: true };
    await transitionQuote(admin, { quoteId, to: "PENDING_REVIEW" }, config);
    await expectDomainError(
      transitionQuote(admin, { quoteId, to: "SENT" }, config),
      "POLICY_VIOLATION",
    );
    const secondAdmin = await contextForRole(db, "ADMIN");
    await transitionQuote(secondAdmin, { quoteId, to: "SENT" }, config);
  });

  it("serialises concurrent transitions (only one wins)", async () => {
    const { customerId, propertyId } = await customerWithProperty();
    const quoteId = await draftWithItem(customerId, propertyId);
    await transitionQuote(dispatcher, { quoteId, to: "PENDING_REVIEW" }, DEFAULT_QUOTE_CONFIG);
    const results = await Promise.allSettled([
      transitionQuote(admin, { quoteId, to: "SENT" }, DEFAULT_QUOTE_CONFIG),
      transitionQuote(admin, { quoteId, to: "DRAFT" }, DEFAULT_QUOTE_CONFIG),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const transitions = await db
      .select()
      .from(schema.quoteStatusTransition)
      .where(eq(schema.quoteStatusTransition.quoteId, quoteId));
    expect(transitions).toHaveLength(2);
  });

  it("expires overdue quotes as a system action", async () => {
    const { customerId, propertyId } = await customerWithProperty();
    const quoteId = await sentQuote(customerId, propertyId);
    const clock = new TestClock();
    clock.advance((DEFAULT_QUOTE_CONFIG.validityDays + 2) * 24 * 3600 * 1000);
    await expectDomainError(
      transitionQuote(
        { ...dispatcher, clock },
        { quoteId, to: "ACCEPTED", reason: "zu spät" },
        DEFAULT_QUOTE_CONFIG,
      ),
      "POLICY_VIOLATION",
    );
    expect(await expireQuotes(db, clock, DEFAULT_QUOTE_CONFIG)).toBeGreaterThanOrEqual(1);
    expect((await getQuote(admin, { quoteId })).status).toBe("EXPIRED");
    const [audit] = await db
      .select({ actorType: schema.auditLog.actorType })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, quoteId))
      .orderBy(schema.auditLog.id)
      .limit(1)
      .offset(4);
    expect(audit?.actorType).toBe("SYSTEM");
  });
});

describe("quote access control", () => {
  it("shows customers only their own released quotes, without internal data", async () => {
    const a = await customerWithProperty();
    const b = await customerWithProperty();
    const draftA = await draftWithItem(a.customerId, a.propertyId);
    const sentA = await sentQuote(a.customerId, a.propertyId);
    const sentB = await sentQuote(b.customerId, b.propertyId);
    const customerA = await contextForRole(db, "CUSTOMER", { customerId: a.customerId });

    const own = await getQuote(customerA, { quoteId: sentA });
    expect(own.internal).toBeNull();
    expect(own.grossCents).toBeGreaterThan(0);
    await expectDomainError(getQuote(customerA, { quoteId: draftA }), "NOT_FOUND");
    await expectDomainError(getQuote(customerA, { quoteId: sentB }), "NOT_FOUND");
    await expectDomainError(getQuote(customerA, { quoteId: randomUUID() }), "NOT_FOUND");

    const list = await listQuotes(customerA, {});
    expect(list.items.map((q) => q.id)).toEqual([sentA]);
    const forged = await listQuotes(customerA, { customerId: b.customerId });
    expect(forged.items).toEqual([]);

    // Customers cannot write, transition or create quotes.
    await expectDomainError(
      transitionQuote(
        customerA,
        { quoteId: sentA, to: "ACCEPTED", reason: "x" },
        DEFAULT_QUOTE_CONFIG,
      ),
      "FORBIDDEN",
    );
    await expectDomainError(createQuoteDraft(customerA, { customerId: a.customerId }), "FORBIDDEN");
  });

  it("gives FINANCE read-only access and STAFF/PARTNER none", async () => {
    const { customerId, propertyId } = await customerWithProperty();
    const quoteId = await draftWithItem(customerId, propertyId);
    expect((await getQuote(finance, { quoteId })).internal).not.toBeNull();
    await expectDomainError(createQuoteDraft(finance, { customerId }), "FORBIDDEN");
    await expectDomainError(
      addQuoteItem(
        finance,
        {
          quoteId,
          serviceCategoryId: categoryId,
          description: "x",
          quantity: 1,
          unit: "HOUR",
          unitPriceCents: 1,
        },
        DEFAULT_QUOTE_CONFIG,
      ),
      "FORBIDDEN",
    );
    const [partnerRow] = await db
      .insert(schema.partner)
      .values({
        legalName: "Partner (Testdaten)",
        status: "ACTIVE",
        baseLatitude: 0,
        baseLongitude: 0,
        serviceRadiusM: 1000,
      })
      .returning({ id: schema.partner.id });
    const partner = await contextForRole(db, "PARTNER", { partnerId: partnerRow?.id ?? "" });
    const staff = await contextForRole(db, "STAFF");
    for (const ctx of [partner, staff]) {
      await expectDomainError(getQuote(ctx, { quoteId }), "FORBIDDEN");
      await expectDomainError(listQuotes(ctx, {}), "FORBIDDEN");
    }
  });
});
