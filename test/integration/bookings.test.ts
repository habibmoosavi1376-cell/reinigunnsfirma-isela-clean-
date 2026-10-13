import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, sql } from "@isela/database";
import {
  DEFAULT_OPERATIONS_CONFIG,
  cancelBooking,
  createBookingFromQuote,
  createJobForBooking,
  getBooking,
  getCustomerBooking,
  getJob,
  listBookings,
  listCustomerBookings,
  transitionPaymentStatus,
} from "@isela/operations";
import {
  DEFAULT_QUOTE_CONFIG,
  addQuoteItem,
  createQuoteDraft,
  expireQuotes,
  transitionQuote,
  updateQuoteDetails,
} from "@isela/quotes";
import { isDomainError } from "@isela/shared";
import { expectDomainError, expectPgError } from "../support/assertions.ts";
import { TestClock, contextForRole, openTestDatabase } from "../support/fixtures.ts";
import {
  CapturingLogger,
  PAYMENT_POLICY,
  acceptedQuote,
  activeServiceArea,
  futureSlot,
  geocodedCustomer,
  payPrepayment,
  testService,
  type StaffCtx,
} from "../support/operations.ts";

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

// Remote test coordinates so that no other test area overlaps (test data only).
const CENTER = { latitude: -33.92, longitude: 18.42 };
const OPTIONS = { paymentPolicy: PAYMENT_POLICY, config: DEFAULT_OPERATIONS_CONFIG };

let dispatcher: StaffCtx;
let admin: StaffCtx;
let finance: StaffCtx;
let ids: { serviceId: string; categoryId: string };

async function newAcceptedQuote() {
  const customer = await geocodedCustomer(db, dispatcher, CENTER);
  const quoteId = await acceptedQuote(dispatcher, admin, { ...customer, ...ids });
  return { ...customer, quoteId };
}

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  admin = await contextForRole(db, "ADMIN");
  finance = await contextForRole(db, "FINANCE");
  await activeServiceArea(admin, CENTER);
  ids = await testService(admin, db, { qualifications: ["glass"] });
});

describe("quote → booking", () => {
  it("creates a booking from an accepted quote with prepayment required", async () => {
    const logger = new CapturingLogger();
    const { quoteId, customerId, propertyId, addressId } = await newAcceptedQuote();
    const result = await createBookingFromQuote(
      { ...dispatcher, logger },
      { quoteId, ...futureSlot(1) },
      OPTIONS,
    );
    expect(result).toMatchObject({
      status: "PENDING_PAYMENT",
      paymentRequirement: "VORKASSE_REQUIRED",
    });
    const booking = await getBooking(dispatcher, { bookingId: result.bookingId });
    expect(booking).toMatchObject({
      customerId,
      propertyId,
      quoteId,
      source: "QUOTE",
      status: "PENDING_PAYMENT",
      paymentStatus: "PAYMENT_REQUIRED",
      netCents: 9000,
      taxCents: 1710,
      grossCents: 10_710,
      durationMinutes: 180,
    });
    expect(booking.items).toHaveLength(1);
    expect(booking.paymentDecision).toMatchObject({ terms: "PREPAYMENT" });
    expect(booking.paymentDecision["reasons"]).toContain("NEW_CUSTOMER");
    const [stored] = await db
      .select({ addressId: schema.booking.addressId })
      .from(schema.booking)
      .where(eq(schema.booking.id, result.bookingId));
    expect(stored?.addressId).toBe(addressId);
    const transitions = await db
      .select({
        from: schema.bookingStatusTransition.fromStatus,
        to: schema.bookingStatusTransition.toStatus,
      })
      .from(schema.bookingStatusTransition)
      .where(eq(schema.bookingStatusTransition.bookingId, result.bookingId));
    expect(transitions).toEqual(
      expect.arrayContaining([
        { from: null, to: "REQUESTED" },
        { from: "REQUESTED", to: "PENDING_PAYMENT" },
      ]),
    );
    const audit = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, result.bookingId));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["booking.created", "booking.status_changed"]),
    );
    // Structured log: ids and codes only.
    expect(logger.events).toEqual([
      expect.objectContaining({ event: "booking.created", level: "info" }),
    ]);
    expect(JSON.stringify(logger.events)).not.toMatch(/Buchungsweg|Teststadt|@example/);
  });

  it("refuses bookings from declined, cancelled, expired and not yet accepted quotes", async () => {
    const customer = await geocodedCustomer(db, dispatcher, CENTER);
    const draft = async () => {
      const quoteId = await createQuoteDraft(dispatcher, {
        customerId: customer.customerId,
        propertyId: customer.propertyId,
      });
      await addQuoteItem(
        dispatcher,
        {
          quoteId,
          serviceCategoryId: ids.categoryId,
          description: "Testleistung",
          quantity: 1,
          unit: "FLAT",
          unitPriceCents: 5000,
        },
        DEFAULT_QUOTE_CONFIG,
      );
      return quoteId;
    };
    const send = async (quoteId: string) => {
      await transitionQuote(dispatcher, { quoteId, to: "PENDING_REVIEW" }, DEFAULT_QUOTE_CONFIG);
      await transitionQuote(admin, { quoteId, to: "SENT" }, DEFAULT_QUOTE_CONFIG);
    };
    const declined = await draft();
    await send(declined);
    await transitionQuote(
      dispatcher,
      { quoteId: declined, to: "DECLINED", reason: "Kunde lehnt ab (Test)" },
      DEFAULT_QUOTE_CONFIG,
    );
    const cancelled = await draft();
    await transitionQuote(
      dispatcher,
      { quoteId: cancelled, to: "CANCELLED", reason: "Test" },
      DEFAULT_QUOTE_CONFIG,
    );
    const sent = await draft();
    await send(sent);
    const expired = await draft();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000).toISOString().slice(0, 10);
    await updateQuoteDetails(
      dispatcher,
      { quoteId: expired, validUntil: tomorrow },
      DEFAULT_QUOTE_CONFIG,
    );
    await send(expired);
    await expireQuotes(
      db,
      new TestClock(new Date(Date.now() + 3 * 24 * 60 * 60_000)),
      DEFAULT_QUOTE_CONFIG,
    );
    const [expiredRow] = await db
      .select({ status: schema.quote.status })
      .from(schema.quote)
      .where(eq(schema.quote.id, expired));
    expect(expiredRow?.status).toBe("EXPIRED");

    for (const quoteId of [declined, cancelled, sent, expired]) {
      await expectDomainError(
        createBookingFromQuote(dispatcher, { quoteId, ...futureSlot(1) }, OPTIONS),
        "POLICY_VIOLATION",
      );
    }
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.booking)
      .where(eq(schema.booking.customerId, customer.customerId));
    expect(count?.n).toBe(0);
  });

  it("rejects forged customer, property, price and payment fields (mass assignment)", async () => {
    const { quoteId } = await newAcceptedQuote();
    const other = await geocodedCustomer(db, dispatcher, CENTER);
    for (const forged of [
      { customerId: other.customerId },
      { propertyId: other.propertyId },
      { grossCents: 1 },
      { netCents: 1 },
      { paymentStatus: "PAYMENT_CONFIRMED" },
      { paymentRequirement: "CREDIT_TERMS_APPROVED" },
      { status: "CONFIRMED" },
    ]) {
      await expectDomainError(
        createBookingFromQuote(dispatcher, { quoteId, ...futureSlot(1), ...forged }, OPTIONS),
        "VALIDATION_FAILED",
      );
    }
  });

  it("validates the time window on the server", async () => {
    const { quoteId } = await newAcceptedQuote();
    const past = {
      windowStart: "2020-01-07T08:00:00Z",
      windowEnd: "2020-01-07T12:00:00Z",
      durationMinutes: 180,
    };
    await expectDomainError(
      createBookingFromQuote(dispatcher, { quoteId, ...past }, OPTIONS),
      "VALIDATION_FAILED",
    );
    const slot = futureSlot(1);
    await expectDomainError(
      createBookingFromQuote(dispatcher, { quoteId, ...slot, durationMinutes: 300 }, OPTIONS),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      createBookingFromQuote(
        dispatcher,
        { quoteId, windowStart: slot.windowEnd, windowEnd: slot.windowStart, durationMinutes: 60 },
        OPTIONS,
      ),
      "VALIDATION_FAILED",
    );
  });

  it("books a quote exactly once, also under concurrent requests", async () => {
    const { quoteId } = await newAcceptedQuote();
    const results = await Promise.allSettled([
      createBookingFromQuote(dispatcher, { quoteId, ...futureSlot(1) }, OPTIONS),
      createBookingFromQuote(admin, { quoteId, ...futureSlot(1) }, OPTIONS),
      createBookingFromQuote(dispatcher, { quoteId, ...futureSlot(2) }, OPTIONS),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(isDomainError(r.reason, "CONFLICT")).toBe(true);
    }
    const rows = await db
      .select({ id: schema.booking.id })
      .from(schema.booking)
      .where(eq(schema.booking.quoteId, quoteId));
    expect(rows).toHaveLength(1);
  });

  it("keeps two concurrent bookings of the same customer consistent", async () => {
    const customer = await geocodedCustomer(db, dispatcher, CENTER);
    const [q1, q2] = await Promise.all([
      acceptedQuote(dispatcher, admin, { ...customer, ...ids }),
      acceptedQuote(dispatcher, admin, { ...customer, ...ids }),
    ]);
    const results = await Promise.all([
      createBookingFromQuote(dispatcher, { quoteId: q1, ...futureSlot(1) }, OPTIONS),
      createBookingFromQuote(dispatcher, { quoteId: q2, ...futureSlot(1) }, OPTIONS),
    ]);
    expect(new Set(results.map((r) => r.bookingId)).size).toBe(2);
    const list = await listBookings(dispatcher, { customerId: customer.customerId });
    expect(list.total).toBe(2);
  });

  it("allows booking only for booking:write roles and refuses blocked customers", async () => {
    const { quoteId, customerId } = await newAcceptedQuote();
    await expectDomainError(
      createBookingFromQuote(finance, { quoteId, ...futureSlot(1) }, OPTIONS),
      "FORBIDDEN",
    );
    const customerUser = await contextForRole(db, "CUSTOMER", { customerId });
    await expectDomainError(
      createBookingFromQuote(customerUser, { quoteId, ...futureSlot(1) }, OPTIONS),
      "FORBIDDEN",
    );
    await db
      .update(schema.customer)
      .set({ status: "BLOCKED" })
      .where(eq(schema.customer.id, customerId));
    await expectDomainError(
      createBookingFromQuote(dispatcher, { quoteId, ...futureSlot(1) }, OPTIONS),
      "POLICY_VIOLATION",
    );
  });
});

describe("payment state", () => {
  it("is confirmed only through a paid prepayment invoice and releases the booking", async () => {
    const { quoteId } = await newAcceptedQuote();
    const { bookingId } = await createBookingFromQuote(
      dispatcher,
      { quoteId, ...futureSlot(1) },
      OPTIONS,
    );
    await expectDomainError(
      transitionPaymentStatus(dispatcher, { bookingId, to: "PAYMENT_PENDING" }),
      "FORBIDDEN",
    );
    await transitionPaymentStatus(finance, { bookingId, to: "PAYMENT_PENDING" });
    // Day 6: a reference text alone never confirms a payment (payment-history bypass closed).
    for (const to of ["PAYMENT_CONFIRMED", "REFUND_PENDING", "REFUNDED"] as const) {
      await expectDomainError(
        transitionPaymentStatus(finance, {
          bookingId,
          to,
          reference: "Kontoauszug 2026-10 Pos. 7 (Test)",
        }),
        "POLICY_VIOLATION",
      );
    }
    await expectDomainError(
      transitionPaymentStatus(finance, { bookingId, to: "PAID" }),
      "VALIDATION_FAILED",
    );
    const invoiceId = await payPrepayment(finance, bookingId);
    const booking = await getBooking(finance, { bookingId });
    expect(booking.status).toBe("CONFIRMED");
    expect(booking.paymentStatus).toBe("PAYMENT_CONFIRMED");
    expect(booking.history.map((h) => `${h.kind}:${h.toStatus}`)).toEqual(
      expect.arrayContaining([
        "PAYMENT:PAYMENT_REQUIRED",
        "PAYMENT:PAYMENT_PENDING",
        "PAYMENT:PAYMENT_CONFIRMED",
        "BOOKING:CONFIRMED",
      ]),
    );
    const audit = await db
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.entityId, bookingId),
          eq(schema.auditLog.action, "payment.status_changed"),
        ),
      );
    // Manual "payment expected" + confirmation through the invoice.
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain("Kontoauszug");
    expect(JSON.stringify(audit)).toContain("INVOICE");
    expect(invoiceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is protected in the database: no confirmation without confirmed prepayment", async () => {
    const { quoteId } = await newAcceptedQuote();
    const { bookingId } = await createBookingFromQuote(
      dispatcher,
      { quoteId, ...futureSlot(1) },
      OPTIONS,
    );
    await expectPgError(
      db
        .update(schema.booking)
        .set({ status: "CONFIRMED" })
        .where(eq(schema.booking.id, bookingId)),
      "23514",
    );
    await expectPgError(
      db
        .update(schema.booking)
        .set({ paymentStatus: null })
        .where(eq(schema.booking.id, bookingId)),
      "23514",
    );
    await expectPgError(
      db
        .update(schema.bookingStatusTransition)
        .set({ reason: "manipuliert" })
        .where(eq(schema.bookingStatusTransition.bookingId, bookingId)),
      "23000",
    );
  });
});

describe("booking → job", () => {
  it("plans exactly one job per booking with area and qualifications", async () => {
    const logger = new CapturingLogger();
    const { quoteId } = await newAcceptedQuote();
    const { bookingId } = await createBookingFromQuote(
      dispatcher,
      { quoteId, ...futureSlot(1) },
      OPTIONS,
    );
    const results = await Promise.allSettled([
      createJobForBooking({ ...dispatcher, logger }, { bookingId }),
      createJobForBooking({ ...dispatcher, logger }, { bookingId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected !== undefined && isDomainError(rejected.reason, "CONFLICT")).toBe(true);
    const [job] = await db.select().from(schema.job).where(eq(schema.job.bookingId, bookingId));
    expect(job).toMatchObject({ status: "PLANNED", requiredQualifications: ["glass"] });
    expect(job?.serviceAreaId).not.toBeNull();
    expect((job?.scheduledEnd.getTime() ?? 0) - (job?.scheduledStart.getTime() ?? 0)).toBe(
      180 * 60_000,
    );
    expect(logger.events.filter((e) => e.event === "job.created")).toHaveLength(1);
  });

  it("does not plan jobs for cancelled bookings or without job:write", async () => {
    const { quoteId } = await newAcceptedQuote();
    const { bookingId } = await createBookingFromQuote(
      dispatcher,
      { quoteId, ...futureSlot(1) },
      OPTIONS,
    );
    await expectDomainError(createJobForBooking(finance, { bookingId }), "FORBIDDEN");
    await cancelBooking(dispatcher, { bookingId, reason: "Kunde storniert (Test)" });
    await expectDomainError(createJobForBooking(dispatcher, { bookingId }), "POLICY_VIOLATION");
  });

  it("cancels the planned job together with the booking and audits it", async () => {
    const { quoteId } = await newAcceptedQuote();
    const { bookingId } = await createBookingFromQuote(
      dispatcher,
      { quoteId, ...futureSlot(1) },
      OPTIONS,
    );
    const { jobId } = await createJobForBooking(dispatcher, { bookingId });
    await expectDomainError(
      cancelBooking(dispatcher, { bookingId, reason: "" }),
      "VALIDATION_FAILED",
    );
    await cancelBooking(dispatcher, { bookingId, reason: "Kunde storniert (Test)" });
    const job = await getJob(dispatcher, { jobId });
    expect(job.status).toBe("CANCELLED");
    const booking = await getBooking(dispatcher, { bookingId });
    expect(booking).toMatchObject({
      status: "CANCELLED",
      cancellationReason: "Kunde storniert (Test)",
    });
    const actions = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, bookingId));
    expect(actions.map((a) => a.action)).toContain("booking.cancelled");
  });
});

describe("customer portal (IDOR)", () => {
  it("shows customers only their own bookings without internal data", async () => {
    const own = await newAcceptedQuote();
    const foreign = await newAcceptedQuote();
    const ownBooking = await createBookingFromQuote(
      dispatcher,
      { quoteId: own.quoteId, ...futureSlot(1) },
      OPTIONS,
    );
    const foreignBooking = await createBookingFromQuote(
      dispatcher,
      { quoteId: foreign.quoteId, ...futureSlot(1) },
      OPTIONS,
    );
    await createJobForBooking(dispatcher, { bookingId: ownBooking.bookingId });
    const customer = await contextForRole(db, "CUSTOMER", { customerId: own.customerId });

    const view = await getCustomerBooking(customer, { bookingId: ownBooking.bookingId });
    expect(view).toMatchObject({
      id: ownBooking.bookingId,
      status: "PENDING_PAYMENT",
      paymentStatus: "PAYMENT_REQUIRED",
    });
    for (const internal of [
      "customerName",
      "paymentDecision",
      "operationalNotes",
      "history",
      "job",
      "quoteId",
      "internalFinance",
      "assignment",
    ]) {
      expect(view, internal).not.toHaveProperty(internal);
    }
    await expectDomainError(
      getCustomerBooking(customer, { bookingId: foreignBooking.bookingId }),
      "NOT_FOUND",
    );
    await expectDomainError(getBooking(customer, { bookingId: ownBooking.bookingId }), "FORBIDDEN");
    await expectDomainError(listBookings(customer, {}), "FORBIDDEN");
    const [job] = await db
      .select({ id: schema.job.id })
      .from(schema.job)
      .where(eq(schema.job.bookingId, ownBooking.bookingId));
    await expectDomainError(getJob(customer, { jobId: job?.id ?? "" }), "FORBIDDEN");
    const list = await listCustomerBookings(customer, {});
    expect(list.items.map((i) => i.id)).toEqual([ownBooking.bookingId]);
    // Staff contexts get nothing from the customer list (no accidental global listing).
    expect((await listCustomerBookings(dispatcher, {})).total).toBe(0);
  });
});
