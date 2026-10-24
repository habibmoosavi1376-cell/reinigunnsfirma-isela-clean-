import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema } from "@isela/database";
import type { EmailMessage, EmailSender } from "@isela/notifications";
import {
  DEFAULT_OPERATIONS_CONFIG,
  cancelBooking,
  createBookingFromQuote,
  dispatchNotifications,
  enqueueAppointmentReminders,
  getBooking,
  transitionPaymentStatus,
} from "@isela/operations";
import { TestClock, contextForRole, openTestDatabase, uniqueEmail } from "../support/fixtures.ts";
import {
  PAYMENT_POLICY,
  acceptedQuote,
  activeServiceArea,
  futureSlot,
  geocodedCustomer,
  payPrepayment,
  testService,
  type StaffCtx,
} from "../support/operations.ts";

/*
 * Day 8: appointment reminders through the outbox. E-mails go to an in-memory capturing
 * sender (test mode) – nothing leaves the test process. All addresses are test addresses.
 */

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

const CENTER = { latitude: -33.6, longitude: 19.0 };
const TZ = DEFAULT_OPERATIONS_CONFIG.timeZone;
const OPTIONS = { paymentPolicy: PAYMENT_POLICY, config: DEFAULT_OPERATIONS_CONFIG };

let dispatcher: StaffCtx;
let admin: StaffCtx;
let finance: StaffCtx;
let ids: { serviceId: string; categoryId: string };

class CapturingSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failures = 0;
  async send(message: EmailMessage): Promise<void> {
    await Promise.resolve();
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("temporary SMTP failure (test)");
    }
    this.sent.push(message);
  }
}

const notSuppressed = { isEmailSuppressed: () => Promise.resolve(false) };

/** Confirmed, paid prepayment booking; optionally with a verified customer account. */
async function confirmedBooking(options: { account?: "verified" | "unverified" | "none" } = {}) {
  const customer = await geocodedCustomer(db, dispatcher, CENTER);
  const quoteId = await acceptedQuote(dispatcher, admin, { ...customer, ...ids });
  const slot = futureSlot(1);
  const { bookingId } = await createBookingFromQuote(dispatcher, { quoteId, ...slot }, OPTIONS);
  await transitionPaymentStatus(finance, { bookingId, to: "PAYMENT_PENDING" });
  await payPrepayment(finance, bookingId);
  let email: string | null = null;
  if ((options.account ?? "verified") !== "none") {
    email = uniqueEmail("reminder");
    const userId = randomUUID();
    await db.insert(schema.user).values({
      id: userId,
      name: "Erinnerung Testkonto",
      email,
      emailVerified: options.account !== "unverified",
    });
    await db
      .insert(schema.userRole)
      .values({ userId, roleKey: "CUSTOMER", customerId: customer.customerId });
  }
  return { bookingId, email, windowStart: new Date(slot.windowStart) };
}

/** A job clock 24 hours before the appointment. */
function clockBefore(windowStart: Date, hours = 24) {
  return new TestClock(new Date(windowStart.getTime() - hours * 3_600_000));
}

async function outboxRow(bookingId: string) {
  const rows = await db
    .select()
    .from(schema.notificationOutbox)
    .where(eq(schema.notificationOutbox.bookingId, bookingId));
  return rows;
}

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  admin = await contextForRole(db, "ADMIN");
  finance = await contextForRole(db, "FINANCE");
  await activeServiceArea(admin, CENTER);
  ids = await testService(admin, db, { qualifications: ["glass"] });
});

describe("appointment reminders", () => {
  it("enqueues once and delivers exactly once to the verified account, without prices", async () => {
    const { bookingId, email, windowStart } = await confirmedBooking();
    expect((await getBooking(dispatcher, { bookingId })).status).toBe("CONFIRMED");
    const clock = clockBefore(windowStart);
    await enqueueAppointmentReminders({ db, clock }, { leadHours: 48 });
    await enqueueAppointmentReminders({ db, clock }, { leadHours: 48 });
    expect(await outboxRow(bookingId)).toHaveLength(1);

    const sender = new CapturingSender();
    await dispatchNotifications(
      { db, clock },
      { timeZone: TZ, batchSize: 100 },
      { sender, ...notSuppressed },
    );
    await dispatchNotifications(
      { db, clock },
      { timeZone: TZ, batchSize: 100 },
      { sender, ...notSuppressed },
    );
    const mine = sender.sent.filter((m) => m.to === email);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.purpose).toBe("booking.appointment-reminder");
    expect(mine[0]?.text).not.toMatch(/€|EUR|\d+,\d{2}/);
    const [row] = await outboxRow(bookingId);
    expect(row).toMatchObject({ status: "SENT", attempts: 1, lastErrorCode: null });
  });

  it("does not remind unpaid (unconfirmed) bookings", async () => {
    const customer = await geocodedCustomer(db, dispatcher, CENTER);
    const quoteId = await acceptedQuote(dispatcher, admin, { ...customer, ...ids });
    const slot = futureSlot(1);
    const { bookingId, status } = await createBookingFromQuote(
      dispatcher,
      { quoteId, ...slot },
      OPTIONS,
    );
    expect(status).toBe("PENDING_PAYMENT");
    await enqueueAppointmentReminders(
      { db, clock: clockBefore(new Date(slot.windowStart)) },
      { leadHours: 48 },
    );
    expect(await outboxRow(bookingId)).toEqual([]);
  });

  it("retries temporary failures with backoff and gives up after the maximum", async () => {
    const { bookingId, windowStart } = await confirmedBooking();
    const clock = clockBefore(windowStart);
    await enqueueAppointmentReminders({ db, clock }, { leadHours: 48 });
    const sender = new CapturingSender();
    sender.failures = 1_000;
    const opts = { timeZone: TZ, batchSize: 100, maxAttempts: 2 };
    await dispatchNotifications({ db, clock }, opts, { sender, ...notSuppressed });
    let [row] = await outboxRow(bookingId);
    expect(row).toMatchObject({ status: "PENDING", attempts: 1, lastErrorCode: "SEND_FAILED" });
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(clock.now().getTime());
    // Not due yet: nothing happens.
    await dispatchNotifications({ db, clock }, opts, { sender, ...notSuppressed });
    expect((await outboxRow(bookingId))[0]?.attempts).toBe(1);
    clock.advance(60 * 60_000);
    await dispatchNotifications({ db, clock }, opts, { sender, ...notSuppressed });
    [row] = await outboxRow(bookingId);
    expect(row).toMatchObject({ status: "DEAD", attempts: 2 });
  });

  it("skips customers without a verified account, suppressed addresses and cancelled bookings", async () => {
    const none = await confirmedBooking({ account: "none" });
    const unverified = await confirmedBooking({ account: "unverified" });
    const suppressed = await confirmedBooking();
    const cancelled = await confirmedBooking();
    await cancelBooking(dispatcher, {
      bookingId: cancelled.bookingId,
      reason: "Kunde hat abgesagt (Test)",
    });
    const clock = clockBefore(none.windowStart);
    // Enqueue before the cancellation would have been visible: insert directly for the
    // cancelled booking to prove the dispatcher re-checks the subject.
    await enqueueAppointmentReminders({ db, clock }, { leadHours: 48 });
    const [cancelledBooking] = await db
      .select({ customerId: schema.booking.customerId })
      .from(schema.booking)
      .where(eq(schema.booking.id, cancelled.bookingId));
    await db
      .insert(schema.notificationOutbox)
      .values({
        purpose: "APPOINTMENT_REMINDER",
        dedupeKey: `APPOINTMENT_REMINDER:${cancelled.bookingId}`,
        customerId: cancelledBooking?.customerId ?? "",
        bookingId: cancelled.bookingId,
        nextAttemptAt: clock.now(),
      })
      .onConflictDoNothing();
    const sender = new CapturingSender();
    await dispatchNotifications(
      { db, clock },
      { timeZone: TZ, batchSize: 100 },
      { sender, isEmailSuppressed: (e) => Promise.resolve(e === suppressed.email) },
    );
    expect((await outboxRow(none.bookingId))[0]?.status).toBe("NO_RECIPIENT");
    expect((await outboxRow(unverified.bookingId))[0]?.status).toBe("NO_RECIPIENT");
    expect((await outboxRow(suppressed.bookingId))[0]?.status).toBe("SUPPRESSED");
    expect((await outboxRow(cancelled.bookingId))[0]?.status).toBe("OBSOLETE");
    expect(sender.sent.some((m) => m.to === suppressed.email || m.to === unverified.email)).toBe(
      false,
    );
  });

  it("never resends a delivery that may have happened (stale SENDING becomes UNCERTAIN)", async () => {
    const { bookingId, email, windowStart } = await confirmedBooking();
    const clock = clockBefore(windowStart);
    await enqueueAppointmentReminders({ db, clock }, { leadHours: 48 });
    // Simulate a crash after the provider call: the row stays SENDING.
    await db
      .update(schema.notificationOutbox)
      .set({ status: "SENDING", claimedAt: clock.now(), attempts: 1 })
      .where(eq(schema.notificationOutbox.bookingId, bookingId));
    clock.advance(30 * 60_000);
    const sender = new CapturingSender();
    const result = await dispatchNotifications(
      { db, clock },
      { timeZone: TZ, batchSize: 100, staleAfterMinutes: 15 },
      { sender, ...notSuppressed },
    );
    expect(result.uncertain).toBeGreaterThanOrEqual(1);
    expect((await outboxRow(bookingId))[0]).toMatchObject({
      status: "UNCERTAIN",
      lastErrorCode: "STALE_SENDING",
    });
    expect(sender.sent.some((m) => m.to === email)).toBe(false);
  });

  it("delivers once even with concurrent dispatchers", async () => {
    const { bookingId, email, windowStart } = await confirmedBooking();
    const clock = clockBefore(windowStart);
    await enqueueAppointmentReminders({ db, clock }, { leadHours: 48 });
    const sender = new CapturingSender();
    await Promise.all(
      [1, 2, 3].map(() =>
        dispatchNotifications(
          { db, clock },
          { timeZone: TZ, batchSize: 100 },
          { sender, ...notSuppressed },
        ),
      ),
    );
    expect(sender.sent.filter((m) => m.to === email)).toHaveLength(1);
    expect((await outboxRow(bookingId))[0]?.status).toBe("SENT");
  });
});
