import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema } from "@isela/database";
import {
  DEFAULT_OPERATIONS_CONFIG,
  MAX_GENERATION_DAYS,
  addContractPause,
  createBookingFromQuote,
  createServiceContract,
  generateContractBookings,
  getBooking,
  getServiceContract,
  recordHolidayYear,
} from "@isela/operations";
import { expectDomainError, expectPgError } from "../support/assertions.ts";
import { anonymousContext, contextForRole, openTestDatabase } from "../support/fixtures.ts";
import {
  PAYMENT_POLICY,
  acceptedQuote,
  activeServiceArea,
  futureSlot,
  geocodedCustomer,
  testService,
  type StaffCtx,
} from "../support/operations.ts";

/*
 * Day 8: recurring service contracts. The holiday region is a fictitious test region with a
 * random code per run and the holiday rows are invented TEST dates – they are not real
 * public holidays and never leave the test database.
 */

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

const CENTER = { latitude: -34.05, longitude: 18.6 };
const REGION = `XT-${randomBytes(2).toString("hex").toUpperCase().slice(0, 3)}`;
const DAY = 86_400_000;

let dispatcher: StaffCtx;
let admin: StaffCtx;
let ids: { serviceId: string; categoryId: string };

function day(offset: number): string {
  return new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
}

/** A weekday-aligned start a few days ahead (well after "now"). */
const START = day(10);
const FROM = day(7);
const TO = day(70);

function options(region = REGION) {
  return {
    paymentPolicy: PAYMENT_POLICY,
    config: DEFAULT_OPERATIONS_CONFIG,
    holidayRegion: region,
  };
}

async function newContract(frequency: "WEEKLY" | "BIWEEKLY" | "MONTHLY" = "WEEKLY") {
  const customer = await geocodedCustomer(db, dispatcher, CENTER);
  const quoteId = await acceptedQuote(dispatcher, admin, { ...customer, ...ids });
  const startDate = frequency === "MONTHLY" ? `${START.slice(0, 8)}15` : START;
  const { contractId } = await createServiceContract(dispatcher, {
    quoteId,
    frequency,
    startDate: startDate < FROM ? `${day(40).slice(0, 8)}15` : startDate,
    endDate: null,
    windowStartMinute: 9 * 60,
    windowEndMinute: 13 * 60,
    durationMinutes: 180,
  });
  return { ...customer, quoteId, contractId };
}

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  admin = await contextForRole(db, "ADMIN");
  await activeServiceArea(admin, CENTER);
  ids = await testService(admin, db, { qualifications: ["glass"] });
  const years = [...new Set([FROM.slice(0, 4), TO.slice(0, 4)])].map(Number);
  for (const year of years) {
    await recordHolidayYear(admin, {
      region: REGION,
      year,
      sourceReference: "TEST DATA – fictitious calendar for automated tests",
      holidays: [day(24), day(25)]
        .filter((d) => d.startsWith(`${String(year)}-`))
        .map((date) => ({ date, name: "Testfeiertag (fiktiv)" })),
    });
  }
});

describe("recurring service contracts", () => {
  it("generates bookings only for future appointments, all on prepayment for a new customer", async () => {
    const { contractId, customerId } = await newContract();
    const result = await generateContractBookings(
      dispatcher,
      { contractId, from: FROM, to: TO },
      options(),
    );
    expect(result.created.length + result.skipped.length).toBeGreaterThanOrEqual(8);
    expect(result.created.every((c) => c.paymentRequirement === "VORKASSE_REQUIRED")).toBe(true);
    const first = result.created[0];
    if (first === undefined) throw new Error("no booking generated");
    const booking = await getBooking(dispatcher, { bookingId: first.bookingId });
    expect(booking).toMatchObject({
      customerId,
      source: "CONTRACT",
      quoteId: null,
      status: "PENDING_PAYMENT",
      paymentStatus: "PAYMENT_REQUIRED",
    });
    expect(booking.paymentDecision).toMatchObject({ outcome: "VORKASSE_REQUIRED" });
    expect((booking.paymentDecision as { reasons: string[] }).reasons).toContain("NEW_CUSTOMER");
    expect(booking.items.length).toBeGreaterThan(0);
  });

  it("is idempotent: repeated and concurrent runs never create duplicate bookings", async () => {
    const { contractId } = await newContract();
    const [a, b] = await Promise.all([
      generateContractBookings(dispatcher, { contractId, from: FROM, to: TO }, options()),
      generateContractBookings(dispatcher, { contractId, from: FROM, to: TO }, options()),
    ]);
    const third = await generateContractBookings(
      dispatcher,
      { contractId, from: FROM, to: TO },
      options(),
    );
    // Either run may win any appointment: together they cover every row exactly once.
    const view = await getServiceContract(dispatcher, { contractId });
    const total = view.occurrences.length;
    expect(total).toBeGreaterThan(0);
    for (const run of [a, b]) {
      expect(run.created.length + run.skipped.length + run.existing).toBe(total);
    }
    expect(a.created.length + b.created.length).toBe(
      view.occurrences.filter((o) => o.status === "BOOKED").length,
    );
    expect(a.skipped.length + b.skipped.length).toBe(
      view.occurrences.filter((o) => o.status === "SKIPPED").length,
    );
    expect(third.created).toEqual([]);
    expect(third.skipped).toEqual([]);
    expect(third.existing).toBe(total);
    const rows = await db
      .select({ bookingId: schema.contractOccurrence.bookingId })
      .from(schema.contractOccurrence)
      .where(eq(schema.contractOccurrence.contractId, contractId));
    const bookingIds = rows.map((r) => r.bookingId).filter((id) => id !== null);
    expect(new Set(bookingIds).size).toBe(bookingIds.length);
  });

  it("skips verified holidays and paused days instead of booking them", async () => {
    const { contractId } = await newContract();
    await addContractPause(dispatcher, {
      contractId,
      fromDate: day(30),
      toDate: day(44),
      reason: "Betriebsurlaub Kunde (Test)",
    });
    const result = await generateContractBookings(
      dispatcher,
      { contractId, from: FROM, to: TO },
      options(),
    );
    const view = await getServiceContract(dispatcher, { contractId });
    for (const o of view.occurrences) {
      if (o.date >= day(30) && o.date <= day(44)) expect(o.status).toBe("SKIPPED");
      if (o.status === "SKIPPED") expect(o.bookingId).toBeNull();
      if (o.status === "BOOKED") expect(o.skipReason).toBeNull();
    }
    expect(result.skipped.some((s) => s.reason === "PAUSED")).toBe(true);
  });

  it("refuses generation without verified holiday data and for long windows", async () => {
    const { contractId } = await newContract();
    await expectDomainError(
      generateContractBookings(dispatcher, { contractId, from: FROM, to: TO }, options("XT-ZZZ")),
      "POLICY_VIOLATION",
    );
    const tooFar = new Date(Date.parse(`${FROM}T00:00:00Z`) + MAX_GENERATION_DAYS * DAY)
      .toISOString()
      .slice(0, 10);
    await expectDomainError(
      generateContractBookings(dispatcher, { contractId, from: FROM, to: tooFar }, options()),
      "VALIDATION_FAILED",
    );
    const rows = await db
      .select()
      .from(schema.contractOccurrence)
      .where(eq(schema.contractOccurrence.contractId, contractId));
    expect(rows).toEqual([]);
  });

  it("accepts only accepted, unbooked quotes and one contract per quote", async () => {
    const customer = await geocodedCustomer(db, dispatcher, CENTER);
    const quoteId = await acceptedQuote(dispatcher, admin, { ...customer, ...ids });
    const contract = {
      quoteId,
      frequency: "WEEKLY",
      startDate: START,
      endDate: null,
      windowStartMinute: 9 * 60,
      windowEndMinute: 13 * 60,
      durationMinutes: 180,
    };
    await createServiceContract(dispatcher, contract);
    await expectDomainError(createServiceContract(dispatcher, contract), "CONFLICT");
    // A quote that already became a single booking cannot become a contract.
    const other = await geocodedCustomer(db, dispatcher, CENTER);
    const booked = await acceptedQuote(dispatcher, admin, { ...other, ...ids });
    await createBookingFromQuote(
      dispatcher,
      { quoteId: booked, ...futureSlot(2) },
      { paymentPolicy: PAYMENT_POLICY, config: DEFAULT_OPERATIONS_CONFIG },
    );
    await expectDomainError(
      createServiceContract(dispatcher, { ...contract, quoteId: booked }),
      "CONFLICT",
    );
    for (const bad of [
      { ...contract, windowEndMinute: 9 * 60 },
      { ...contract, durationMinutes: 300 },
      { ...contract, frequency: "MONTHLY", startDate: `${START.slice(0, 8)}30` },
      { ...contract, frequency: "DAILY" },
    ]) {
      await expectDomainError(createServiceContract(dispatcher, bad), "VALIDATION_FAILED");
    }
  });

  it("enforces permissions server-side", async () => {
    const { contractId, quoteId } = await newContract();
    const customerCtx = await contextForRole(db, "FINANCE");
    await expectDomainError(
      generateContractBookings(customerCtx, { contractId, from: FROM, to: TO }, options()),
      "FORBIDDEN",
    );
    await expectDomainError(
      createServiceContract(anonymousContext(db), { quoteId }),
      "UNAUTHENTICATED",
    );
    await expectDomainError(
      recordHolidayYear(dispatcher, {
        region: REGION,
        year: 2099,
        sourceReference: "TEST DATA",
        holidays: [],
      }),
      "FORBIDDEN",
    );
  });

  it("records a holiday year once and validates its data", async () => {
    const region = `XT-${randomBytes(2).toString("hex").toUpperCase().slice(0, 3)}`;
    const base = { region, year: 2098, sourceReference: "TEST DATA – fictitious", holidays: [] };
    await expectDomainError(
      recordHolidayYear(admin, {
        ...base,
        holidays: [{ date: "2097-01-01", name: "Falsches Jahr (Test)" }],
      }),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      recordHolidayYear(admin, {
        ...base,
        holidays: [
          { date: "2098-05-05", name: "Doppelt (Test)" },
          { date: "2098-05-05", name: "Doppelt (Test)" },
        ],
      }),
      "VALIDATION_FAILED",
    );
    await recordHolidayYear(admin, base);
    await expectDomainError(recordHolidayYear(admin, base), "CONFLICT");
  });

  it("is guarded in the database: one row per day, consistent states, contract bookings without quote", async () => {
    const { contractId } = await newContract();
    const result = await generateContractBookings(
      dispatcher,
      { contractId, from: FROM, to: TO },
      options(),
    );
    const first = result.created[0];
    if (first === undefined) throw new Error("no booking generated");
    const [row] = await db
      .select()
      .from(schema.contractOccurrence)
      .where(eq(schema.contractOccurrence.bookingId, first.bookingId));
    if (row === undefined) throw new Error("occurrence missing");
    // Duplicate day for the same contract.
    await expectPgError(
      db.insert(schema.contractOccurrence).values({
        contractId,
        occurrenceDate: row.occurrenceDate,
        status: "SKIPPED",
        skipReason: "PAUSED",
      }),
      "23505",
    );
    // BOOKED without a booking and SKIPPED without a reason are rejected.
    await expectPgError(
      db.insert(schema.contractOccurrence).values({
        contractId,
        occurrenceDate: "2099-01-01",
        status: "BOOKED",
      }),
      "23514",
    );
    await expectPgError(
      db.insert(schema.contractOccurrence).values({
        contractId,
        occurrenceDate: "2099-01-02",
        status: "SKIPPED",
      }),
      "23514",
    );
    // A contract booking can never carry a quote id (one booking per quote stays intact).
    const [contract] = await db
      .select({ quoteId: schema.serviceContract.quoteId })
      .from(schema.serviceContract)
      .where(eq(schema.serviceContract.id, contractId));
    await expectPgError(
      db
        .update(schema.booking)
        .set({ quoteId: contract?.quoteId ?? null })
        .where(eq(schema.booking.id, first.bookingId)),
      "23514",
    );
  });
});
