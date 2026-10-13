import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  UNCONFIGURED_PAYMENT_PROVIDER,
  approveCreditTerms,
  cancelDraftInvoice,
  changeInvoiceDueDate,
  completeRefund,
  confirmPayment,
  createInvoiceForBooking,
  denyCreditTerms,
  failPayment,
  getCustomerInvoice,
  getCustomerRiskProfile,
  getInvoice,
  issueInvoice,
  listCustomerInvoices,
  listInvoices,
  listPayments,
  processProviderWebhook,
  recordChargeback,
  recordPayment,
  releaseInvoice,
  requestCreditTerms,
  requestRefund,
  revokeCreditTerms,
  runOverdueCheck,
  startProviderPayment,
  voidInvoice,
  type FinanceOptions,
} from "@isela/billing";
import { and, eq, schema, sql } from "@isela/database";
import {
  DEFAULT_OPERATIONS_CONFIG,
  assignJob,
  cancelBooking,
  clearPaymentReview,
  createBookingFromQuote,
  createJobForBooking,
  getBooking,
  transitionJob,
} from "@isela/operations";
import { DEFAULT_PAYMENT_POLICY, evaluateCustomerPaymentTerms } from "@isela/payment-risk";
import { isDomainError } from "@isela/shared";
import { expectDomainError, expectPgError } from "../support/assertions.ts";
import { TestClock, contextForRole, openTestDatabase, uniqueEmail } from "../support/fixtures.ts";
import {
  FINANCE_OPTIONS,
  PAYMENT_POLICY,
  TEST_BILLING_CONFIG,
  acceptedQuote,
  activeServiceArea,
  futureSlot,
  geocodedCustomer,
  payInvoice,
  payPrepayment,
  releasedInvoice,
  staffedEmployee,
  testService,
  type StaffCtx,
} from "../support/operations.ts";
import {
  TEST_WEBHOOK_SECRET,
  TestPaymentProvider,
  signedDelivery,
} from "../support/payment-provider.ts";

/*
 * Day 6: invoicing, payments, payment risk and financial controls against a real
 * PostgreSQL. All records are test data; amounts are test values (3 h × 30,00 € + 19 % USt.
 * = 107,10 €), not business prices.
 */

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

// Remote test coordinates (no overlap with other test areas; test data only).
const CENTER = { latitude: -41.29, longitude: 174.78 };
const GROSS = 10_710;
const DAY = 86_400_000;
/** B2C invoice terms enabled for the credit-flow tests (test policy, not an owner value). */
const CREDIT_POLICY = {
  policy: { ...DEFAULT_PAYMENT_POLICY, b2cInvoiceTermsAllowed: true },
  version: null,
};
const OPTIONS = { paymentPolicy: PAYMENT_POLICY, config: DEFAULT_OPERATIONS_CONFIG };
const CREDIT_OPTIONS = { paymentPolicy: CREDIT_POLICY, config: DEFAULT_OPERATIONS_CONFIG };
const CREDIT_FINANCE: FinanceOptions = { ...FINANCE_OPTIONS, paymentPolicy: CREDIT_POLICY };
const JOB_PAYMENT = { paymentPolicy: CREDIT_POLICY, timeZone: DEFAULT_OPERATIONS_CONFIG.timeZone };

let dispatcher: StaffCtx;
let admin: StaffCtx;
let finance: StaffCtx;
let finance2: StaffCtx;
let areaId: string;
let employeeId: string;
let ids: { serviceId: string; categoryId: string };
let week = 10;

function uniquePrefix(): string {
  return `T${randomUUID().replace(/-/g, "").slice(0, 7).toUpperCase()}`;
}

async function customer(email?: string) {
  return geocodedCustomer(db, dispatcher, CENTER, email === undefined ? {} : { email });
}

/** Accepted quote → booking (each call uses its own future week). */
async function booking(
  owner: { customerId: string; propertyId: string },
  options = OPTIONS,
): Promise<string> {
  week += 1;
  const quoteId = await acceptedQuote(dispatcher, admin, { ...owner, ...ids });
  const { bookingId } = await createBookingFromQuote(
    dispatcher,
    { quoteId, ...futureSlot(week) },
    options,
  );
  return bookingId;
}

/** Job of a (paid or credit) booking: planned, assigned, started and completed. */
async function completeJob(bookingId: string): Promise<string> {
  const { jobId } = await createJobForBooking(dispatcher, { bookingId });
  await transitionJob(dispatcher, { jobId, to: "ASSIGNMENT_PENDING" });
  await assignJob(
    dispatcher,
    { jobId, kind: "EMPLOYEE", candidateId: employeeId },
    DEFAULT_OPERATIONS_CONFIG,
  );
  await transitionJob(dispatcher, { jobId, to: "IN_PROGRESS" }, JOB_PAYMENT);
  await transitionJob(dispatcher, { jobId, to: "COMPLETED" });
  return jobId;
}

async function invoiceRow(invoiceId: string) {
  const [row] = await db.select().from(schema.invoice).where(eq(schema.invoice.id, invoiceId));
  if (row === undefined) throw new Error("invoice missing");
  return row;
}

async function draftFor(bookingId: string): Promise<string> {
  return (await createInvoiceForBooking(finance, { bookingId, kind: "PREPAYMENT" })).invoiceId;
}

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  admin = await contextForRole(db, "ADMIN");
  finance = await contextForRole(db, "FINANCE");
  finance2 = await contextForRole(db, "FINANCE");
  areaId = await activeServiceArea(admin, CENTER);
  ids = await testService(admin, db);
  employeeId = await staffedEmployee(admin, { serviceAreaId: areaId, maxJobsPerDay: 10 });
});

describe("quote → booking → prepayment invoice → payment → job", () => {
  it("runs the whole prepayment flow with an immutable snapshot and a sequential number", async () => {
    const owner = await customer();
    const bookingId = await booking(owner);
    const prefix = uniquePrefix();
    const options = {
      ...FINANCE_OPTIONS,
      billing: { ...TEST_BILLING_CONFIG, invoiceNumberPrefix: prefix },
    };
    const { invoiceId } = await createInvoiceForBooking(finance, {
      bookingId,
      kind: "PREPAYMENT",
    });
    const draft = await getInvoice(finance, { invoiceId });
    expect(draft).toMatchObject({
      status: "DRAFT",
      invoiceNumber: null,
      netCents: 9_000,
      taxCents: 1_710,
      grossCents: GROSS,
      paidCents: 0,
      outstandingCents: GROSS,
      paymentTerms: "VORKASSE",
    });
    expect(draft.items).toHaveLength(1);
    const { invoiceNumber, dueDate } = await issueInvoice(finance, { invoiceId }, options);
    const year = new Date().getFullYear();
    expect(invoiceNumber).toBe(`${prefix}-${String(year)}-000001`);
    expect(dueDate >= ((await invoiceRow(invoiceId)).issueDate ?? "9999-12-31")).toBe(true);
    await releaseInvoice(finance, { invoiceId }, options);
    expect((await getBooking(finance, { bookingId })).paymentStatus).toBe("PAYMENT_PENDING");

    // The job cannot start before the prepayment is paid.
    const { jobId } = await createJobForBooking(dispatcher, { bookingId });
    await transitionJob(dispatcher, { jobId, to: "ASSIGNMENT_PENDING" });
    await assignJob(
      dispatcher,
      { jobId, kind: "EMPLOYEE", candidateId: employeeId },
      DEFAULT_OPERATIONS_CONFIG,
    );
    await expectDomainError(
      transitionJob(dispatcher, { jobId, to: "IN_PROGRESS" }, JOB_PAYMENT),
      "POLICY_VIOLATION",
    );

    // Partial payment: PARTIALLY_PAID, booking not released, job still blocked.
    await payInvoice(finance, invoiceId, { amountCents: 5_000, finance: options });
    let invoice = await getInvoice(finance, { invoiceId });
    expect(invoice).toMatchObject({
      status: "PARTIALLY_PAID",
      paidCents: 5_000,
      outstandingCents: 5_710,
    });
    expect((await getBooking(finance, { bookingId })).status).toBe("PENDING_PAYMENT");
    await expectDomainError(
      transitionJob(dispatcher, { jobId, to: "IN_PROGRESS" }, JOB_PAYMENT),
      "POLICY_VIOLATION",
    );

    // Remaining amount plus 1,00 € too much: PAID, excess reported, not applied.
    await payInvoice(finance, invoiceId, { amountCents: 5_810, finance: options });
    invoice = await getInvoice(finance, { invoiceId });
    expect(invoice).toMatchObject({ status: "PAID", paidCents: GROSS, outstandingCents: 0 });
    expect(invoice.payments.map((p) => p.excessCents).sort()).toEqual([0, 100]);
    const released = await getBooking(finance, { bookingId });
    expect(released.status).toBe("SCHEDULED");
    expect(released.paymentStatus).toBe("PAYMENT_CONFIRMED");
    await transitionJob(dispatcher, { jobId, to: "IN_PROGRESS" }, JOB_PAYMENT);
    await transitionJob(dispatcher, { jobId, to: "COMPLETED" });
    expect((await getBooking(finance, { bookingId })).status).toBe("COMPLETED");

    // Never "paid" automatically by the job, and no second invoice for the booking.
    await expectDomainError(
      createInvoiceForBooking(finance, { bookingId, kind: "FINAL" }),
      "POLICY_VIOLATION",
    );
    await expectDomainError(
      createInvoiceForBooking(finance, { bookingId, kind: "PREPAYMENT" }),
      "POLICY_VIOLATION",
    );
    const audit = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, invoiceId));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["invoice.created", "invoice.issued", "invoice.status_changed"]),
    );
  });

  it("keeps an issued invoice unchanged when quote, booking data or prices change later", async () => {
    const owner = await customer();
    const bookingId = await booking(owner);
    const invoiceId = await releasedInvoice(finance, bookingId);
    const before = await getInvoice(finance, { invoiceId });
    // Even a direct manipulation of the booking snapshot source is rejected (append-only).
    await expectPgError(
      db
        .update(schema.bookingItem)
        .set({ unitPriceCents: 1 })
        .where(eq(schema.bookingItem.bookingId, bookingId)),
      "23000",
    );
    await expectPgError(
      db
        .update(schema.invoice)
        .set({ grossCents: 1, netCents: 1, taxCents: 0 })
        .where(eq(schema.invoice.id, invoiceId)),
      "23000",
    );
    await expectPgError(
      db
        .update(schema.invoiceItem)
        .set({ description: "geändert" })
        .where(eq(schema.invoiceItem.invoiceId, invoiceId)),
      "23000",
    );
    const after = await getInvoice(finance, { invoiceId });
    expect(after.items).toEqual(before.items);
    expect(after.grossCents).toBe(before.grossCents);
  });

  it("requires owner configuration before issuing (CONFIG_REQUIRED, no invented values)", async () => {
    const owner = await customer();
    const bookingId = await booking(owner);
    const invoiceId = await draftFor(bookingId);
    const unconfigured: FinanceOptions = {
      ...FINANCE_OPTIONS,
      billing: { invoiceNumberPrefix: null, paymentTermDays: null, prepaymentDueDays: null },
    };
    await expectDomainError(issueInvoice(finance, { invoiceId }, unconfigured), "CONFIG_REQUIRED");
    expect((await invoiceRow(invoiceId)).status).toBe("DRAFT");
    await cancelDraftInvoice(finance, { invoiceId, reason: "Test: Entwurf verworfen" });
    expect((await invoiceRow(invoiceId)).invoiceNumber).toBeNull();
  });
});

describe("invoice generation rules", () => {
  it("never invoices cancelled bookings and never twice", async () => {
    const owner = await customer();
    const bookingId = await booking(owner);
    await draftFor(bookingId);
    await expectDomainError(draftFor(bookingId), "CONFLICT");
    const cancelled = await booking(owner);
    await cancelBooking(dispatcher, { bookingId: cancelled, reason: "Test: storniert" });
    await expectDomainError(draftFor(cancelled), "POLICY_VIOLATION");
  });

  it("rejects forged amounts, customers and statuses (mass assignment)", async () => {
    const owner = await customer();
    const bookingId = await booking(owner);
    for (const forged of [
      { grossCents: 1 },
      { customerId: randomUUID() },
      { status: "PAID" },
      { invoiceNumber: "RE-2026-000001" },
    ]) {
      await expectDomainError(
        createInvoiceForBooking(finance, { bookingId, kind: "PREPAYMENT", ...forged }),
        "VALIDATION_FAILED",
      );
    }
  });

  it("lets only one of two concurrent generations for the same booking win", async () => {
    const owner = await customer();
    const bookingId = await booking(owner);
    const results = await Promise.allSettled([draftFor(bookingId), draftFor(bookingId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(isDomainError(rejected?.reason, "CONFLICT")).toBe(true);
  });
});

describe("invoice numbering", () => {
  it("assigns unique, gap-free numbers under concurrency", async () => {
    const owner = await customer();
    const drafts = [];
    for (let i = 0; i < 5; i += 1) drafts.push(await draftFor(await booking(owner)));
    const prefix = uniquePrefix();
    const options = {
      ...FINANCE_OPTIONS,
      billing: { ...TEST_BILLING_CONFIG, invoiceNumberPrefix: prefix },
    };
    const issued = await Promise.all(
      drafts.map((invoiceId) => issueInvoice(finance, { invoiceId }, options)),
    );
    const year = String(new Date().getFullYear());
    expect(issued.map((i) => i.invoiceNumber).sort()).toEqual(
      [1, 2, 3, 4, 5].map((n) => `${prefix}-${year}-00000${String(n)}`),
    );
    // Numbers are set exactly once and never reused.
    await expectPgError(
      db
        .update(schema.invoice)
        .set({ invoiceNumber: `${prefix}-${year}-000099` })
        .where(eq(schema.invoice.id, drafts[0] ?? "")),
      "23000",
    );
    await expectPgError(
      db.execute(
        sql`UPDATE "invoice_number_counter" SET "last_value" = 1 WHERE "series_key" = ${prefix}`,
      ),
      "23000",
    );
  });

  it("starts a new sequence per calendar year of the business time zone", async () => {
    const owner = await customer();
    const first = await draftFor(await booking(owner));
    const second = await draftFor(await booking(owner));
    const prefix = uniquePrefix();
    const options = {
      ...FINANCE_OPTIONS,
      billing: { ...TEST_BILLING_CONFIG, invoiceNumberPrefix: prefix },
    };
    // 23:30 on 31 Dec and 00:30 on 1 Jan in Europe/Berlin (CET, UTC+1).
    const late = await contextForRole(
      db,
      "FINANCE",
      {},
      new TestClock(new Date("2027-12-31T22:30:00Z")),
    );
    const early = await contextForRole(
      db,
      "FINANCE",
      {},
      new TestClock(new Date("2027-12-31T23:30:00Z")),
    );
    expect((await issueInvoice(late, { invoiceId: first }, options)).invoiceNumber).toBe(
      `${prefix}-2027-000001`,
    );
    expect((await issueInvoice(early, { invoiceId: second }, options)).invoiceNumber).toBe(
      `${prefix}-2028-000001`,
    );
  });
});

describe("payments: idempotency and concurrency", () => {
  async function openInvoice(): Promise<string> {
    const owner = await customer();
    return releasedInvoice(finance, await booking(owner));
  }

  it("never books the same submission or bank transaction twice", async () => {
    const invoiceId = await openInvoice();
    const input = {
      invoiceId,
      amountCents: GROSS,
      method: "BANK_TRANSFER",
      reference: `Kontoauszug ${randomUUID()}`,
      receivedAt: new Date().toISOString(),
      idempotencyKey: `test:${randomUUID()}`,
    };
    const [a, b] = await Promise.all([
      recordPayment(finance, input),
      recordPayment(finance, input),
    ]);
    expect(a.paymentId).toBe(b.paymentId);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    // Same key, different amount: conflict (never silently a second payment).
    await expectDomainError(recordPayment(finance, { ...input, amountCents: 1 }), "CONFLICT");
    // Same bank reference with a new key: rejected.
    await expectDomainError(
      recordPayment(finance, { ...input, idempotencyKey: `test:${randomUUID()}` }),
      "CONFLICT",
    );
    expect((await listPayments(finance, { invoiceId })).total).toBe(1);
  });

  it("applies a payment confirmed twice concurrently only once", async () => {
    const invoiceId = await openInvoice();
    const { paymentId } = await recordPayment(finance, {
      invoiceId,
      amountCents: GROSS,
      method: "BANK_TRANSFER",
      reference: `Kontoauszug ${randomUUID()}`,
      receivedAt: new Date().toISOString(),
      idempotencyKey: `test:${randomUUID()}`,
    });
    const results = await Promise.allSettled([
      confirmPayment(finance, { paymentId }, FINANCE_OPTIONS),
      confirmPayment(finance2, { paymentId }, FINANCE_OPTIONS),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const invoice = await getInvoice(finance, { invoiceId });
    expect(invoice).toMatchObject({ status: "PAID", paidCents: GROSS });
    const transitions = await db
      .select()
      .from(schema.invoiceStatusTransition)
      .where(
        and(
          eq(schema.invoiceStatusTransition.invoiceId, invoiceId),
          eq(schema.invoiceStatusTransition.toStatus, "PAID"),
        ),
      );
    expect(transitions).toHaveLength(1);
  });

  it("never pays an invoice twice with two concurrent full payments", async () => {
    const invoiceId = await openInvoice();
    const record = () =>
      recordPayment(finance, {
        invoiceId,
        amountCents: GROSS,
        method: "BANK_TRANSFER",
        reference: `Kontoauszug ${randomUUID()}`,
        receivedAt: new Date().toISOString(),
        idempotencyKey: `test:${randomUUID()}`,
      });
    const [p1, p2] = await Promise.all([record(), record()]);
    await Promise.all([
      confirmPayment(finance, { paymentId: p1.paymentId }, FINANCE_OPTIONS),
      confirmPayment(finance2, { paymentId: p2.paymentId }, FINANCE_OPTIONS),
    ]);
    const invoice = await getInvoice(finance, { invoiceId });
    expect(invoice.paidCents).toBe(GROSS);
    expect(invoice.payments.map((p) => p.appliedCents).sort((x, y) => x - y)).toEqual([0, GROSS]);
    expect(invoice.payments.map((p) => p.excessCents).sort((x, y) => x - y)).toEqual([0, GROSS]);
  });

  it("rejects card data, future dates, forged statuses and payments on drafts", async () => {
    const invoiceId = await openInvoice();
    const base = {
      invoiceId,
      amountCents: 100,
      method: "BANK_TRANSFER",
      reference: `Kontoauszug ${randomUUID()}`,
      receivedAt: new Date().toISOString(),
      idempotencyKey: `test:${randomUUID()}`,
    };
    await expectDomainError(
      recordPayment(finance, { ...base, reference: "Karte 4111 1111 1111 1111" }),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      recordPayment(finance, { ...base, receivedAt: new Date(Date.now() + 2 * DAY).toISOString() }),
      "VALIDATION_FAILED",
    );
    for (const forged of [
      { status: "CONFIRMED" },
      { appliedCents: 100 },
      { customerId: randomUUID() },
    ]) {
      await expectDomainError(recordPayment(finance, { ...base, ...forged }), "VALIDATION_FAILED");
    }
    const owner = await customer();
    const draft = await draftFor(await booking(owner));
    await expectDomainError(
      recordPayment(finance, { ...base, invoiceId: draft, idempotencyKey: `test:${randomUUID()}` }),
      "POLICY_VIOLATION",
    );
  });

  it("records failed payments as payment problems without touching the invoice", async () => {
    const owner = await customer();
    const invoiceId = await releasedInvoice(finance, await booking(owner));
    const { paymentId } = await recordPayment(finance, {
      invoiceId,
      amountCents: GROSS,
      method: "SEPA_DIRECT_DEBIT",
      reference: `Lastschrift ${randomUUID()}`,
      receivedAt: new Date().toISOString(),
      idempotencyKey: `test:${randomUUID()}`,
    });
    await failPayment(
      finance,
      { paymentId, reason: "Rücklastschrift mangels Deckung (Test)" },
      FINANCE_OPTIONS,
    );
    expect((await getInvoice(finance, { invoiceId })).status).toBe("OPEN");
    const { history } = await evaluateCustomerPaymentTerms(db, owner.customerId, {
      policy: DEFAULT_PAYMENT_POLICY,
      now: new Date(),
      timeZone: "Europe/Berlin",
    });
    expect(history.failedPaymentsInLookback).toBe(1);
    await expectDomainError(
      confirmPayment(finance, { paymentId }, FINANCE_OPTIONS),
      "INVALID_STATE_TRANSITION",
    );
  });

  it("keeps booking and payment consistent when cancellation and confirmation race", async () => {
    const owner = await customer();
    const bookingId = await booking(owner);
    const invoiceId = await releasedInvoice(finance, bookingId);
    const { paymentId } = await recordPayment(finance, {
      invoiceId,
      amountCents: GROSS,
      method: "BANK_TRANSFER",
      reference: `Kontoauszug ${randomUUID()}`,
      receivedAt: new Date().toISOString(),
      idempotencyKey: `test:${randomUUID()}`,
    });
    await Promise.allSettled([
      confirmPayment(finance, { paymentId }, FINANCE_OPTIONS),
      cancelBooking(dispatcher, { bookingId, reason: "Test: Storno während Zahlung" }),
    ]);
    const final = await getBooking(finance, { bookingId });
    expect(final.status).toBe("CANCELLED");
    const invoice = await getInvoice(finance, { invoiceId });
    expect(invoice.status).toBe("PAID");
    expect(invoice.payments).toHaveLength(1);
  });
});

describe("refunds", () => {
  it("refunds only voided invoices of cancelled bookings and marks the booking refunded", async () => {
    const owner = await customer();
    const bookingId = await booking(owner);
    const invoiceId = await payPrepayment(finance, bookingId);
    const [payment] = (await getInvoice(finance, { invoiceId })).payments;
    const paymentId = payment?.id ?? "";
    await expectDomainError(
      requestRefund(finance, { paymentId, reason: "Test" }),
      "POLICY_VIOLATION",
    );
    await expectDomainError(
      voidInvoice(finance, { invoiceId, reason: "Test: Storno" }),
      "POLICY_VIOLATION",
    );
    await cancelBooking(dispatcher, { bookingId, reason: "Test: Kunde storniert" });
    await voidInvoice(finance, { invoiceId, reason: "Test: Buchung storniert" });
    await requestRefund(finance, { paymentId, reason: "Test: Erstattung nach Storno" });
    await completeRefund(
      finance,
      { paymentId, reference: `Rücküberweisung ${randomUUID()}` },
      FINANCE_OPTIONS,
    );
    const invoice = await getInvoice(finance, { invoiceId });
    expect(invoice).toMatchObject({ status: "VOID", paidCents: 0 });
    expect(invoice.payments[0]?.status).toBe("REFUNDED");
    expect((await getBooking(finance, { bookingId })).paymentStatus).toBe("REFUNDED");
  });
});

describe("credit terms, overdue invoices and payment protection", () => {
  const email = uniqueEmail("credit-customer");
  let owner: { customerId: string; propertyId: string };
  let approvalId: string;
  let creditBookingId: string;
  let futureCreditBookingId: string;
  let futureJobId: string;
  let finalInvoiceId: string;

  it("keeps jobs 1 and 2 on prepayment and counts only completed AND paid jobs", async () => {
    owner = await customer(email);
    for (let job = 1; job <= 3; job += 1) {
      const bookingId = await booking(owner, CREDIT_OPTIONS);
      const created = await getBooking(finance, { bookingId });
      expect(created.paymentRequirement).toBe("VORKASSE_REQUIRED");
      expect(created.paymentDecision["reasons"]).toContain(
        job === 1 ? "NEW_CUSTOMER" : "INSUFFICIENT_PAID_ORDERS",
      );
      await payPrepayment(finance, bookingId);
      await completeJob(bookingId);
    }
    const { history, decision } = await evaluateCustomerPaymentTerms(db, owner.customerId, {
      policy: CREDIT_POLICY.policy,
      now: new Date(),
      timeZone: "Europe/Berlin",
    });
    expect(history.completedPaidOrders).toBe(3);
    // Three paid jobs are the minimum – never an approval.
    expect(decision).toMatchObject({
      outcome: "VORKASSE_REQUIRED",
      invoiceReviewEligible: true,
      reasons: ["CREDIT_APPROVAL_REQUIRED"],
    });
    const fourth = await booking(owner, CREDIT_OPTIONS);
    expect((await getBooking(finance, { bookingId: fourth })).paymentRequirement).toBe(
      "VORKASSE_REQUIRED",
    );
    await cancelBooking(dispatcher, { bookingId: fourth, reason: "Test: aufgeräumt" });
  });

  it("does not let a new account or a returning customer reset the history", async () => {
    // Same e-mail → identity matching resolves to the existing customer record.
    const again = await customer(email);
    expect(again.customerId).toBe(owner.customerId);
    const { history } = await evaluateCustomerPaymentTerms(db, owner.customerId, {
      policy: CREDIT_POLICY.policy,
      now: new Date(),
      timeZone: "Europe/Berlin",
    });
    expect(history.completedPaidOrders).toBe(3);
    // A linked customer account sees nothing of the risk data.
    const account = await contextForRole(db, "CUSTOMER", { customerId: owner.customerId });
    await expectDomainError(
      getCustomerRiskProfile(account, { customerId: owner.customerId }, CREDIT_FINANCE),
      "FORBIDDEN",
    );
  });

  it("requires a request and a second person's approval (four-eyes, audited)", async () => {
    await expectDomainError(
      requestCreditTerms(
        dispatcher,
        { customerId: owner.customerId, reason: "Test" },
        CREDIT_FINANCE,
      ),
      "FORBIDDEN",
    );
    await expectDomainError(
      requestCreditTerms(
        finance,
        { customerId: owner.customerId, reason: "Test", riskLevel: "LOW" },
        CREDIT_FINANCE,
      ),
      "VALIDATION_FAILED",
    );
    const results = await Promise.allSettled([
      requestCreditTerms(
        finance,
        { customerId: owner.customerId, reason: "Test: Antrag" },
        CREDIT_FINANCE,
      ),
      requestCreditTerms(
        finance2,
        { customerId: owner.customerId, reason: "Test: Antrag" },
        CREDIT_FINANCE,
      ),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    approvalId = (ok[0] as PromiseFulfilledResult<{ approvalId: string }>).value.approvalId;
    const requester = results[0].status === "fulfilled" ? finance : finance2;
    const approver = requester === finance ? finance2 : finance;
    const approval = {
      approvalId,
      creditLimitCents: 50_000,
      trustScore: 80,
      reason: "Test: Zahlungshistorie geprüft",
    };
    await expectDomainError(approveCreditTerms(requester, approval, CREDIT_FINANCE), "FORBIDDEN");
    await expectDomainError(approveCreditTerms(admin, approval, CREDIT_FINANCE), "FORBIDDEN");
    await expectDomainError(
      approveCreditTerms(approver, { ...approval, creditLimitCents: 5_000_000 }, CREDIT_FINANCE),
      "POLICY_VIOLATION",
    );
    await expectDomainError(
      approveCreditTerms(approver, { ...approval, trustScore: 10 }, CREDIT_FINANCE),
      "POLICY_VIOLATION",
    );
    // Concurrent decisions: exactly one wins.
    const decisions = await Promise.allSettled([
      approveCreditTerms(approver, approval, CREDIT_FINANCE),
      denyCreditTerms(approver, { approvalId, reason: "Test: parallel" }, CREDIT_FINANCE),
    ]);
    expect(decisions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [row] = await db
      .select()
      .from(schema.creditTermsApproval)
      .where(eq(schema.creditTermsApproval.id, approvalId));
    if (row?.status === "DENIED") {
      // Denied in the race: a new request and approval for the remaining tests.
      const { approvalId: next } = await requestCreditTerms(
        requester,
        { customerId: owner.customerId, reason: "Test: neuer Antrag" },
        CREDIT_FINANCE,
      );
      approvalId = next;
      await approveCreditTerms(approver, { ...approval, approvalId }, CREDIT_FINANCE);
    }
    const actions = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, owner.customerId));
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(["credit_terms.requested", "credit_terms.approved"]),
    );
  });

  it("books on credit terms, invoices only after the completed job and never marks it paid", async () => {
    creditBookingId = await booking(owner, CREDIT_OPTIONS);
    const created = await getBooking(finance, { bookingId: creditBookingId });
    expect(created).toMatchObject({
      paymentRequirement: "CREDIT_TERMS_APPROVED",
      paymentStatus: null,
      status: "CONFIRMED",
    });
    await expectDomainError(
      createInvoiceForBooking(finance, { bookingId: creditBookingId, kind: "FINAL" }),
      "POLICY_VIOLATION",
    );
    // A further credit booking with an assigned, not yet started job (before any overdue).
    futureCreditBookingId = await booking(owner, CREDIT_OPTIONS);
    const job = await createJobForBooking(dispatcher, { bookingId: futureCreditBookingId });
    futureJobId = job.jobId;
    await transitionJob(dispatcher, { jobId: futureJobId, to: "ASSIGNMENT_PENDING" });
    await assignJob(
      dispatcher,
      { jobId: futureJobId, kind: "EMPLOYEE", candidateId: employeeId },
      DEFAULT_OPERATIONS_CONFIG,
    );
    expect((await getBooking(finance, { bookingId: futureCreditBookingId })).status).toBe(
      "SCHEDULED",
    );
    await completeJob(creditBookingId);
    // Issued 30 days ago (test clock) → due 16 days ago → overdue now.
    const past = await contextForRole(
      db,
      "FINANCE",
      {},
      new TestClock(new Date(Date.now() - 30 * DAY)),
    );
    const { invoiceId } = await createInvoiceForBooking(past, {
      bookingId: creditBookingId,
      kind: "FINAL",
    });
    finalInvoiceId = invoiceId;
    await issueInvoice(past, { invoiceId }, CREDIT_FINANCE);
    await releaseInvoice(past, { invoiceId }, CREDIT_FINANCE);
    expect((await getInvoice(finance, { invoiceId })).status).toBe("OPEN");
  });

  it("forces prepayment for new orders as soon as an invoice is past due (before any run)", async () => {
    const bookingId = await booking(owner, CREDIT_OPTIONS);
    const created = await getBooking(finance, { bookingId });
    expect(created.paymentRequirement).toBe("VORKASSE_REQUIRED");
    expect(created.paymentDecision["reasons"]).toContain("OPEN_OVERDUE_INVOICE");
    await cancelBooking(dispatcher, { bookingId, reason: "Test: aufgeräumt" });
    // The not yet started credit job cannot start either.
    await expectDomainError(
      transitionJob(dispatcher, { jobId: futureJobId, to: "IN_PROGRESS" }, JOB_PAYMENT),
      "POLICY_VIOLATION",
    );
    // Without the payment context the credit job start is refused (CONFIG_REQUIRED).
    await expectDomainError(
      transitionJob(dispatcher, { jobId: futureJobId, to: "IN_PROGRESS" }),
      "CONFIG_REQUIRED",
    );
  });

  it("marks overdue invoices and switches future credit bookings to prepayment with review", async () => {
    await expectDomainError(runOverdueCheck(dispatcher, CREDIT_FINANCE), "FORBIDDEN");
    const result = await runOverdueCheck(finance, CREDIT_FINANCE);
    expect(result.invoicesMarkedOverdue).toBeGreaterThanOrEqual(1);
    expect((await getInvoice(finance, { invoiceId: finalInvoiceId })).status).toBe("OVERDUE");
    const protectedBooking = await getBooking(finance, { bookingId: futureCreditBookingId });
    expect(protectedBooking).toMatchObject({
      status: "PENDING_PAYMENT",
      paymentRequirement: "VORKASSE_REQUIRED",
      paymentStatus: "PAYMENT_REQUIRED",
      paymentReviewRequired: true,
    });
    // History is only appended: the job and its assignment still exist.
    const [job] = await db.select().from(schema.job).where(eq(schema.job.id, futureJobId));
    expect(job?.status).toBe("ASSIGNED");
    const profile = await getCustomerRiskProfile(
      finance,
      { customerId: owner.customerId },
      CREDIT_FINANCE,
    );
    expect(profile.decision.outcome).toBe("VORKASSE_REQUIRED");
    expect(profile.facts.overdueInvoices).toBe(1);
    expect(profile.facts.overdueAmountCents).toBe(GROSS);
    expect(profile.pendingReviewBookings).toBe(1);
    expect(profile.lastEvaluation?.trigger).toBe("OVERDUE");
    // Database guard: no credit booking while an invoice is overdue.
    await expectPgError(
      db
        .update(schema.booking)
        .set({
          paymentRequirement: "CREDIT_TERMS_APPROVED",
          paymentStatus: null,
          status: "CONFIRMED",
        })
        .where(eq(schema.booking.id, futureCreditBookingId)),
      "23514",
    );
    // A second run changes nothing (idempotent).
    const again = await runOverdueCheck(finance, CREDIT_FINANCE);
    expect((await getInvoice(finance, { invoiceId: finalInvoiceId })).status).toBe("OVERDUE");
    expect(again.bookingsSwitchedToPrepayment).toBe(0);
  });

  it("keeps the job blocked until the prepayment is paid and the review is cleared", async () => {
    await payPrepayment(finance, futureCreditBookingId);
    await expectDomainError(
      transitionJob(dispatcher, { jobId: futureJobId, to: "IN_PROGRESS" }, JOB_PAYMENT),
      "POLICY_VIOLATION",
    );
    // The late payment of the overdue invoice counts as late payment history.
    await payInvoice(finance, finalInvoiceId, { finance: CREDIT_FINANCE });
    const invoice = await getInvoice(finance, { invoiceId: finalInvoiceId });
    expect(invoice.status).toBe("PAID");
    const { history, decision } = await evaluateCustomerPaymentTerms(db, owner.customerId, {
      policy: CREDIT_POLICY.policy,
      now: new Date(),
      timeZone: "Europe/Berlin",
    });
    expect(history.latePaymentsInLookback).toBe(1);
    expect(decision.reasons).toContain("LATE_PAYMENT_HISTORY");
    // Only finance clears the review; afterwards the prepaid job may start.
    await expectDomainError(
      clearPaymentReview(dispatcher, { bookingId: futureCreditBookingId, reason: "Test" }),
      "FORBIDDEN",
    );
    await clearPaymentReview(finance, {
      bookingId: futureCreditBookingId,
      reason: "Test: Vorkasse bezahlt, Prüfung abgeschlossen",
    });
    await transitionJob(dispatcher, { jobId: futureJobId, to: "IN_PROGRESS" }, JOB_PAYMENT);
  });

  it("revokes credit terms and switches remaining credit bookings to prepayment", async () => {
    await revokeCreditTerms(
      finance,
      { approvalId, reason: "Test: Zahlungsverzug" },
      CREDIT_FINANCE,
    );
    const [row] = await db
      .select({ status: schema.creditTermsApproval.status })
      .from(schema.creditTermsApproval)
      .where(eq(schema.creditTermsApproval.id, approvalId));
    expect(row?.status).toBe("REVOKED");
    await expectPgError(
      db
        .update(schema.creditTermsApproval)
        .set({ status: "APPROVED" })
        .where(eq(schema.creditTermsApproval.id, approvalId)),
      "23514",
    );
    await expectPgError(
      db.delete(schema.creditTermsApproval).where(eq(schema.creditTermsApproval.id, approvalId)),
      "23000",
    );
  });
});

describe("customer portal and authorization (IDOR)", () => {
  it("shows customers only their own released invoices without internal data", async () => {
    const ownerA = await customer();
    const ownerB = await customer();
    const bookingA = await booking(ownerA);
    const invoiceA = await releasedInvoice(finance, bookingA);
    const draftB = await draftFor(await booking(ownerB));
    const releasedB = await releasedInvoice(finance, await booking(ownerB));
    const customerA = await contextForRole(db, "CUSTOMER", { customerId: ownerA.customerId });
    const customerB = await contextForRole(db, "CUSTOMER", { customerId: ownerB.customerId });

    const own = await getCustomerInvoice(customerA, { invoiceId: invoiceA });
    expect(own.grossCents).toBe(GROSS);
    const json = JSON.stringify(own);
    for (const internal of [
      "customerId",
      "recordedBy",
      "statusReason",
      "provider",
      "margin",
      "trust",
    ]) {
      expect(json).not.toContain(internal);
    }
    await expectDomainError(getCustomerInvoice(customerA, { invoiceId: releasedB }), "NOT_FOUND");
    await expectDomainError(getCustomerInvoice(customerB, { invoiceId: draftB }), "NOT_FOUND");
    await expectDomainError(
      getCustomerInvoice(customerA, { invoiceId: randomUUID() }),
      "NOT_FOUND",
    );
    const listA = await listCustomerInvoices(customerA, {});
    expect(listA.items.map((i) => i.id)).toEqual([invoiceA]);
    expect((await listCustomerInvoices(customerB, {})).items.map((i) => i.id)).toEqual([releasedB]);

    // Staff read models and all finance commands are closed to customers.
    await expectDomainError(getInvoice(customerA, { invoiceId: invoiceA }), "FORBIDDEN");
    await expectDomainError(listInvoices(customerA, {}, "2026-01-01"), "FORBIDDEN");
    await expectDomainError(
      recordPayment(customerA, {
        invoiceId: invoiceA,
        amountCents: GROSS,
        method: "BANK_TRANSFER",
        reference: "Eigene Angabe",
        receivedAt: new Date().toISOString(),
        idempotencyKey: `test:${randomUUID()}`,
      }),
      "FORBIDDEN",
    );
    await expectDomainError(
      createInvoiceForBooking(customerA, { bookingId: bookingA, kind: "PREPAYMENT" }),
      "FORBIDDEN",
    );
  });

  it("keeps dispatchers, staff and partners away from invoices, payments and risk data", async () => {
    const owner = await customer();
    const invoiceId = await releasedInvoice(finance, await booking(owner));
    const staff = await contextForRole(db, "STAFF");
    const partner = await contextForRole(db, "PARTNER", { partnerId: randomUUID() }).catch(
      () => null,
    );
    for (const ctx of [dispatcher, staff, ...(partner === null ? [] : [partner])]) {
      await expectDomainError(getInvoice(ctx, { invoiceId }), "FORBIDDEN");
      await expectDomainError(listPayments(ctx, {}), "FORBIDDEN");
      await expectDomainError(
        getCustomerRiskProfile(ctx, { customerId: owner.customerId }, FINANCE_OPTIONS),
        "FORBIDDEN",
      );
      await expectDomainError(
        voidInvoice(ctx, { invoiceId, reason: "Test: unberechtigt" }),
        "FORBIDDEN",
      );
    }
    // Admins manage invoices but cannot approve credit terms.
    await expect(getInvoice(admin, { invoiceId })).resolves.toMatchObject({ id: invoiceId });
  });
});

describe("database guards (defence in depth)", () => {
  it("rejects bypasses of the payment history and the invoice lifecycle", async () => {
    const owner = await customer();
    const bookingId = await booking(owner);
    // Prepayment cannot be confirmed without a paid prepayment invoice.
    await expectPgError(
      db
        .update(schema.booking)
        .set({ paymentStatus: "PAYMENT_CONFIRMED", status: "CONFIRMED" })
        .where(eq(schema.booking.id, bookingId)),
      "23514",
    );
    // Credit terms need an approval.
    await expectPgError(
      db
        .update(schema.booking)
        .set({ paymentRequirement: "CREDIT_TERMS_APPROVED", paymentStatus: null })
        .where(eq(schema.booking.id, bookingId)),
      "23514",
    );
    const invoiceId = await releasedInvoice(finance, bookingId);
    // Status jumps, paid flags and overpaid amounts are rejected.
    await expectPgError(
      db.update(schema.invoice).set({ status: "DRAFT" }).where(eq(schema.invoice.id, invoiceId)),
      "23514",
    );
    await expectPgError(
      db
        .update(schema.invoice)
        .set({ status: "PAID", paidAt: new Date() })
        .where(eq(schema.invoice.id, invoiceId)),
      "23514",
    );
    await expectPgError(
      db
        .update(schema.invoice)
        .set({ paidCents: GROSS + 1 })
        .where(eq(schema.invoice.id, invoiceId)),
      "23514",
    );
    await expectPgError(db.delete(schema.invoice).where(eq(schema.invoice.id, invoiceId)), "23000");
    await expectPgError(db.execute(sql`TRUNCATE "payment" CASCADE`), "23000");
    // Items only on drafts.
    const [item] = await db
      .select()
      .from(schema.invoiceItem)
      .where(eq(schema.invoiceItem.invoiceId, invoiceId));
    await expectPgError(
      db.insert(schema.invoiceItem).values({
        ...(item ?? { invoiceId }),
        id: randomUUID(),
        position: 99,
      } as typeof schema.invoiceItem.$inferInsert),
      "23000",
    );
    // Payments: facts immutable, status machine enforced, customer must match the invoice.
    const paymentId = await payInvoice(finance, invoiceId);
    await expectPgError(
      db.update(schema.payment).set({ amountCents: 1 }).where(eq(schema.payment.id, paymentId)),
      "23000",
    );
    await expectPgError(
      db.update(schema.payment).set({ status: "PENDING" }).where(eq(schema.payment.id, paymentId)),
      "23514",
    );
    const other = await customer();
    const otherInvoice = await releasedInvoice(finance, await booking(other));
    await expectPgError(
      db.insert(schema.payment).values({
        invoiceId: otherInvoice,
        customerId: owner.customerId,
        method: "BANK_TRANSFER",
        provider: "MANUAL",
        amountCents: 100,
        idempotencyKey: `test:${randomUUID()}`,
        receivedAt: new Date(),
      }),
      "23514",
    );
    await expectPgError(
      db
        .update(schema.paymentTransition)
        .set({ reason: "manipuliert" })
        .where(eq(schema.paymentTransition.paymentId, paymentId)),
      "23000",
    );
    await expectPgError(
      db
        .update(schema.paymentReference)
        .set({ reference: "manipuliert" })
        .where(eq(schema.paymentReference.paymentId, paymentId)),
      "23000",
    );
    await expectPgError(
      db
        .update(schema.paymentRiskEvaluation)
        .set({ outcome: "CREDIT_TERMS_ALLOWED" })
        .where(eq(schema.paymentRiskEvaluation.customerId, owner.customerId)),
      "23000",
    );
  });

  it("changes due dates only with a reason and re-derives the status", async () => {
    const owner = await customer();
    const invoiceId = await releasedInvoice(finance, await booking(owner));
    const row = await invoiceRow(invoiceId);
    await expectDomainError(
      changeInvoiceDueDate(
        finance,
        { invoiceId, dueDate: "2000-01-01", reason: "Test" },
        FINANCE_OPTIONS,
      ),
      "VALIDATION_FAILED",
    );
    await changeInvoiceDueDate(
      finance,
      { invoiceId, dueDate: row.issueDate ?? "", reason: "Test: Fälligkeit angepasst" },
      FINANCE_OPTIONS,
    );
    expect((await invoiceRow(invoiceId)).dueDate).toBe(row.issueDate);
    const actions = await db
      .select({ action: schema.auditLog.action, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.entityId, invoiceId),
          eq(schema.auditLog.action, "invoice.due_date_changed"),
        ),
      );
    expect(actions).toHaveLength(1);
    expect(JSON.stringify(actions[0]?.after)).toContain("manualOverride");
  });
});

describe("payment provider (not active) and webhook security", () => {
  it("never pretends a payment without a configured provider", async () => {
    const owner = await customer();
    const invoiceId = await releasedInvoice(finance, await booking(owner));
    await expectDomainError(
      startProviderPayment(
        finance,
        { invoiceId, method: "CARD", idempotencyKey: `test:${randomUUID()}` },
        UNCONFIGURED_PAYMENT_PROVIDER,
      ),
      "CONFIG_REQUIRED",
    );
    await expectDomainError(
      processProviderWebhook(
        { db, clock: finance.clock },
        { provider: UNCONFIGURED_PAYMENT_PROVIDER, signingSecret: TEST_WEBHOOK_SECRET },
        { rawBody: "{}", signatureHeader: null },
        FINANCE_OPTIONS,
      ),
      "CONFIG_REQUIRED",
    );
    expect((await listPayments(finance, { invoiceId })).total).toBe(0);
  });

  it("processes verified events idempotently and ignores replays and out-of-order events", async () => {
    const provider = new TestPaymentProvider();
    const config = { provider, signingSecret: TEST_WEBHOOK_SECRET };
    const owner = await customer();
    const bookingId = await booking(owner);
    const invoiceId = await releasedInvoice(finance, bookingId);
    const { paymentId } = await startProviderPayment(
      finance,
      { invoiceId, method: "CARD", idempotencyKey: `test:${randomUUID()}` },
      provider,
    );
    const [payment] = await db
      .select()
      .from(schema.payment)
      .where(eq(schema.payment.id, paymentId));
    const providerPaymentId = payment?.providerPaymentId ?? "";
    const event = (type: string, id = `evt_${randomUUID()}`, amountCents = GROSS) => ({
      id,
      type,
      occurredAt: new Date().toISOString(),
      data: { providerPaymentId, amountCents, currency: "EUR" },
    });
    const deliver = (body: unknown, secret?: string) =>
      processProviderWebhook(
        { db, clock: finance.clock },
        config,
        signedDelivery(body, new Date(), secret),
        FINANCE_OPTIONS,
      );

    // Forged signature: rejected, nothing stored.
    await expectDomainError(
      deliver(event("payment.succeeded"), "wrong-secret-0123456789"),
      "UNAUTHENTICATED",
    );
    // Body claims success, provider says pending → rejected (no trust in the body).
    expect((await deliver(event("payment.succeeded"))).outcome).toBe("REJECTED_UNVERIFIED");
    // Amount mismatch → rejected.
    provider.set(providerPaymentId, "SUCCEEDED");
    expect((await deliver(event("payment.succeeded", undefined, 1))).outcome).toBe(
      "REJECTED_MISMATCH",
    );
    expect((await getInvoice(finance, { invoiceId })).status).toBe("OPEN");

    // Verified success, delivered twice concurrently: processed exactly once.
    const success = event("payment.succeeded");
    const results = await Promise.all([deliver(success), deliver(success)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["DUPLICATE", "PROCESSED"]);
    expect(await getInvoice(finance, { invoiceId })).toMatchObject({
      status: "PAID",
      paidCents: GROSS,
    });
    expect((await getBooking(finance, { bookingId })).paymentStatus).toBe("PAYMENT_CONFIRMED");
    // Replay with a new event id and an older state: ignored, never regresses.
    expect((await deliver(event("payment.succeeded"))).outcome).toBe("IGNORED_OUT_OF_ORDER");
    expect((await deliver(event("payment.authorized"))).outcome).toBe("IGNORED_OUT_OF_ORDER");
    // Manual shortcuts on provider payments are refused.
    await expectDomainError(
      recordChargeback(finance, { paymentId, reason: "Test" }, FINANCE_OPTIONS),
      "POLICY_VIOLATION",
    );
    // Unknown payment id: stored as ignored.
    const unknown = {
      ...event("payment.succeeded"),
      data: { providerPaymentId: "pi_unknown", amountCents: GROSS, currency: "EUR" },
    };
    expect((await deliver(unknown)).outcome).toBe("IGNORED_UNKNOWN_PAYMENT");

    // Verified chargeback: invoice open again, booking under review, risk sees it.
    provider.set(providerPaymentId, "CHARGED_BACK");
    expect((await deliver(event("payment.charged_back"))).outcome).toBe("PROCESSED");
    expect(await getInvoice(finance, { invoiceId })).toMatchObject({ paidCents: 0 });
    expect((await getBooking(finance, { bookingId })).paymentReviewRequired).toBe(true);
    const { history } = await evaluateCustomerPaymentTerms(db, owner.customerId, {
      policy: DEFAULT_PAYMENT_POLICY,
      now: new Date(),
      timeZone: "Europe/Berlin",
    });
    expect(history.chargebacksInLookback).toBe(1);
    const events = await db
      .select({ status: schema.paymentProviderEvent.status })
      .from(schema.paymentProviderEvent)
      .where(eq(schema.paymentProviderEvent.provider, provider.key));
    expect(events.length).toBeGreaterThanOrEqual(6);
    await expectPgError(
      db
        .update(schema.paymentProviderEvent)
        .set({ eventType: "manipuliert" })
        .where(eq(schema.paymentProviderEvent.provider, provider.key)),
      "23000",
    );
  });
});
