import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema } from "@isela/database";
import type { EmailMessage, EmailSender } from "@isela/notifications";
import {
  DEFAULT_OPERATIONS_CONFIG,
  DEFAULT_RECURRING_CONFIG,
  createServiceContract,
  recordHolidayYear,
  runScheduledWork,
} from "@isela/operations";
import { contextForRole, openTestDatabase } from "../support/fixtures.ts";
import {
  PAYMENT_POLICY,
  acceptedQuote,
  activeServiceArea,
  geocodedCustomer,
  testService,
  type StaffCtx,
} from "../support/operations.ts";

/*
 * Scheduled run (generation → reminders → dispatch). The holiday region is fictitious TEST
 * data. E-mails go to an in-memory sender.
 */

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

const CENTER = { latitude: -34.4, longitude: 19.2 };
const REGION = `XS-${randomBytes(2).toString("hex").toUpperCase().slice(0, 3)}`;
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

let serviceAccount: StaffCtx;
let admin: StaffCtx;
let contractId: string;

class NullSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    await Promise.resolve();
    this.sent.push(message);
  }
}

function deps(region: string | null, sender = new NullSender()) {
  return {
    ctx: serviceAccount,
    paymentPolicy: PAYMENT_POLICY,
    config: DEFAULT_OPERATIONS_CONFIG,
    recurring: { ...DEFAULT_RECURRING_CONFIG, holidayRegion: region, generationHorizonDays: 30 },
    sender,
    isEmailSuppressed: () => Promise.resolve(false),
    dispatchEnabled: true,
  };
}

async function bookingsOf(id: string) {
  return db
    .select({ bookingId: schema.contractOccurrence.bookingId })
    .from(schema.contractOccurrence)
    .where(eq(schema.contractOccurrence.contractId, id));
}

beforeAll(async () => {
  // A dedicated service account (dispatcher permissions) – every booking is attributable.
  serviceAccount = await contextForRole(db, "DISPATCHER");
  admin = await contextForRole(db, "ADMIN");
  await activeServiceArea(admin, CENTER);
  const ids = await testService(admin, db, { qualifications: ["glass"] });
  const customer = await geocodedCustomer(db, serviceAccount, CENTER);
  const quoteId = await acceptedQuote(serviceAccount, admin, { ...customer, ...ids });
  ({ contractId } = await createServiceContract(serviceAccount, {
    quoteId,
    frequency: "WEEKLY",
    startDate: day(5),
    endDate: null,
    windowStartMinute: 10 * 60,
    windowEndMinute: 14 * 60,
    durationMinutes: 120,
  }));
});

describe("scheduled work", () => {
  it("generates nothing without a configured holiday region but still processes reminders", async () => {
    const result = await runScheduledWork(deps(null));
    expect(result.skippedOverlap).toBe(false);
    expect(result.generation).toEqual({ status: "SKIPPED", reason: "HOLIDAY_REGION_MISSING" });
    expect(result.dispatch).not.toBeNull();
    expect(await bookingsOf(contractId)).toEqual([]);
  });

  it("counts contracts without verified holiday data as failures without stopping the run", async () => {
    const result = await runScheduledWork(deps(REGION));
    expect(result.generation.status).toBe("DONE");
    if (result.generation.status === "DONE") {
      expect(result.generation.failures["POLICY_VIOLATION"]).toBeGreaterThanOrEqual(1);
    }
    expect(await bookingsOf(contractId)).toEqual([]);
  });

  it("generates once with approved data; repeated and overlapping runs create no duplicates", async () => {
    for (const year of [...new Set([day(0).slice(0, 4), day(30).slice(0, 4)])].map(Number)) {
      await recordHolidayYear(admin, {
        region: REGION,
        year,
        sourceReference: "TEST DATA – fictitious calendar for automated tests",
        holidays: [],
      });
    }
    const [a, b] = await Promise.all([
      runScheduledWork(deps(REGION)),
      runScheduledWork(deps(REGION)),
    ]);
    // Either the second run was skipped by the lock, or it found everything existing.
    expect([a, b].filter((r) => !r.skippedOverlap).length).toBeGreaterThanOrEqual(1);
    const first = await bookingsOf(contractId);
    expect(first.length).toBeGreaterThan(0);
    const again = await runScheduledWork(deps(REGION));
    expect(again.skippedOverlap).toBe(false);
    const second = await bookingsOf(contractId);
    expect(second).toHaveLength(first.length);
    const ids = second.map((r) => r.bookingId).filter((id) => id !== null);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("enqueues but never delivers when dispatch is disabled", async () => {
    const sender = new NullSender();
    const result = await runScheduledWork({ ...deps(REGION, sender), dispatchEnabled: false });
    expect(result.dispatch).toBeNull();
    expect(sender.sent).toEqual([]);
  });
});
