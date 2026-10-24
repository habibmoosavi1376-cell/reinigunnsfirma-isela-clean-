import type { ServiceContext } from "@isela/auth";
import { asc, eq, schema, sql } from "@isela/database";
import { isDomainError } from "@isela/shared";
import type { PaymentPolicySnapshot } from "./bookings.ts";
import { recurringConfigSchema, type OperationsConfig, type RecurringConfig } from "./config.ts";
import { generateContractBookings } from "./contracts.ts";
import {
  dispatchNotifications,
  enqueueAppointmentReminders,
  type DispatchDependencies,
  type DispatchResult,
} from "./notifications.ts";
import { localTime } from "./time.ts";

/*
 * Scheduled work (day 8, technology-neutral – ADR-008 is still open). One run:
 *   1. generates the appointments of every ACTIVE contract for the configured horizon,
 *   2. enqueues due appointment reminders,
 *   3. dispatches due notifications (at-most-once).
 * Every step is idempotent, so the run can be triggered by an external scheduler (cron), a
 * future pg-boss worker or manually. A transaction-scoped advisory lock skips overlapping runs.
 * Generation runs as a dedicated service account (ctx.actor) so that every booking is
 * attributable; without a configured holiday region nothing is generated.
 */

/** Advisory lock key of the scheduled run (arbitrary constant, unique in this database). */
const RUN_LOCK_KEY = 8_123_456_001;

export interface ScheduledWorkDependencies extends DispatchDependencies {
  /** Context of the service account (needs booking:write). */
  readonly ctx: ServiceContext;
  readonly paymentPolicy: PaymentPolicySnapshot;
  readonly config: OperationsConfig;
  readonly recurring: RecurringConfig;
  /**
   * false = reminders are enqueued but not delivered (e.g. production before an e-mail
   * provider is approved). Rows stay PENDING and are delivered once enabled.
   */
  readonly dispatchEnabled: boolean;
}

export interface ScheduledWorkResult {
  /** true when another run held the lock – nothing was done. */
  readonly skippedOverlap: boolean;
  readonly generation:
    | { readonly status: "SKIPPED"; readonly reason: "HOLIDAY_REGION_MISSING" }
    | {
        readonly status: "DONE";
        readonly contracts: number;
        readonly created: number;
        readonly skipped: number;
        /** Contracts that could not be generated, by error code (e.g. missing holidays). */
        readonly failures: Readonly<Record<string, number>>;
      };
  readonly reminders: { readonly enqueued: number };
  readonly dispatch: DispatchResult | null;
}

export async function runScheduledWork(
  deps: ScheduledWorkDependencies,
): Promise<ScheduledWorkResult> {
  const recurring = recurringConfigSchema.parse(deps.recurring);
  const { ctx } = deps;
  // The lock lives in a transaction that stays open for the whole run on its own pooled
  // connection: released automatically on commit, rollback or a crashed process. The work
  // itself uses other pooled connections (the pool needs at least 2 connections).
  return ctx.db.transaction(async (lockTx) => {
    const [lock] = (
      await lockTx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${RUN_LOCK_KEY}) AS locked`,
      )
    ).rows;
    if (lock?.locked !== true) {
      ctx.logger?.warn("scheduled_work.overlap", {});
      return {
        skippedOverlap: true,
        generation: { status: "SKIPPED", reason: "HOLIDAY_REGION_MISSING" },
        reminders: { enqueued: 0 },
        dispatch: null,
      } satisfies ScheduledWorkResult;
    }
    return runSteps(deps, recurring);
  });
}

async function runSteps(
  deps: ScheduledWorkDependencies,
  recurring: RecurringConfig,
): Promise<ScheduledWorkResult> {
  const { ctx } = deps;
  let generation: ScheduledWorkResult["generation"];
  if (recurring.holidayRegion === null) {
    generation = { status: "SKIPPED", reason: "HOLIDAY_REGION_MISSING" };
  } else {
    const today = localTime(ctx.clock.now(), deps.config.timeZone).date;
    const to = new Date(
      Date.parse(`${today}T00:00:00Z`) + (recurring.generationHorizonDays - 1) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const contracts = await ctx.db
      .select({ id: schema.serviceContract.id })
      .from(schema.serviceContract)
      .where(eq(schema.serviceContract.status, "ACTIVE"))
      .orderBy(asc(schema.serviceContract.createdAt))
      .limit(5000);
    let created = 0;
    let skipped = 0;
    const failures: Record<string, number> = {};
    for (const contract of contracts) {
      try {
        const result = await generateContractBookings(
          ctx,
          { contractId: contract.id, from: today, to },
          {
            paymentPolicy: deps.paymentPolicy,
            config: deps.config,
            holidayRegion: recurring.holidayRegion,
          },
        );
        created += result.created.length;
        skipped += result.skipped.length;
      } catch (error) {
        // One contract never blocks the others (e.g. missing holiday data, blocked customer).
        if (!isDomainError(error)) throw error;
        failures[error.code] = (failures[error.code] ?? 0) + 1;
      }
    }
    generation = { status: "DONE", contracts: contracts.length, created, skipped, failures };
  }
  const job = { db: ctx.db, clock: ctx.clock, ...(ctx.logger ? { logger: ctx.logger } : {}) };
  const reminders = await enqueueAppointmentReminders(job, {
    leadHours: recurring.reminderLeadHours,
  });
  const dispatch = deps.dispatchEnabled
    ? await dispatchNotifications(
        job,
        { timeZone: deps.config.timeZone },
        { sender: deps.sender, isEmailSuppressed: deps.isEmailSuppressed },
      )
    : null;
  ctx.logger?.info("scheduled_work.done", {
    generation: generation.status,
    enqueued: reminders.enqueued,
    sent: dispatch?.sent ?? 0,
    dispatchEnabled: deps.dispatchEnabled,
  });
  return { skippedOverlap: false, generation, reminders, dispatch };
}
