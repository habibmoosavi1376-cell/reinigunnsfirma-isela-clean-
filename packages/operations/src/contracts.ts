import { recordAudit } from "@isela/audit";
import { auditActorOf, requireActor, scopeFilterFor, type ServiceContext } from "@isela/auth";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  schema,
  sql,
  type Transaction,
} from "@isela/database";
import { paymentPolicySchema } from "@isela/payment-risk";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import { createBookingRecord, type PaymentPolicySnapshot } from "./bookings.ts";
import { operationsConfigSchema, type OperationsConfig } from "./config.ts";
import { pgErrorCode, requireGlobal } from "./internal.ts";
import {
  expandOccurrences,
  recurrenceRuleSchema,
  yearsOf,
  type Occurrence,
  type OccurrenceSkipReason,
} from "./recurrence.ts";
import { localTime } from "./time.ts";
import type { PaymentRequirement } from "./state-machines.ts";

/*
 * Recurring service contracts (day 8). A contract repeats an ACCEPTED quote (scope and
 * price) by a recurrence rule. Bookings are generated for a bounded window; every booking
 * goes through createBookingRecord, i.e. the central payment-terms engine (prepayment for new
 * customers and jobs 1–2, credit terms only with an approved credit decision, prepayment again
 * on any overdue invoice) and the job-start payment guard stay authoritative.
 *
 * Idempotency: one contract_occurrence row per contract and day (unique). Each appointment
 * is generated in its own transaction that locks the contract row; a concurrent or repeated
 * run finds the row and skips it, and the unique index is the last guard. Generation is
 * refused for years without approved holiday data – no appointments on unverified days.
 */

/** Longest window generated in one run (calendar days). */
export const MAX_GENERATION_DAYS = 120;

const isoDate = z.iso.date();
const region = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/);

const createContractInput = z.strictObject({
  quoteId: z.uuid(),
  frequency: recurrenceRuleSchema.shape.frequency,
  startDate: isoDate,
  endDate: isoDate.nullable(),
  windowStartMinute: z.number().int(),
  windowEndMinute: z.number().int(),
  durationMinutes: z.number().int().min(15).max(1440),
});

/** Creates a contract from an accepted, not yet booked quote (booking:write). */
export async function createServiceContract(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ contractId: string }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:write");
  const data = parseInput(createContractInput, input);
  const rule = recurrenceRuleSchema.safeParse({
    frequency: data.frequency,
    startDate: data.startDate,
    endDate: data.endDate,
    windowStartMinute: data.windowStartMinute,
    windowEndMinute: data.windowEndMinute,
  });
  if (!rule.success) throw new DomainError("VALIDATION_FAILED", "Invalid recurrence rule");
  if (data.durationMinutes > data.windowEndMinute - data.windowStartMinute) {
    throw new DomainError("VALIDATION_FAILED", "Duration exceeds the time window");
  }
  try {
    return await ctx.db.transaction(async (tx) => {
      const [quote] = await tx
        .select()
        .from(schema.quote)
        .where(eq(schema.quote.id, data.quoteId))
        .for("update")
        .limit(1);
      if (quote === undefined) throw new DomainError("NOT_FOUND", "Quote not found");
      if (quote.status !== "ACCEPTED") {
        throw new DomainError("POLICY_VIOLATION", "Only accepted quotes can be repeated", {
          quoteStatus: quote.status,
        });
      }
      if (quote.grossCents <= 0) {
        throw new DomainError("POLICY_VIOLATION", "The quote has no billable amount");
      }
      if (quote.propertyId === null) {
        throw new DomainError("VALIDATION_FAILED", "The quote has no property");
      }
      const [booked] = await tx
        .select({ id: schema.booking.id })
        .from(schema.booking)
        .where(eq(schema.booking.quoteId, quote.id))
        .limit(1);
      if (booked !== undefined) {
        throw new DomainError("CONFLICT", "The quote is already used for a single booking");
      }
      const [customer] = await tx
        .select({ status: schema.customer.status })
        .from(schema.customer)
        .where(and(eq(schema.customer.id, quote.customerId), isNull(schema.customer.archivedAt)))
        .limit(1);
      if (customer === undefined) throw new DomainError("NOT_FOUND", "Customer not found");
      if (customer.status === "BLOCKED") {
        throw new DomainError("POLICY_VIOLATION", "The customer is blocked");
      }
      const [contract] = await tx
        .insert(schema.serviceContract)
        .values({
          customerId: quote.customerId,
          propertyId: quote.propertyId,
          quoteId: quote.id,
          frequency: data.frequency,
          startDate: data.startDate,
          endDate: data.endDate,
          windowStartMinute: data.windowStartMinute,
          windowEndMinute: data.windowEndMinute,
          durationMinutes: data.durationMinutes,
          createdByUserId: actor.userId,
        })
        .returning({ id: schema.serviceContract.id });
      if (contract === undefined) throw new DomainError("CONFLICT", "Contract not created");
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: "service_contract.created",
        entityType: "service_contract",
        entityId: contract.id,
        after: {
          quoteId: quote.id,
          customerId: quote.customerId,
          frequency: data.frequency,
          startDate: data.startDate,
          endDate: data.endDate,
        },
        correlationId: ctx.correlationId,
      });
      return { contractId: contract.id };
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new DomainError("CONFLICT", "A contract already exists for this quote");
    }
    throw error;
  }
}

const pauseInput = z.strictObject({
  contractId: z.uuid(),
  fromDate: isoDate,
  toDate: isoDate,
  reason: z.string().trim().min(3).max(500),
});

/** Booked, not cancelled appointments of a contract inside [from, to] (need a decision). */
async function bookedInRange(
  db: Pick<ServiceContext["db"], "select">,
  contractId: string,
  from: string,
  to: string,
): Promise<string[]> {
  const rows = await db
    .select({ bookingId: schema.contractOccurrence.bookingId })
    .from(schema.contractOccurrence)
    .innerJoin(schema.booking, eq(schema.booking.id, schema.contractOccurrence.bookingId))
    .where(
      and(
        eq(schema.contractOccurrence.contractId, contractId),
        eq(schema.contractOccurrence.status, "BOOKED"),
        gte(schema.contractOccurrence.occurrenceDate, from),
        lte(schema.contractOccurrence.occurrenceDate, to),
        inArray(schema.booking.status, ["REQUESTED", "PENDING_PAYMENT", "CONFIRMED", "SCHEDULED"]),
      ),
    );
  return rows.map((r) => r.bookingId).filter((id): id is string => id !== null);
}

export interface PauseResult {
  readonly pauseId: string;
  /**
   * Already generated, active bookings inside the pause. They are NOT cancelled
   * automatically (payments may exist) – staff decide per booking.
   */
  readonly conflictingBookingIds: readonly string[];
}

/** Records a pause; appointments in it are skipped by future generation runs. */
export async function addContractPause(ctx: ServiceContext, input: unknown): Promise<PauseResult> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:write");
  const data = parseInput(pauseInput, input);
  if (data.toDate < data.fromDate) {
    throw new DomainError("VALIDATION_FAILED", "The pause must not end before it starts");
  }
  return ctx.db.transaction(async (tx) => {
    const [contract] = await tx
      .select({ id: schema.serviceContract.id, status: schema.serviceContract.status })
      .from(schema.serviceContract)
      .where(eq(schema.serviceContract.id, data.contractId))
      .for("update")
      .limit(1);
    if (contract === undefined) throw new DomainError("NOT_FOUND", "Contract not found");
    if (contract.status === "ENDED") {
      throw new DomainError("POLICY_VIOLATION", "An ended contract cannot be paused");
    }
    const [pause] = await tx
      .insert(schema.contractPause)
      .values({ ...data, createdByUserId: actor.userId })
      .returning({ id: schema.contractPause.id });
    if (pause === undefined) throw new DomainError("CONFLICT", "Pause not created");
    const conflictingBookingIds = await bookedInRange(
      tx,
      data.contractId,
      data.fromDate,
      data.toDate,
    );
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "service_contract.paused",
      entityType: "service_contract",
      entityId: data.contractId,
      after: {
        pauseId: pause.id,
        fromDate: data.fromDate,
        toDate: data.toDate,
        conflictingBookings: conflictingBookingIds.length,
      },
      correlationId: ctx.correlationId,
    });
    return { pauseId: pause.id, conflictingBookingIds };
  });
}

const updatePauseInput = z.strictObject({
  pauseId: z.uuid(),
  fromDate: isoDate,
  toDate: isoDate,
  reason: z.string().trim().min(3).max(500),
});

/** Changes a pause (dates and reason). Only pauses that have not ended yet can be changed. */
export async function updateContractPause(
  ctx: ServiceContext,
  input: unknown,
  options: { readonly timeZone: string },
): Promise<PauseResult> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:write");
  const data = parseInput(updatePauseInput, input);
  if (data.toDate < data.fromDate) {
    throw new DomainError("VALIDATION_FAILED", "The pause must not end before it starts");
  }
  return ctx.db.transaction(async (tx) => {
    const pause = await lockPause(tx, data.pauseId);
    const today = localTime(ctx.clock.now(), options.timeZone).date;
    if (pause.toDate < today) {
      throw new DomainError("POLICY_VIOLATION", "A pause in the past cannot be changed");
    }
    await tx
      .update(schema.contractPause)
      .set({ fromDate: data.fromDate, toDate: data.toDate, reason: data.reason })
      .where(eq(schema.contractPause.id, pause.id));
    const conflictingBookingIds = await bookedInRange(
      tx,
      pause.contractId,
      data.fromDate,
      data.toDate,
    );
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "service_contract.pause_updated",
      entityType: "service_contract",
      entityId: pause.contractId,
      before: { pauseId: pause.id, fromDate: pause.fromDate, toDate: pause.toDate },
      after: { pauseId: pause.id, fromDate: data.fromDate, toDate: data.toDate },
      correlationId: ctx.correlationId,
    });
    return { pauseId: pause.id, conflictingBookingIds };
  });
}

const endPauseInput = z.strictObject({ pauseId: z.uuid(), lastDay: isoDate });

/** Ends a pause early: `lastDay` becomes its last paused day (not before its start). */
export async function endContractPause(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:write");
  const data = parseInput(endPauseInput, input);
  await ctx.db.transaction(async (tx) => {
    const pause = await lockPause(tx, data.pauseId);
    if (data.lastDay < pause.fromDate) {
      throw new DomainError("VALIDATION_FAILED", "A pause cannot end before it starts");
    }
    if (data.lastDay >= pause.toDate) {
      throw new DomainError("VALIDATION_FAILED", "The new end must be before the current end");
    }
    await tx
      .update(schema.contractPause)
      .set({ toDate: data.lastDay })
      .where(eq(schema.contractPause.id, pause.id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "service_contract.pause_ended",
      entityType: "service_contract",
      entityId: pause.contractId,
      before: { pauseId: pause.id, toDate: pause.toDate },
      after: { pauseId: pause.id, toDate: data.lastDay },
      correlationId: ctx.correlationId,
    });
  });
}

async function lockPause(tx: Transaction, pauseId: string) {
  const [pause] = await tx
    .select()
    .from(schema.contractPause)
    .where(eq(schema.contractPause.id, pauseId))
    .for("update")
    .limit(1);
  if (pause === undefined) throw new DomainError("NOT_FOUND", "Pause not found");
  return pause;
}

const holidayYearInput = z.strictObject({
  region,
  year: z.number().int().min(2000).max(2100),
  sourceReference: z.string().trim().min(5).max(500),
  holidays: z
    .array(z.strictObject({ date: isoDate, name: z.string().trim().min(2).max(200) }))
    .max(40),
});

/**
 * Stores the verified public holidays of one region and year and marks the year as covered
 * (settings:manage). The data must come from the named official source and is reviewed by
 * the approving person – nothing is derived or invented here. A year can be recorded once.
 */
export async function recordHolidayYear(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "settings:manage");
  const data = parseInput(holidayYearInput, input);
  const prefix = `${String(data.year)}-`;
  if (data.holidays.some((h) => !h.date.startsWith(prefix))) {
    throw new DomainError("VALIDATION_FAILED", "Every holiday must lie in the given year");
  }
  if (new Set(data.holidays.map((h) => h.date)).size !== data.holidays.length) {
    throw new DomainError("VALIDATION_FAILED", "Duplicate holiday dates");
  }
  try {
    await ctx.db.transaction(async (tx) => {
      await tx.insert(schema.holidayYearCoverage).values({
        region: data.region,
        year: data.year,
        sourceReference: data.sourceReference,
        approvedByUserId: actor.userId,
        approvedAt: ctx.clock.now(),
      });
      if (data.holidays.length > 0) {
        await tx
          .insert(schema.publicHoliday)
          .values(
            data.holidays.map((h) => ({ region: data.region, holidayDate: h.date, name: h.name })),
          );
      }
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: "holiday_year.recorded",
        entityType: "holiday_year_coverage",
        entityId: `${data.region}:${String(data.year)}`,
        after: {
          region: data.region,
          year: data.year,
          holidays: data.holidays.length,
          sourceReference: data.sourceReference,
        },
        correlationId: ctx.correlationId,
      });
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new DomainError("CONFLICT", "Holidays for this region and year are already recorded");
    }
    throw error;
  }
}

const generateInput = z.strictObject({
  contractId: z.uuid(),
  from: isoDate,
  to: isoDate,
});

export interface GenerationOptions {
  readonly paymentPolicy: PaymentPolicySnapshot;
  readonly config: OperationsConfig;
  /** ISO 3166-2 region of the holiday calendar (configuration, e.g. "DE-NW"). */
  readonly holidayRegion: string;
}

export interface GenerationResult {
  readonly created: readonly {
    date: string;
    bookingId: string;
    paymentRequirement: PaymentRequirement;
  }[];
  readonly skipped: readonly { date: string; reason: OccurrenceSkipReason }[];
  /** Appointments that already existed (earlier or concurrent run). */
  readonly existing: number;
  /** Appointments whose window already started (never generated retroactively). */
  readonly past: number;
}

/**
 * Generates the bookings of a contract for [from, to] (inclusive, at most
 * MAX_GENERATION_DAYS days). Safe to repeat and to run concurrently.
 */
export async function generateContractBookings(
  ctx: ServiceContext,
  input: unknown,
  options: GenerationOptions,
): Promise<GenerationResult> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:write");
  const data = parseInput(generateInput, input);
  const config = operationsConfigSchema.parse(options.config);
  const policy = paymentPolicySchema.parse(options.paymentPolicy.policy);
  const holidayRegion = region.parse(options.holidayRegion);
  const days =
    (Date.parse(`${data.to}T00:00:00Z`) - Date.parse(`${data.from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days < 1 || days > MAX_GENERATION_DAYS) {
    throw new DomainError("VALIDATION_FAILED", "Invalid generation window", {
      maxDays: MAX_GENERATION_DAYS,
    });
  }

  const [contract] = await ctx.db
    .select()
    .from(schema.serviceContract)
    .where(eq(schema.serviceContract.id, data.contractId))
    .limit(1);
  if (contract === undefined) throw new DomainError("NOT_FOUND", "Contract not found");
  if (contract.status !== "ACTIVE") {
    throw new DomainError("POLICY_VIOLATION", "Only active contracts generate appointments", {
      contractStatus: contract.status,
    });
  }

  const years = yearsOf({ from: data.from, to: data.to });
  const covered = await ctx.db
    .select({ year: schema.holidayYearCoverage.year })
    .from(schema.holidayYearCoverage)
    .where(
      and(
        eq(schema.holidayYearCoverage.region, holidayRegion),
        inArray(schema.holidayYearCoverage.year, years),
      ),
    );
  const missingYears = years.filter((y) => !covered.some((c) => c.year === y));
  if (missingYears.length > 0) {
    throw new DomainError("POLICY_VIOLATION", "Verified holiday data is missing", {
      region: holidayRegion,
      missingYears: missingYears.join(","),
    });
  }
  const holidays = await ctx.db
    .select({ date: schema.publicHoliday.holidayDate })
    .from(schema.publicHoliday)
    .where(
      and(
        eq(schema.publicHoliday.region, holidayRegion),
        gte(schema.publicHoliday.holidayDate, data.from),
        lte(schema.publicHoliday.holidayDate, data.to),
      ),
    );
  const pauses = await ctx.db
    .select({ from: schema.contractPause.fromDate, to: schema.contractPause.toDate })
    .from(schema.contractPause)
    .where(eq(schema.contractPause.contractId, contract.id));

  const occurrences = expandOccurrences(
    {
      frequency: contract.frequency,
      startDate: contract.startDate,
      endDate: contract.endDate,
      windowStartMinute: contract.windowStartMinute,
      windowEndMinute: contract.windowEndMinute,
    },
    { from: data.from, to: data.to },
    { timeZone: config.timeZone, holidays: new Set(holidays.map((h) => h.date)), pauses },
  );

  const now = ctx.clock.now();
  const created: { date: string; bookingId: string; paymentRequirement: PaymentRequirement }[] = [];
  const skipped: { date: string; reason: OccurrenceSkipReason }[] = [];
  let existing = 0;
  let past = 0;

  for (const occurrence of occurrences) {
    if (occurrence.windowStart !== null && occurrence.windowStart.getTime() <= now.getTime()) {
      past += 1;
      continue;
    }
    try {
      const outcome = await ctx.db.transaction(async (tx) => {
        // Serialises runs per contract and re-checks its state inside the transaction.
        const [locked] = await tx
          .select({ status: schema.serviceContract.status })
          .from(schema.serviceContract)
          .where(eq(schema.serviceContract.id, contract.id))
          .for("update")
          .limit(1);
        if (locked?.status !== "ACTIVE") {
          throw new DomainError("POLICY_VIOLATION", "The contract is no longer active");
        }
        const [already] = await tx
          .select({ id: schema.contractOccurrence.id })
          .from(schema.contractOccurrence)
          .where(
            and(
              eq(schema.contractOccurrence.contractId, contract.id),
              eq(schema.contractOccurrence.occurrenceDate, occurrence.date),
            ),
          )
          .limit(1);
        if (already !== undefined) return { kind: "EXISTING" as const };
        if (occurrence.skipReason !== null) {
          await tx.insert(schema.contractOccurrence).values({
            contractId: contract.id,
            occurrenceDate: occurrence.date,
            status: "SKIPPED",
            skipReason: occurrence.skipReason,
          });
          return { kind: "SKIPPED" as const, reason: occurrence.skipReason };
        }
        if (occurrence.windowStart === null || occurrence.windowEnd === null) {
          throw new DomainError("VALIDATION_FAILED", "Appointment without a time window");
        }
        const [quote] = await tx
          .select()
          .from(schema.quote)
          .where(eq(schema.quote.id, contract.quoteId))
          .limit(1);
        if (quote?.status !== "ACCEPTED") {
          throw new DomainError("POLICY_VIOLATION", "The contract quote is no longer accepted");
        }
        const [property] = await tx
          .select({ id: schema.property.id, addressId: schema.property.addressId })
          .from(schema.property)
          .where(
            and(
              eq(schema.property.id, contract.propertyId),
              eq(schema.property.customerId, contract.customerId),
              isNull(schema.property.archivedAt),
              eq(schema.property.active, true),
            ),
          )
          .limit(1);
        if (property === undefined) {
          throw new DomainError("NOT_FOUND", "Property not found for this customer");
        }
        const [customer] = await tx
          .select({ status: schema.customer.status })
          .from(schema.customer)
          .where(
            and(eq(schema.customer.id, contract.customerId), isNull(schema.customer.archivedAt)),
          )
          .limit(1);
        if (customer === undefined) throw new DomainError("NOT_FOUND", "Customer not found");
        if (customer.status === "BLOCKED") {
          throw new DomainError("POLICY_VIOLATION", "The customer is blocked");
        }
        const booking = await createBookingRecord(tx, ctx, {
          actorUserId: actor.userId,
          auditActor: auditActorOf(actor),
          template: quote,
          source: "CONTRACT",
          customerId: contract.customerId,
          propertyId: property.id,
          addressId: property.addressId,
          windowStart: occurrence.windowStart,
          windowEnd: occurrence.windowEnd,
          durationMinutes: contract.durationMinutes,
          policy,
          policyVersion: options.paymentPolicy.version,
          timeZone: config.timeZone,
          now,
          auditExtra: { contractId: contract.id, occurrenceDate: occurrence.date },
        });
        await tx.insert(schema.contractOccurrence).values({
          contractId: contract.id,
          occurrenceDate: occurrence.date,
          status: "BOOKED",
          bookingId: booking.bookingId,
        });
        return { kind: "BOOKED" as const, ...booking };
      });
      if (outcome.kind === "EXISTING") existing += 1;
      else if (outcome.kind === "SKIPPED")
        skipped.push({ date: occurrence.date, reason: outcome.reason });
      else {
        created.push({
          date: occurrence.date,
          bookingId: outcome.bookingId,
          paymentRequirement: outcome.paymentRequirement,
        });
      }
    } catch (error) {
      // A concurrent run created the same appointment first: its transaction (and booking)
      // won, ours was rolled back completely.
      if (pgErrorCode(error) === "23505") {
        existing += 1;
        continue;
      }
      throw error;
    }
  }
  ctx.logger?.info("service_contract.generated", {
    contractId: contract.id,
    created: created.length,
    skipped: skipped.length,
    existing,
    past,
    correlationId: ctx.correlationId ?? null,
  });
  return { created, skipped, existing, past };
}

const CONTRACT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  ACTIVE: ["PAUSED", "ENDED"],
  PAUSED: ["ACTIVE", "ENDED"],
  ENDED: [],
};

const statusInput = z.strictObject({
  contractId: z.uuid(),
  to: z.enum(["ACTIVE", "PAUSED", "ENDED"]),
  /** Optimistic concurrency: the version the user saw. */
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().min(3).max(500),
});

/**
 * Changes the contract status (ACTIVE ⇄ PAUSED, any → ENDED, ENDED is final). A PAUSED or
 * ENDED contract generates no appointments; existing bookings stay untouched (staff decide).
 */
export async function updateContractStatus(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:write");
  const data = parseInput(statusInput, input);
  await ctx.db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(schema.serviceContract)
      .where(eq(schema.serviceContract.id, data.contractId))
      .for("update")
      .limit(1);
    if (contract === undefined) throw new DomainError("NOT_FOUND", "Contract not found");
    if (contract.version !== data.expectedVersion) {
      throw new DomainError("CONFLICT", "The contract was changed in the meantime", {
        currentVersion: contract.version,
      });
    }
    if (!(CONTRACT_TRANSITIONS[contract.status] ?? []).includes(data.to)) {
      throw new DomainError("POLICY_VIOLATION", "Status change not allowed", {
        from: contract.status,
        to: data.to,
      });
    }
    await tx
      .update(schema.serviceContract)
      .set({ status: data.to, version: contract.version + 1, updatedAt: ctx.clock.now() })
      .where(eq(schema.serviceContract.id, contract.id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "service_contract.status_changed",
      entityType: "service_contract",
      entityId: contract.id,
      before: { status: contract.status, version: contract.version },
      after: { status: data.to, version: contract.version + 1, reason: data.reason },
      correlationId: ctx.correlationId,
    });
  });
}

export const contractListQuerySchema = z.strictObject({
  status: z.enum(["ACTIVE", "PAUSED", "ENDED"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

export interface ContractListItem {
  readonly id: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly frequency: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly status: string;
  readonly nextBookedDate: string | null;
}

/** Back-office list of contracts (booking:read). */
export async function listServiceContracts(
  ctx: ServiceContext,
  input: unknown,
  options: { readonly timeZone: string },
): Promise<{ items: ContractListItem[]; page: number; pageSize: number; total: number }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:read");
  const f = parseInput(contractListQuerySchema, input ?? {});
  const pageSize = 25;
  const c = schema.serviceContract;
  const where = f.status === undefined ? undefined : eq(c.status, f.status);
  const today = localTime(ctx.clock.now(), options.timeZone).date;
  const [totalRow] = await ctx.db.select({ total: count() }).from(c).where(where);
  const rows = await ctx.db
    .select({
      id: c.id,
      customerId: c.customerId,
      customerName: schema.customer.displayName,
      frequency: c.frequency,
      startDate: c.startDate,
      endDate: c.endDate,
      status: c.status,
      nextBookedDate: sql<string | null>`(
        SELECT min(o."occurrence_date")::text FROM "contract_occurrence" o
        WHERE o."contract_id" = ${c.id} AND o."status" = 'BOOKED' AND o."occurrence_date" >= ${today}::date
      )`,
    })
    .from(c)
    .innerJoin(schema.customer, eq(schema.customer.id, c.customerId))
    .where(where)
    .orderBy(desc(c.createdAt), desc(c.id))
    .limit(pageSize)
    .offset((f.page - 1) * pageSize);
  return { items: rows, page: f.page, pageSize, total: totalRow?.total ?? 0 };
}

export interface ContractView {
  readonly id: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly propertyId: string;
  readonly quoteId: string;
  readonly frequency: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly windowStartMinute: number;
  readonly windowEndMinute: number;
  readonly durationMinutes: number;
  readonly status: string;
  readonly version: number;
  readonly pauses: readonly { id: string; fromDate: string; toDate: string; reason: string }[];
  readonly occurrences: readonly {
    date: string;
    status: string;
    skipReason: string | null;
    bookingId: string | null;
  }[];
}

/** Contract with pauses and appointments (booking:read). */
export async function getServiceContract(
  ctx: ServiceContext,
  input: unknown,
): Promise<ContractView> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:read");
  const { contractId } = parseInput(z.strictObject({ contractId: z.uuid() }), input);
  const [row] = await ctx.db
    .select({ contract: schema.serviceContract, customerName: schema.customer.displayName })
    .from(schema.serviceContract)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.serviceContract.customerId))
    .where(eq(schema.serviceContract.id, contractId))
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Contract not found");
  const contract = row.contract;
  const pauses = await ctx.db
    .select({
      id: schema.contractPause.id,
      fromDate: schema.contractPause.fromDate,
      toDate: schema.contractPause.toDate,
      reason: schema.contractPause.reason,
    })
    .from(schema.contractPause)
    .where(eq(schema.contractPause.contractId, contract.id))
    .orderBy(asc(schema.contractPause.fromDate));
  const occurrences = await ctx.db
    .select({
      date: schema.contractOccurrence.occurrenceDate,
      status: schema.contractOccurrence.status,
      skipReason: schema.contractOccurrence.skipReason,
      bookingId: schema.contractOccurrence.bookingId,
    })
    .from(schema.contractOccurrence)
    .where(eq(schema.contractOccurrence.contractId, contract.id))
    .orderBy(asc(schema.contractOccurrence.occurrenceDate));
  return {
    id: contract.id,
    customerId: contract.customerId,
    customerName: row.customerName,
    propertyId: contract.propertyId,
    quoteId: contract.quoteId,
    frequency: contract.frequency,
    startDate: contract.startDate,
    endDate: contract.endDate,
    windowStartMinute: contract.windowStartMinute,
    windowEndMinute: contract.windowEndMinute,
    durationMinutes: contract.durationMinutes,
    status: contract.status,
    version: contract.version,
    pauses,
    occurrences,
  };
}

const previewInput = z.strictObject({ contractId: z.uuid(), from: isoDate, to: isoDate });

export interface ContractPreview {
  readonly occurrences: readonly Occurrence[];
  /** false = holiday data for at least one year is missing: holidays are NOT applied. */
  readonly holidayDataComplete: boolean;
  readonly missingYears: readonly number[];
}

/**
 * Upcoming appointments of a contract (read-only, nothing is written). Uses the verified
 * holidays where available and reports missing years instead of guessing.
 */
export async function previewContractOccurrences(
  ctx: ServiceContext,
  input: unknown,
  options: { readonly timeZone: string; readonly holidayRegion: string | null },
): Promise<ContractPreview> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:read");
  const data = parseInput(previewInput, input);
  const days =
    (Date.parse(`${data.to}T00:00:00Z`) - Date.parse(`${data.from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days < 1 || days > MAX_GENERATION_DAYS) {
    throw new DomainError("VALIDATION_FAILED", "Invalid preview window");
  }
  const [contract] = await ctx.db
    .select()
    .from(schema.serviceContract)
    .where(eq(schema.serviceContract.id, data.contractId))
    .limit(1);
  if (contract === undefined) throw new DomainError("NOT_FOUND", "Contract not found");
  const years = yearsOf({ from: data.from, to: data.to });
  let holidays: string[] = [];
  let missingYears = years;
  if (options.holidayRegion !== null) {
    const holidayRegion = region.parse(options.holidayRegion);
    const covered = await ctx.db
      .select({ year: schema.holidayYearCoverage.year })
      .from(schema.holidayYearCoverage)
      .where(
        and(
          eq(schema.holidayYearCoverage.region, holidayRegion),
          inArray(schema.holidayYearCoverage.year, years),
        ),
      );
    missingYears = years.filter((y) => !covered.some((c) => c.year === y));
    holidays = (
      await ctx.db
        .select({ date: schema.publicHoliday.holidayDate })
        .from(schema.publicHoliday)
        .where(
          and(
            eq(schema.publicHoliday.region, holidayRegion),
            gte(schema.publicHoliday.holidayDate, data.from),
            lte(schema.publicHoliday.holidayDate, data.to),
          ),
        )
    ).map((h) => h.date);
  }
  const pauses = await ctx.db
    .select({ from: schema.contractPause.fromDate, to: schema.contractPause.toDate })
    .from(schema.contractPause)
    .where(eq(schema.contractPause.contractId, contract.id));
  const occurrences = expandOccurrences(
    {
      frequency: contract.frequency,
      startDate: contract.startDate,
      endDate: contract.endDate,
      windowStartMinute: contract.windowStartMinute,
      windowEndMinute: contract.windowEndMinute,
    },
    { from: data.from, to: data.to },
    { timeZone: options.timeZone, holidays: new Set(holidays), pauses },
  );
  return { occurrences, holidayDataComplete: missingYears.length === 0, missingYears };
}

/** The contract created from a quote, if any (booking:read). */
export async function findContractForQuote(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ id: string; status: string } | null> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:read");
  const { quoteId } = parseInput(z.strictObject({ quoteId: z.uuid() }), input);
  const [row] = await ctx.db
    .select({ id: schema.serviceContract.id, status: schema.serviceContract.status })
    .from(schema.serviceContract)
    .where(eq(schema.serviceContract.quoteId, quoteId))
    .limit(1);
  return row ?? null;
}

/** Approved holiday years of a region with their number of holidays (booking:read). */
export async function listHolidayCoverage(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ year: number; sourceReference: string; approvedAt: Date; holidays: number }[]> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:read");
  const data = parseInput(z.strictObject({ region }), input);
  const c = schema.holidayYearCoverage;
  return ctx.db
    .select({
      year: c.year,
      sourceReference: c.sourceReference,
      approvedAt: c.approvedAt,
      holidays: sql<number>`(
        SELECT count(*)::int FROM "public_holiday" h
        WHERE h."region" = ${c.region} AND extract(year from h."holiday_date") = ${c.year}
      )`,
    })
    .from(c)
    .where(eq(c.region, data.region))
    .orderBy(asc(c.year));
}

export interface CustomerContractView {
  readonly id: string;
  readonly propertyName: string;
  readonly frequency: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly windowStartMinute: number;
  readonly windowEndMinute: number;
  readonly status: string;
  /** Pause periods without the internal reason. */
  readonly pauses: readonly { fromDate: string; toDate: string }[];
  /** Upcoming appointments (today or later). */
  readonly upcoming: readonly { date: string; status: string; bookingId: string | null }[];
}

/**
 * Customer portal: the actor's own recurring contracts (OWN scope, read-only). Staff
 * contexts get an empty list; internal fields (quote, notes, pause reasons, version) are
 * not exposed.
 */
export async function listCustomerContracts(
  ctx: ServiceContext,
  options: { readonly timeZone: string },
): Promise<CustomerContractView[]> {
  const actor = requireActor(ctx.actor);
  const scope = scopeFilterFor(actor, "booking:read");
  if (scope.kind !== "RESTRICTED" || scope.customerIds.length === 0) return [];
  const c = schema.serviceContract;
  const contracts = await ctx.db
    .select({
      id: c.id,
      propertyName: schema.property.name,
      frequency: c.frequency,
      startDate: c.startDate,
      endDate: c.endDate,
      windowStartMinute: c.windowStartMinute,
      windowEndMinute: c.windowEndMinute,
      status: c.status,
    })
    .from(c)
    .innerJoin(schema.property, eq(schema.property.id, c.propertyId))
    .where(inArray(c.customerId, [...scope.customerIds]))
    .orderBy(desc(c.createdAt), desc(c.id))
    .limit(50);
  if (contracts.length === 0) return [];
  const ids = contracts.map((row) => row.id);
  const today = localTime(ctx.clock.now(), options.timeZone).date;
  const [pauses, occurrences] = await Promise.all([
    ctx.db
      .select({
        contractId: schema.contractPause.contractId,
        fromDate: schema.contractPause.fromDate,
        toDate: schema.contractPause.toDate,
      })
      .from(schema.contractPause)
      .where(
        and(inArray(schema.contractPause.contractId, ids), gte(schema.contractPause.toDate, today)),
      )
      .orderBy(asc(schema.contractPause.fromDate)),
    ctx.db
      .select({
        contractId: schema.contractOccurrence.contractId,
        date: schema.contractOccurrence.occurrenceDate,
        status: schema.contractOccurrence.status,
        bookingId: schema.contractOccurrence.bookingId,
      })
      .from(schema.contractOccurrence)
      .where(
        and(
          inArray(schema.contractOccurrence.contractId, ids),
          gte(schema.contractOccurrence.occurrenceDate, today),
        ),
      )
      .orderBy(asc(schema.contractOccurrence.occurrenceDate)),
  ]);
  return contracts.map((row) => ({
    ...row,
    pauses: pauses
      .filter((p) => p.contractId === row.id)
      .map(({ fromDate, toDate }) => ({ fromDate, toDate })),
    upcoming: occurrences
      .filter((o) => o.contractId === row.id)
      .slice(0, 12)
      .map(({ date, status, bookingId }) => ({ date, status, bookingId })),
  }));
}
