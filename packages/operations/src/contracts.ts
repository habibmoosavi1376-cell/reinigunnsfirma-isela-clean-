import { recordAudit } from "@isela/audit";
import { auditActorOf, requireActor, type ServiceContext } from "@isela/auth";
import { and, asc, eq, gte, inArray, isNull, lte, schema } from "@isela/database";
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
  type OccurrenceSkipReason,
} from "./recurrence.ts";
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

/** Records a pause; appointments in it are skipped by future generation runs. */
export async function addContractPause(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:write");
  const data = parseInput(pauseInput, input);
  if (data.toDate < data.fromDate) {
    throw new DomainError("VALIDATION_FAILED", "The pause must not end before it starts");
  }
  await ctx.db.transaction(async (tx) => {
    const [contract] = await tx
      .select({ id: schema.serviceContract.id })
      .from(schema.serviceContract)
      .where(eq(schema.serviceContract.id, data.contractId))
      .limit(1);
    if (contract === undefined) throw new DomainError("NOT_FOUND", "Contract not found");
    const [pause] = await tx
      .insert(schema.contractPause)
      .values({ ...data, createdByUserId: actor.userId })
      .returning({ id: schema.contractPause.id });
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "service_contract.paused",
      entityType: "service_contract",
      entityId: data.contractId,
      after: { pauseId: pause?.id ?? null, fromDate: data.fromDate, toDate: data.toDate },
      correlationId: ctx.correlationId,
    });
  });
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

export interface ContractView {
  readonly id: string;
  readonly customerId: string;
  readonly propertyId: string;
  readonly quoteId: string;
  readonly frequency: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly status: string;
  readonly occurrences: readonly {
    date: string;
    status: string;
    skipReason: string | null;
    bookingId: string | null;
  }[];
}

/** Contract with its appointments (booking:read). */
export async function getServiceContract(
  ctx: ServiceContext,
  input: unknown,
): Promise<ContractView> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "booking:read");
  const { contractId } = parseInput(z.strictObject({ contractId: z.uuid() }), input);
  const [contract] = await ctx.db
    .select()
    .from(schema.serviceContract)
    .where(eq(schema.serviceContract.id, contractId))
    .limit(1);
  if (contract === undefined) throw new DomainError("NOT_FOUND", "Contract not found");
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
    propertyId: contract.propertyId,
    quoteId: contract.quoteId,
    frequency: contract.frequency,
    startDate: contract.startDate,
    endDate: contract.endDate,
    status: contract.status,
    occurrences,
  };
}
