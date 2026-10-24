import { and, asc, eq, gt, inArray, lt, lte, schema, sql, type Database } from "@isela/database";
import type { EmailSender } from "@isela/notifications";
import type { Clock, DomainLogger } from "@isela/shared";
import { z } from "@isela/validation";

/*
 * Appointment reminders through the transactional outbox (day 8). System jobs (db + clock,
 * no user actor), safe to run repeatedly and concurrently:
 * - enqueueAppointmentReminders: one row per booking (unique dedupe key) for confirmed
 *   appointments starting within the lead time. Only CONFIRMED/SCHEDULED bookings qualify –
 *   the database already guarantees that a prepayment booking is only confirmed when paid.
 * - dispatchNotifications: claims due rows with FOR UPDATE SKIP LOCKED, commits SENDING, then
 *   calls the EmailSender (at-most-once). Recipient = verified e-mail of an account linked to
 *   the customer, resolved at send time; suppressed addresses are never contacted.
 * Logs carry ids and counts only – never addresses, names or message content.
 * Review requests are NOT part of this module: their legal basis is an open owner decision.
 */

export interface NotificationJobContext {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger?: DomainLogger;
}

const enqueueOptionsSchema = z.strictObject({
  /** Remind appointments that start within this many hours. */
  leadHours: z.number().int().min(1).max(168),
});

export async function enqueueAppointmentReminders(
  job: NotificationJobContext,
  options: z.input<typeof enqueueOptionsSchema>,
): Promise<{ enqueued: number }> {
  const { leadHours } = enqueueOptionsSchema.parse(options);
  const now = job.clock.now();
  const until = new Date(now.getTime() + leadHours * 3_600_000);
  const b = schema.booking;
  const due = await job.db
    .select({ id: b.id, customerId: b.customerId })
    .from(b)
    .where(
      and(
        inArray(b.status, ["CONFIRMED", "SCHEDULED"]),
        gt(b.windowStart, now),
        lte(b.windowStart, until),
      ),
    )
    .orderBy(asc(b.windowStart))
    .limit(1000);
  if (due.length === 0) return { enqueued: 0 };
  const inserted = await job.db
    .insert(schema.notificationOutbox)
    .values(
      due.map((row) => ({
        purpose: "APPOINTMENT_REMINDER" as const,
        dedupeKey: `APPOINTMENT_REMINDER:${row.id}`,
        customerId: row.customerId,
        bookingId: row.id,
        nextAttemptAt: now,
      })),
    )
    .onConflictDoNothing({ target: schema.notificationOutbox.dedupeKey })
    .returning({ id: schema.notificationOutbox.id });
  job.logger?.info("notification.enqueued", {
    purpose: "APPOINTMENT_REMINDER",
    count: inserted.length,
  });
  return { enqueued: inserted.length };
}

const dispatchOptionsSchema = z.strictObject({
  timeZone: z.string().min(1),
  batchSize: z.number().int().min(1).max(100).default(20),
  maxAttempts: z.number().int().min(1).max(10).default(5),
  /** A SENDING row older than this is UNCERTAIN (never resent automatically). */
  staleAfterMinutes: z.number().int().min(1).max(1440).default(15),
});

export interface DispatchDependencies {
  readonly sender: EmailSender;
  /** true when the address is on the suppression list (composition: CRM identity hash). */
  readonly isEmailSuppressed: (email: string) => Promise<boolean>;
}

export interface DispatchResult {
  readonly sent: number;
  readonly retried: number;
  readonly dead: number;
  readonly skipped: number;
  readonly uncertain: number;
}

function backoffMinutes(attempt: number): number {
  return Math.min(2 ** attempt, 240);
}

function formatAppointment(start: Date, end: Date, timeZone: string) {
  const date = new Intl.DateTimeFormat("de-DE", {
    timeZone,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(start);
  const time = new Intl.DateTimeFormat("de-DE", { timeZone, hour: "2-digit", minute: "2-digit" });
  return { date, from: time.format(start), to: time.format(end) };
}

/** Plain-text reminder. States only booked facts – no prices, promises or company data. */
export function renderAppointmentReminder(
  windowStart: Date,
  windowEnd: Date,
  timeZone: string,
): { subject: string; text: string } {
  const a = formatAppointment(windowStart, windowEnd, timeZone);
  return {
    subject: "Erinnerung an Ihren Reinigungstermin",
    text: [
      "Guten Tag,",
      "",
      `wir erinnern Sie an Ihren gebuchten Reinigungstermin am ${a.date} im Zeitfenster ${a.from}–${a.to} Uhr.`,
      "",
      "Details und Änderungswünsche finden Sie in Ihrem Kundenbereich.",
      "",
      "Diese Nachricht wurde automatisch zu Ihrer Buchung versendet.",
    ].join("\n"),
  };
}

async function recipientOf(db: Database, customerId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: schema.user.email })
    .from(schema.userRole)
    .innerJoin(schema.user, eq(schema.user.id, schema.userRole.userId))
    .where(
      and(
        eq(schema.userRole.roleKey, "CUSTOMER"),
        eq(schema.userRole.customerId, customerId),
        eq(schema.user.emailVerified, true),
      ),
    )
    .orderBy(asc(schema.user.createdAt))
    .limit(1);
  return row?.email ?? null;
}

export async function dispatchNotifications(
  job: NotificationJobContext,
  options: z.input<typeof dispatchOptionsSchema>,
  deps: DispatchDependencies,
): Promise<DispatchResult> {
  const opts = dispatchOptionsSchema.parse(options);
  const o = schema.notificationOutbox;
  const now = job.clock.now();

  // 1. Rows stuck in SENDING: the provider may or may not have delivered – never resend.
  const stale = await job.db
    .update(o)
    .set({ status: "UNCERTAIN", lastErrorCode: "STALE_SENDING", updatedAt: now })
    .where(
      and(
        eq(o.status, "SENDING"),
        lt(o.claimedAt, new Date(now.getTime() - opts.staleAfterMinutes * 60_000)),
      ),
    )
    .returning({ id: o.id });

  // 2. Claim due rows (concurrent dispatchers skip each other's rows).
  const claimed = await job.db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: o.id })
      .from(o)
      .where(and(eq(o.status, "PENDING"), lte(o.nextAttemptAt, now)))
      .orderBy(asc(o.nextAttemptAt))
      .limit(opts.batchSize)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    return tx
      .update(o)
      .set({
        status: "SENDING",
        claimedAt: now,
        attempts: sql`${o.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        inArray(
          o.id,
          rows.map((r) => r.id),
        ),
      )
      .returning();
  });

  let sent = 0;
  let retried = 0;
  let dead = 0;
  let skipped = 0;
  const finish = (id: string, values: Partial<typeof o.$inferInsert>) =>
    job.db
      .update(o)
      .set({ ...values, updatedAt: job.clock.now() })
      .where(eq(o.id, id));

  for (const row of claimed) {
    // 3. Re-check the subject: cancelled or past appointments are not reminded.
    const [booking] =
      row.bookingId === null
        ? []
        : await job.db
            .select({
              status: schema.booking.status,
              windowStart: schema.booking.windowStart,
              windowEnd: schema.booking.windowEnd,
            })
            .from(schema.booking)
            .where(eq(schema.booking.id, row.bookingId))
            .limit(1);
    if (
      booking === undefined ||
      !["CONFIRMED", "SCHEDULED"].includes(booking.status) ||
      booking.windowStart.getTime() <= now.getTime()
    ) {
      await finish(row.id, { status: "OBSOLETE", lastErrorCode: "SUBJECT_NOT_ELIGIBLE" });
      skipped += 1;
      continue;
    }
    const email = await recipientOf(job.db, row.customerId);
    if (email === null) {
      await finish(row.id, { status: "NO_RECIPIENT", lastErrorCode: "NO_VERIFIED_ACCOUNT" });
      skipped += 1;
      continue;
    }
    if (await deps.isEmailSuppressed(email)) {
      await finish(row.id, { status: "SUPPRESSED", lastErrorCode: "SUPPRESSED" });
      skipped += 1;
      continue;
    }
    const message = renderAppointmentReminder(
      booking.windowStart,
      booking.windowEnd,
      opts.timeZone,
    );
    try {
      await deps.sender.send({ to: email, ...message, purpose: "booking.appointment-reminder" });
    } catch {
      // Provider errors are not logged verbatim (they can echo addresses).
      if (row.attempts >= opts.maxAttempts) {
        await finish(row.id, { status: "DEAD", lastErrorCode: "SEND_FAILED" });
        dead += 1;
        job.logger?.warn("notification.dead", { notificationId: row.id, attempts: row.attempts });
      } else {
        await finish(row.id, {
          status: "PENDING",
          lastErrorCode: "SEND_FAILED",
          nextAttemptAt: new Date(now.getTime() + backoffMinutes(row.attempts) * 60_000),
        });
        retried += 1;
      }
      continue;
    }
    await finish(row.id, { status: "SENT", sentAt: job.clock.now(), lastErrorCode: null });
    sent += 1;
  }
  const result = { sent, retried, dead, skipped, uncertain: stale.length };
  job.logger?.info("notification.dispatched", { ...result });
  return result;
}
