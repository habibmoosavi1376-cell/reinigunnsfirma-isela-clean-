import { recordAudit } from "@isela/audit";
import {
  auditActorOf,
  hasGlobalPermission,
  isAuthorized,
  requireActor,
  type Actor,
  type ServiceContext,
} from "@isela/auth";
import { findServiceAreasForPoint } from "@isela/catalog";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  or,
  schema,
  sql,
  type SQL,
} from "@isela/database";
import { DomainError, isDomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import {
  applyBookingTransition,
  applyJobTransition,
  hasActiveAssignment,
  lockBooking,
  lockBookingAndJob,
  pgErrorCode,
  requireGlobal,
} from "./internal.ts";
import { JOB_STATUSES, type JobStatus } from "./state-machines.ts";

/*
 * Jobs = the operational execution of a booking. Created by dispatch (job:write) from a booking
 * that is waiting for payment or confirmed; started only when the payment guard is satisfied.
 * STAFF and PARTNER users see and progress only the jobs actively assigned to them – foreign
 * job ids are reported as NOT_FOUND.
 */

const createJobInput = z.strictObject({
  bookingId: z.uuid(),
  operationalNotes: z.string().trim().max(2000).optional(),
});

export async function createJobForBooking(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ jobId: string }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "job:write");
  const data = parseInput(createJobInput, input);
  const result = await ctx.db
    .transaction(async (tx) => {
      const booking = await lockBooking(tx, data.bookingId);
      if (booking.status !== "PENDING_PAYMENT" && booking.status !== "CONFIRMED") {
        throw new DomainError("POLICY_VIOLATION", "Jobs can only be planned for open bookings", {
          bookingStatus: booking.status,
        });
      }
      const [existing] = await tx
        .select({ id: schema.job.id })
        .from(schema.job)
        .where(eq(schema.job.bookingId, booking.id))
        .limit(1);
      if (existing !== undefined)
        throw new DomainError("CONFLICT", "The booking already has a job");

      // Service area from the geocoded service address (none without trusted coordinates).
      const [address] = await tx
        .select({
          latitude: schema.customerAddress.latitude,
          longitude: schema.customerAddress.longitude,
        })
        .from(schema.customerAddress)
        .where(eq(schema.customerAddress.id, booking.addressId))
        .limit(1);
      let serviceAreaId: string | null = null;
      if (address?.latitude != null && address.longitude != null) {
        const areas = await findServiceAreasForPoint(tx, {
          latitude: address.latitude,
          longitude: address.longitude,
        });
        serviceAreaId = areas[0]?.id ?? null;
      }
      const services = await tx
        .select({ qualifications: schema.service.requiredQualifications })
        .from(schema.bookingItem)
        .innerJoin(schema.service, eq(schema.service.id, schema.bookingItem.serviceId))
        .where(eq(schema.bookingItem.bookingId, booking.id));
      const requiredQualifications = [...new Set(services.flatMap((s) => s.qualifications))].sort();
      const scheduledEnd = new Date(
        booking.windowStart.getTime() + booking.durationMinutes * 60_000,
      );
      const [job] = await tx
        .insert(schema.job)
        .values({
          bookingId: booking.id,
          status: "PLANNED",
          scheduledStart: booking.windowStart,
          scheduledEnd,
          serviceAreaId,
          requiredQualifications,
          operationalNotes:
            data.operationalNotes === undefined || data.operationalNotes === ""
              ? null
              : data.operationalNotes,
          createdByUserId: actor.userId,
        })
        .returning({ id: schema.job.id });
      if (job === undefined) throw new DomainError("CONFLICT", "Job could not be created");
      await tx.insert(schema.jobStatusTransition).values({
        jobId: job.id,
        fromStatus: null,
        toStatus: "PLANNED",
        actorUserId: actor.userId,
        reason: null,
      });
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: "job.created",
        entityType: "job",
        entityId: job.id,
        after: { bookingId: booking.id, serviceAreaId, requiredQualifications },
        correlationId: ctx.correlationId,
      });
      return { jobId: job.id, serviceAreaResolved: serviceAreaId !== null };
    })
    .catch((error: unknown) => {
      if (pgErrorCode(error) === "23505") {
        throw new DomainError("CONFLICT", "The booking already has a job");
      }
      throw error;
    });
  ctx.logger?.info("job.created", {
    jobId: result.jobId,
    bookingId: data.bookingId,
    serviceAreaResolved: result.serviceAreaResolved,
    correlationId: ctx.correlationId ?? null,
  });
  return { jobId: result.jobId };
}

// ------------------------------------------------------------------------------------------
// Worker scope (STAFF via linked employee, PARTNER via partner scope)
// ------------------------------------------------------------------------------------------

export interface WorkerScope {
  readonly employeeIds: readonly string[];
  readonly partnerIds: readonly string[];
}

/** Resources the actor works as. Never derived from input. */
export async function workerScopeOf(ctx: ServiceContext, actor: Actor): Promise<WorkerScope> {
  const employeeIds: string[] = [];
  if (actor.roles.some((r) => r.role === "STAFF") && isAuthorized(actor, "job:execute_own")) {
    const rows = await ctx.db
      .select({ id: schema.employee.id })
      .from(schema.employee)
      .where(and(eq(schema.employee.userId, actor.userId), eq(schema.employee.active, true)));
    employeeIds.push(...rows.map((r) => r.id));
  }
  const partnerIds = actor.roles
    .filter(
      (r) =>
        r.role === "PARTNER" &&
        r.partnerId !== null &&
        isAuthorized(actor, "job:execute_own", { partnerId: r.partnerId }),
    )
    .map((r) => r.partnerId as string);
  return { employeeIds, partnerIds };
}

function assignmentOfWorker(scope: WorkerScope): SQL | undefined {
  const parts: SQL[] = [];
  if (scope.employeeIds.length > 0) {
    parts.push(inArray(schema.jobAssignment.employeeId, [...scope.employeeIds]));
  }
  if (scope.partnerIds.length > 0) {
    parts.push(inArray(schema.jobAssignment.partnerId, [...scope.partnerIds]));
  }
  if (parts.length === 0) return undefined;
  return and(eq(schema.jobAssignment.status, "ACTIVE"), or(...parts));
}

// ------------------------------------------------------------------------------------------
// Transitions
// ------------------------------------------------------------------------------------------

const DISPATCH_TARGETS: readonly JobStatus[] = [
  "ASSIGNMENT_PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "QUALITY_CHECK",
  "CLOSED",
];
const WORKER_TARGETS: readonly JobStatus[] = ["IN_PROGRESS", "COMPLETED"];

const transitionInput = z.strictObject({
  jobId: z.uuid(),
  to: z.enum(JOB_STATUSES),
  reason: z.string().trim().max(1000).optional(),
});

/**
 * Manual job transitions. ASSIGNED/ASSIGNMENT_PENDING after assignment are handled by the
 * assignment service, CANCELLED by the booking cancellation. Dispatchers (job:write) may use
 * every manual target; assigned workers (job:execute_own) may start and complete their job.
 */
export async function transitionJob(ctx: ServiceContext, input: unknown): Promise<JobStatus> {
  const actor = requireActor(ctx.actor);
  const data = parseInput(transitionInput, input);
  const dispatcher = hasGlobalPermission(actor, "job:write");
  if (!dispatcher && !isAuthorizedForAnyWork(actor)) {
    throw new DomainError("FORBIDDEN", "Not allowed", { permission: "job:write" });
  }
  const allowedTargets = dispatcher ? DISPATCH_TARGETS : WORKER_TARGETS;
  if (!allowedTargets.includes(data.to)) {
    throw new DomainError("FORBIDDEN", "This transition is not available", { to: data.to });
  }
  const worker = dispatcher ? null : await workerScopeOf(ctx, actor);
  const reason = data.reason === undefined || data.reason === "" ? null : data.reason;
  const now = ctx.clock.now();
  let bookingId: string | null = null;
  try {
    return await ctx.db.transaction(async (tx) => {
      const locked = await lockBookingAndJob(tx, data.jobId);
      const { job, booking } = locked;
      bookingId = booking.id;
      if (worker !== null) {
        const condition = assignmentOfWorker(worker);
        const [own] =
          condition === undefined
            ? []
            : await tx
                .select({ id: schema.jobAssignment.id })
                .from(schema.jobAssignment)
                .where(and(eq(schema.jobAssignment.jobId, job.id), condition))
                .limit(1);
        if (own === undefined) throw new DomainError("NOT_FOUND", "Job not found");
      }
      if (data.to === "ASSIGNMENT_PENDING" && job.status !== "PLANNED") {
        throw new DomainError("INVALID_STATE_TRANSITION", "Use the assignment release instead");
      }
      const options = {
        actor: auditActorOf(actor),
        actorUserId: actor.userId,
        reason,
        now,
        correlationId: ctx.correlationId,
      };
      const updated = await applyJobTransition(
        tx,
        job,
        data.to,
        { hasActiveAssignment: await hasActiveAssignment(tx, job.id), booking },
        options,
      );
      if (
        data.to === "COMPLETED" &&
        (booking.status === "SCHEDULED" || booking.status === "CONFIRMED")
      ) {
        await applyBookingTransition(tx, booking, "COMPLETED", "COMPLETED", options);
      }
      return updated.status;
    });
  } catch (error) {
    const guardBlocked =
      (isDomainError(error, "POLICY_VIOLATION") && error.details?.["guard"] === "PAYMENT") ||
      pgErrorCode(error) === "23514";
    if (guardBlocked) {
      ctx.logger?.warn("payment_guard.blocked", {
        jobId: data.jobId,
        bookingId,
        correlationId: ctx.correlationId ?? null,
      });
      if (!isDomainError(error)) {
        throw new DomainError("POLICY_VIOLATION", "Payment guard: prepayment not confirmed", {
          guard: "PAYMENT",
        });
      }
    }
    throw error;
  }
}

function isAuthorizedForAnyWork(actor: Actor): boolean {
  return actor.roles.some(
    (r) =>
      (r.role === "STAFF" && isAuthorized(actor, "job:execute_own")) ||
      (r.role === "PARTNER" &&
        r.partnerId !== null &&
        isAuthorized(actor, "job:execute_own", { partnerId: r.partnerId })),
  );
}

// ------------------------------------------------------------------------------------------
// Read models
// ------------------------------------------------------------------------------------------

export const jobListQuerySchema = z.strictObject({
  status: z.enum(JOB_STATUSES).optional(),
  from: z.iso.date().optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(50).default(25),
});

export interface JobListItem {
  readonly id: string;
  readonly bookingId: string;
  readonly status: JobStatus;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly customerName: string;
  readonly propertyName: string;
  readonly assigneeName: string | null;
  readonly fulfillmentType: "IN_HOUSE" | "PARTNER" | null;
}

const activeAssignee = sql<string | null>`(
  SELECT COALESCE(e.display_name, p.legal_name)
  FROM job_assignment ja
  LEFT JOIN employee e ON e.id = ja.employee_id
  LEFT JOIN partner p ON p.id = ja.partner_id
  WHERE ja.job_id = "job"."id" AND ja.status = 'ACTIVE'
  LIMIT 1
)`;

export async function listJobs(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ items: JobListItem[]; total: number; page: number; pageSize: number }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "job:read");
  const f = parseInput(jobListQuerySchema, input ?? {});
  const j = schema.job;
  const conditions: SQL[] = [];
  if (f.status !== undefined) conditions.push(eq(j.status, f.status));
  if (f.from !== undefined) conditions.push(gte(j.scheduledStart, new Date(`${f.from}T00:00:00Z`)));
  const where = and(...conditions);
  const [totalRow] = await ctx.db.select({ total: count() }).from(j).where(where);
  const items = await ctx.db
    .select({
      id: j.id,
      bookingId: j.bookingId,
      status: j.status,
      scheduledStart: j.scheduledStart,
      scheduledEnd: j.scheduledEnd,
      customerName: schema.customer.displayName,
      propertyName: schema.property.name,
      assigneeName: activeAssignee,
      fulfillmentType: j.fulfillmentType,
    })
    .from(j)
    .innerJoin(schema.booking, eq(schema.booking.id, j.bookingId))
    .innerJoin(schema.customer, eq(schema.customer.id, schema.booking.customerId))
    .innerJoin(schema.property, eq(schema.property.id, schema.booking.propertyId))
    .where(where)
    .orderBy(asc(j.scheduledStart), asc(j.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  return { items, total: totalRow?.total ?? 0, page: f.page, pageSize: f.pageSize };
}

export interface JobDetail {
  readonly id: string;
  readonly status: JobStatus;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly durationMinutes: number;
  readonly requiredQualifications: readonly string[];
  readonly serviceAreaName: string | null;
  readonly fulfillmentType: "IN_HOUSE" | "PARTNER" | null;
  readonly operationalNotes: string | null;
  readonly customer: { readonly id: string; readonly name: string };
  readonly property: { readonly id: string; readonly name: string; readonly type: string };
  readonly addressLine: string;
  readonly services: readonly string[];
  readonly booking: {
    readonly id: string;
    readonly status: string;
    readonly paymentRequirement: string;
    readonly paymentStatus: string | null;
    readonly quoteId: string | null;
    readonly currency: string;
    readonly netCents: number;
    readonly grossCents: number;
  };
  readonly assignment: {
    readonly kind: "EMPLOYEE" | "PARTNER";
    readonly id: string;
    readonly name: string;
    readonly score: number | null;
    readonly factors: Readonly<Record<string, unknown>>;
    readonly assignedAt: Date;
  } | null;
  readonly assignmentHistory: readonly {
    readonly name: string;
    readonly kind: "EMPLOYEE" | "PARTNER";
    readonly status: "ACTIVE" | "RELEASED";
    readonly assignedAt: Date;
    readonly releasedAt: Date | null;
    readonly releaseReason: string | null;
  }[];
  readonly history: readonly {
    readonly fromStatus: JobStatus | null;
    readonly toStatus: JobStatus;
    readonly actorName: string | null;
    readonly reason: string | null;
    readonly createdAt: Date;
  }[];
  /** Only with finance:internal_read; otherwise null. */
  readonly internalFinance: {
    readonly internalCostCents: number | null;
    readonly contributionMarginCents: number | null;
    readonly pricedItems: number;
    readonly manualItems: number;
  } | null;
  /** Only with audit:read; otherwise null. */
  readonly audit:
    | readonly {
        readonly action: string;
        readonly actorName: string | null;
        readonly occurredAt: Date;
      }[]
    | null;
}

const jobIdInput = z.strictObject({ jobId: z.uuid() });

export async function getJob(ctx: ServiceContext, input: unknown): Promise<JobDetail> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "job:read");
  const { jobId } = parseInput(jobIdInput, input);
  const j = schema.job;
  const b = schema.booking;
  const a = schema.customerAddress;
  const [row] = await ctx.db
    .select({
      job: j,
      booking: b,
      customerName: schema.customer.displayName,
      propertyName: schema.property.name,
      propertyType: schema.property.propertyType,
      areaName: schema.serviceArea.name,
      street: a.street,
      houseNumber: a.houseNumber,
      postalCode: a.postalCode,
      city: a.city,
    })
    .from(j)
    .innerJoin(b, eq(b.id, j.bookingId))
    .innerJoin(schema.customer, eq(schema.customer.id, b.customerId))
    .innerJoin(schema.property, eq(schema.property.id, b.propertyId))
    .innerJoin(a, eq(a.id, b.addressId))
    .leftJoin(schema.serviceArea, eq(schema.serviceArea.id, j.serviceAreaId))
    .where(eq(j.id, jobId))
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Job not found");

  const ja = schema.jobAssignment;
  const [items, assignments, history] = await Promise.all([
    ctx.db
      .select({
        description: schema.bookingItem.description,
        quoteItemId: schema.bookingItem.quoteItemId,
      })
      .from(schema.bookingItem)
      .where(eq(schema.bookingItem.bookingId, row.booking.id))
      .orderBy(asc(schema.bookingItem.position)),
    ctx.db
      .select({
        employeeId: ja.employeeId,
        partnerId: ja.partnerId,
        employeeName: schema.employee.displayName,
        partnerName: schema.partner.legalName,
        status: ja.status,
        score: ja.score,
        factors: ja.factors,
        assignedAt: ja.assignedAt,
        releasedAt: ja.releasedAt,
        releaseReason: ja.releaseReason,
      })
      .from(ja)
      .leftJoin(schema.employee, eq(schema.employee.id, ja.employeeId))
      .leftJoin(schema.partner, eq(schema.partner.id, ja.partnerId))
      .where(eq(ja.jobId, jobId))
      .orderBy(desc(ja.assignedAt)),
    ctx.db
      .select({
        fromStatus: schema.jobStatusTransition.fromStatus,
        toStatus: schema.jobStatusTransition.toStatus,
        actorName: schema.user.name,
        reason: schema.jobStatusTransition.reason,
        createdAt: schema.jobStatusTransition.createdAt,
      })
      .from(schema.jobStatusTransition)
      .leftJoin(schema.user, eq(schema.user.id, schema.jobStatusTransition.actorUserId))
      .where(eq(schema.jobStatusTransition.jobId, jobId))
      .orderBy(desc(schema.jobStatusTransition.createdAt)),
  ]);

  const nameOf = (x: (typeof assignments)[number]) => x.employeeName ?? x.partnerName ?? "–";
  const active = assignments.find((x) => x.status === "ACTIVE");

  let internalFinance: JobDetail["internalFinance"] = null;
  if (hasGlobalPermission(actor, "finance:internal_read")) {
    const quoteItemIds = items.map((i) => i.quoteItemId).filter((id): id is string => id !== null);
    const priced =
      quoteItemIds.length === 0
        ? []
        : await ctx.db
            .select({
              internalCost: schema.pricingCalculation.internalCostCents,
              margin: schema.pricingCalculation.contributionMarginCents,
            })
            .from(schema.quoteItem)
            .innerJoin(
              schema.pricingCalculation,
              eq(schema.pricingCalculation.id, schema.quoteItem.pricingCalculationId),
            )
            .where(
              and(
                inArray(schema.quoteItem.id, quoteItemIds),
                isNotNull(schema.quoteItem.pricingCalculationId),
              ),
            );
    const complete = priced.length === items.length && priced.every((p) => p.internalCost !== null);
    internalFinance = {
      internalCostCents: complete ? priced.reduce((s, p) => s + (p.internalCost ?? 0), 0) : null,
      contributionMarginCents: complete ? priced.reduce((s, p) => s + (p.margin ?? 0), 0) : null,
      pricedItems: priced.length,
      manualItems: items.length - priced.length,
    };
  }

  let audit: JobDetail["audit"] = null;
  if (hasGlobalPermission(actor, "audit:read")) {
    audit = await ctx.db
      .select({
        action: schema.auditLog.action,
        actorName: schema.user.name,
        occurredAt: schema.auditLog.occurredAt,
      })
      .from(schema.auditLog)
      .leftJoin(schema.user, eq(schema.user.id, schema.auditLog.actorId))
      .where(and(eq(schema.auditLog.entityType, "job"), eq(schema.auditLog.entityId, jobId)))
      .orderBy(desc(schema.auditLog.occurredAt))
      .limit(50);
  }

  const job = row.job;
  return {
    id: job.id,
    status: job.status,
    scheduledStart: job.scheduledStart,
    scheduledEnd: job.scheduledEnd,
    durationMinutes: Math.round(
      (job.scheduledEnd.getTime() - job.scheduledStart.getTime()) / 60_000,
    ),
    requiredQualifications: job.requiredQualifications,
    serviceAreaName: row.areaName,
    fulfillmentType: job.fulfillmentType,
    operationalNotes: job.operationalNotes,
    customer: { id: row.booking.customerId, name: row.customerName },
    property: { id: row.booking.propertyId, name: row.propertyName, type: row.propertyType },
    addressLine: `${row.street} ${row.houseNumber}, ${row.postalCode} ${row.city}`,
    services: items.map((i) => i.description),
    booking: {
      id: row.booking.id,
      status: row.booking.status,
      paymentRequirement: row.booking.paymentRequirement,
      paymentStatus: row.booking.paymentStatus,
      quoteId: row.booking.quoteId,
      currency: row.booking.currency,
      netCents: row.booking.netCents,
      grossCents: row.booking.grossCents,
    },
    assignment:
      active === undefined
        ? null
        : {
            kind: active.employeeId !== null ? "EMPLOYEE" : "PARTNER",
            id: active.employeeId ?? active.partnerId ?? "",
            name: nameOf(active),
            score: active.score,
            factors: active.factors,
            assignedAt: active.assignedAt,
          },
    assignmentHistory: assignments.map((x) => ({
      name: nameOf(x),
      kind: x.employeeId !== null ? ("EMPLOYEE" as const) : ("PARTNER" as const),
      status: x.status,
      assignedAt: x.assignedAt,
      releasedAt: x.releasedAt,
      releaseReason: x.releaseReason,
    })),
    history,
    internalFinance,
    audit,
  };
}

export interface OwnJob {
  readonly id: string;
  readonly status: JobStatus;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly propertyName: string;
  readonly addressLine: string;
  readonly services: readonly string[];
  readonly operationalNotes: string | null;
}

/** Jobs actively assigned to the acting employee/partner (no prices, no customer contacts). */
export async function listOwnJobs(ctx: ServiceContext, input: unknown): Promise<OwnJob[]> {
  const actor = requireActor(ctx.actor);
  const { jobId } = parseInput(z.strictObject({ jobId: z.uuid().optional() }), input ?? {});
  if (!isAuthorizedForAnyWork(actor)) {
    throw new DomainError("FORBIDDEN", "Not allowed", { permission: "job:execute_own" });
  }
  const condition = assignmentOfWorker(await workerScopeOf(ctx, actor));
  if (condition === undefined) return [];
  const j = schema.job;
  const b = schema.booking;
  const a = schema.customerAddress;
  const since = new Date(ctx.clock.now().getTime() - 7 * 24 * 60 * 60_000);
  const rows = await ctx.db
    .select({
      id: j.id,
      bookingId: j.bookingId,
      status: j.status,
      scheduledStart: j.scheduledStart,
      scheduledEnd: j.scheduledEnd,
      propertyName: schema.property.name,
      street: a.street,
      houseNumber: a.houseNumber,
      postalCode: a.postalCode,
      city: a.city,
      operationalNotes: j.operationalNotes,
    })
    .from(schema.jobAssignment)
    .innerJoin(j, eq(j.id, schema.jobAssignment.jobId))
    .innerJoin(b, eq(b.id, j.bookingId))
    .innerJoin(schema.property, eq(schema.property.id, b.propertyId))
    .innerJoin(a, eq(a.id, b.addressId))
    .where(
      and(
        condition,
        jobId === undefined ? gte(j.scheduledEnd, since) : eq(j.id, jobId),
        inArray(j.status, ["ASSIGNED", "IN_PROGRESS", "COMPLETED"]),
      ),
    )
    .orderBy(asc(j.scheduledStart))
    .limit(100);
  if (jobId !== undefined && rows.length === 0) {
    throw new DomainError("NOT_FOUND", "Job not found");
  }
  const bookingIds = [...new Set(rows.map((r) => r.bookingId))];
  const items =
    bookingIds.length === 0
      ? []
      : await ctx.db
          .select({
            bookingId: schema.bookingItem.bookingId,
            description: schema.bookingItem.description,
          })
          .from(schema.bookingItem)
          .where(inArray(schema.bookingItem.bookingId, bookingIds))
          .orderBy(asc(schema.bookingItem.position));
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    scheduledStart: r.scheduledStart,
    scheduledEnd: r.scheduledEnd,
    propertyName: r.propertyName,
    addressLine: `${r.street} ${r.houseNumber}, ${r.postalCode} ${r.city}`,
    services: items.filter((i) => i.bookingId === r.bookingId).map((i) => i.description),
    operationalNotes: r.operationalNotes,
  }));
}
