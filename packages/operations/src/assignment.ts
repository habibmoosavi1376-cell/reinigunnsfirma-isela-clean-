import { recordAudit } from "@isela/audit";
import { auditActorOf, requireActor, type Actor, type ServiceContext } from "@isela/auth";
import {
  and,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  schema,
  sql,
  type DbExecutor,
  type SQL,
  type Transaction,
} from "@isela/database";
import { DomainError, isDomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import {
  operationsConfigSchema,
  type OperationsConfig,
  type PartnerDocumentKind,
} from "./config.ts";
import {
  applyBookingTransition,
  applyJobTransition,
  lockBookingAndJob,
  pgErrorCode,
  requireGlobal,
  type BookingRow,
  type JobRow,
} from "./internal.ts";
import {
  evaluateCandidate,
  rankCandidates,
  type AssignmentCandidate,
  type EmployeeFacts,
  type JobRequirements,
  type PartnerFacts,
} from "./scoring.ts";
import { localInterval, localTime } from "./time.ts";

/*
 * Assignment. Candidates are computed on the server from stored facts; a dispatcher chooses
 * one, and the server evaluates exactly that candidate again inside the transaction under an
 * advisory lock. A forged or ineligible employee/partner id is rejected – the browser can
 * never force an arbitrary assignment. There is no automatic assignment.
 * Lock order everywhere: booking → job (prevents deadlocks with payments/cancellations).
 */

interface JobContext {
  readonly job: JobRow;
  readonly requirements: JobRequirements;
  readonly point: { latitude: number; longitude: number } | null;
}

async function loadJobContext(
  db: DbExecutor,
  job: JobRow,
  config: OperationsConfig,
): Promise<JobContext> {
  const [booking] = await db
    .select({ addressId: schema.booking.addressId })
    .from(schema.booking)
    .where(eq(schema.booking.id, job.bookingId))
    .limit(1);
  if (booking === undefined) throw new DomainError("NOT_FOUND", "Booking not found");
  const [address] = await db
    .select({
      latitude: schema.customerAddress.latitude,
      longitude: schema.customerAddress.longitude,
    })
    .from(schema.customerAddress)
    .where(eq(schema.customerAddress.id, booking.addressId))
    .limit(1);
  const items = await db
    .select({ serviceId: schema.bookingItem.serviceId })
    .from(schema.bookingItem)
    .where(eq(schema.bookingItem.bookingId, job.bookingId));
  const local = localInterval(job.scheduledStart, job.scheduledEnd, config.timeZone);
  return {
    job,
    point:
      address?.latitude != null && address.longitude != null
        ? { latitude: address.latitude, longitude: address.longitude }
        : null,
    requirements: {
      requiredQualifications: job.requiredQualifications,
      serviceIds: items.map((i) => i.serviceId),
      serviceAreaId: job.serviceAreaId,
      local:
        local === null
          ? null
          : { weekday: local.weekday, startMinute: local.startMinute, endMinute: local.endMinute },
      date: localTime(job.scheduledStart, config.timeZone).date,
    },
  };
}

function pointSql(point: { latitude: number; longitude: number }): SQL {
  return sql`ST_SetSRID(ST_MakePoint(${point.longitude}::double precision, ${point.latitude}::double precision), 4326)::geography`;
}

/** Overlap with [start, end) of ACTIVE assignments of other jobs. */
function overlapping(ctx: JobContext): SQL[] {
  const ja = schema.jobAssignment;
  return [
    eq(ja.status, "ACTIVE"),
    ne(ja.jobId, ctx.job.id),
    lt(ja.startsAt, ctx.job.scheduledEnd),
    gt(ja.endsAt, ctx.job.scheduledStart),
  ];
}

async function loadEmployeeFacts(
  db: DbExecutor,
  ctx: JobContext,
  config: OperationsConfig,
  onlyId: string | null,
): Promise<EmployeeFacts[]> {
  const e = schema.employee;
  const distance =
    ctx.point === null
      ? sql<number | null>`NULL::double precision`
      : sql<
          number | null
        >`CASE WHEN ${e.baseLocation} IS NULL THEN NULL ELSE ST_Distance(${e.baseLocation}, ${pointSql(ctx.point)})::double precision END`;
  const employees = await db
    .select({
      id: e.id,
      name: e.displayName,
      active: e.active,
      archivedAt: e.archivedAt,
      qualifications: e.qualifications,
      maxJobsPerDay: e.maxJobsPerDay,
      distanceM: distance,
    })
    .from(e)
    .where(onlyId === null ? and(eq(e.active, true), isNull(e.archivedAt)) : eq(e.id, onlyId))
    .orderBy(e.displayName)
    .limit(200);
  if (employees.length === 0) return [];
  const ids = employees.map((x) => x.id);
  const ja = schema.jobAssignment;
  const u = schema.employeeUnavailability;
  const weekday = ctx.requirements.local?.weekday ?? 0;
  const [areas, windows, unavailable, overlaps, sameDay] = await Promise.all([
    db
      .select({
        employeeId: schema.employeeServiceArea.employeeId,
        serviceAreaId: schema.employeeServiceArea.serviceAreaId,
      })
      .from(schema.employeeServiceArea)
      .where(inArray(schema.employeeServiceArea.employeeId, ids)),
    db
      .select({
        employeeId: schema.employeeWorkingWindow.employeeId,
        startMinute: schema.employeeWorkingWindow.startMinute,
        endMinute: schema.employeeWorkingWindow.endMinute,
      })
      .from(schema.employeeWorkingWindow)
      .where(
        and(
          inArray(schema.employeeWorkingWindow.employeeId, ids),
          eq(schema.employeeWorkingWindow.weekday, weekday),
        ),
      ),
    db
      .selectDistinct({ employeeId: u.employeeId })
      .from(u)
      .where(
        and(
          inArray(u.employeeId, ids),
          lt(u.startsAt, ctx.job.scheduledEnd),
          gt(u.endsAt, ctx.job.scheduledStart),
        ),
      ),
    db
      .select({ employeeId: ja.employeeId, n: count() })
      .from(ja)
      .where(and(inArray(ja.employeeId, ids), ...overlapping(ctx)))
      .groupBy(ja.employeeId),
    db
      .select({ employeeId: ja.employeeId, n: count() })
      .from(ja)
      .where(
        and(
          inArray(ja.employeeId, ids),
          eq(ja.status, "ACTIVE"),
          ne(ja.jobId, ctx.job.id),
          sql`(${ja.startsAt} AT TIME ZONE ${config.timeZone})::date = ${ctx.requirements.date}::date`,
        ),
      )
      .groupBy(ja.employeeId),
  ]);
  return employees.map((x) => ({
    kind: "EMPLOYEE" as const,
    id: x.id,
    name: x.name,
    active: x.active && x.archivedAt === null,
    qualifications: x.qualifications,
    serviceAreaIds: areas.filter((a) => a.employeeId === x.id).map((a) => a.serviceAreaId),
    workingWindows: windows.filter((w) => w.employeeId === x.id),
    unavailable: unavailable.some((v) => v.employeeId === x.id),
    overlappingAssignments: overlaps.find((o) => o.employeeId === x.id)?.n ?? 0,
    jobsThatDay: sameDay.find((o) => o.employeeId === x.id)?.n ?? 0,
    maxJobsPerDay: x.maxJobsPerDay,
    distanceM: x.distanceM === null ? null : Math.round(x.distanceM),
  }));
}

async function loadPartnerFacts(
  db: DbExecutor,
  ctx: JobContext,
  onlyId: string | null,
): Promise<PartnerFacts[]> {
  const p = schema.partner;
  const point = ctx.point === null ? null : pointSql(ctx.point);
  const partners = await db
    .select({
      id: p.id,
      name: p.legalName,
      status: p.status,
      verifiedAt: p.verifiedAt,
      archivedAt: p.archivedAt,
      maxConcurrentJobs: p.maxConcurrentJobs,
      distanceM:
        point === null
          ? sql<number | null>`NULL::double precision`
          : sql<number | null>`ST_Distance(${p.baseLocation}, ${point})::double precision`,
      covers:
        point === null
          ? sql<boolean>`false`
          : sql<boolean>`ST_DWithin(${p.baseLocation}, ${point}, ${p.serviceRadiusM}::double precision)`,
    })
    .from(p)
    .where(onlyId === null ? and(eq(p.status, "ACTIVE"), isNull(p.archivedAt)) : eq(p.id, onlyId))
    .orderBy(p.legalName)
    .limit(200);
  if (partners.length === 0) return [];
  const ids = partners.map((x) => x.id);
  const d = schema.partnerDocument;
  const ja = schema.jobAssignment;
  const [services, documents, overlaps] = await Promise.all([
    db
      .select({
        partnerId: schema.partnerService.partnerId,
        serviceId: schema.partnerService.serviceId,
      })
      .from(schema.partnerService)
      .where(inArray(schema.partnerService.partnerId, ids)),
    db
      .select({ partnerId: d.partnerId, kind: d.kind })
      .from(d)
      .where(
        and(
          inArray(d.partnerId, ids),
          eq(d.status, "VERIFIED"),
          or(isNull(d.validUntil), gte(d.validUntil, ctx.requirements.date)),
        ),
      ),
    db
      .select({ partnerId: ja.partnerId, n: count() })
      .from(ja)
      .where(and(inArray(ja.partnerId, ids), ...overlapping(ctx)))
      .groupBy(ja.partnerId),
  ]);
  return partners.map((x) => ({
    kind: "PARTNER" as const,
    id: x.id,
    name: x.name,
    active: x.status === "ACTIVE" && x.archivedAt === null,
    verified: x.verifiedAt !== null,
    offeredServiceIds: services.filter((s) => s.partnerId === x.id).map((s) => s.serviceId),
    coversAddress: x.covers,
    validDocumentKinds: [
      ...new Set(documents.filter((doc) => doc.partnerId === x.id).map((doc) => doc.kind)),
    ] as PartnerDocumentKind[],
    overlappingAssignments: overlaps.find((o) => o.partnerId === x.id)?.n ?? 0,
    maxConcurrentJobs: x.maxConcurrentJobs,
    distanceM: x.distanceM === null ? null : Math.round(x.distanceM),
  }));
}

const jobIdInput = z.strictObject({ jobId: z.uuid() });

/** Ranked, explainable candidates for a job (dispatch view). */
export async function listAssignmentCandidates(
  ctx: ServiceContext,
  input: unknown,
  configInput: OperationsConfig,
): Promise<AssignmentCandidate[]> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "job:assign");
  const config = operationsConfigSchema.parse(configInput);
  const { jobId } = parseInput(jobIdInput, input);
  const [job] = await ctx.db.select().from(schema.job).where(eq(schema.job.id, jobId)).limit(1);
  if (job === undefined) throw new DomainError("NOT_FOUND", "Job not found");
  const jobCtx = await loadJobContext(ctx.db, job, config);
  const [employees, partners] = await Promise.all([
    loadEmployeeFacts(ctx.db, jobCtx, config, null),
    loadPartnerFacts(ctx.db, jobCtx, null),
  ]);
  return rankCandidates(
    [...employees, ...partners].map((f) => evaluateCandidate(f, jobCtx.requirements, config)),
  );
}

const candidateInput = z.strictObject({
  jobId: z.uuid(),
  kind: z.enum(["EMPLOYEE", "PARTNER"]),
  candidateId: z.uuid(),
});

async function assignInTransaction(
  tx: Transaction,
  actor: Actor,
  booking: BookingRow,
  job: JobRow,
  data: { kind: "EMPLOYEE" | "PARTNER"; candidateId: string },
  config: OperationsConfig,
  now: Date,
  correlationId: string | undefined,
): Promise<AssignmentCandidate> {
  if (job.status !== "ASSIGNMENT_PENDING") {
    throw new DomainError("INVALID_STATE_TRANSITION", "The job is not waiting for assignment", {
      status: job.status,
    });
  }
  // Serialise concurrent assignments of the same resource (capacity checks).
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`assign:${data.kind}:${data.candidateId}`}, 0))`,
  );
  const jobCtx = await loadJobContext(tx, job, config);
  const facts =
    data.kind === "EMPLOYEE"
      ? await loadEmployeeFacts(tx, jobCtx, config, data.candidateId)
      : await loadPartnerFacts(tx, jobCtx, data.candidateId);
  const fact = facts[0];
  if (fact === undefined) {
    throw new DomainError("NOT_FOUND", "Candidate not found");
  }
  const candidate = evaluateCandidate(fact, jobCtx.requirements, config);
  if (!candidate.eligible) {
    throw new DomainError("POLICY_VIOLATION", "The candidate is not eligible", {
      blockers: [...candidate.blockers],
    });
  }
  await tx.insert(schema.jobAssignment).values({
    jobId: job.id,
    employeeId: data.kind === "EMPLOYEE" ? data.candidateId : null,
    partnerId: data.kind === "PARTNER" ? data.candidateId : null,
    startsAt: job.scheduledStart,
    endsAt: job.scheduledEnd,
    score: candidate.score,
    factors: {
      distanceM: candidate.distanceM,
      factors: candidate.factors.map((f) => ({ ...f })),
      capacity: { ...candidate.capacity },
    },
    assignedByUserId: actor.userId,
    assignedAt: now,
  });
  const options = {
    actor: auditActorOf(actor),
    actorUserId: actor.userId,
    reason: null,
    now,
    correlationId,
  };
  await applyJobTransition(
    tx,
    job,
    "ASSIGNED",
    {
      hasActiveAssignment: true,
      booking,
      fulfillmentType: data.kind === "EMPLOYEE" ? "IN_HOUSE" : "PARTNER",
    },
    options,
  );
  if (booking.status === "CONFIRMED") {
    await applyBookingTransition(tx, booking, "SCHEDULED", "ASSIGNED", options);
  }
  const assignee =
    data.kind === "EMPLOYEE" ? { employeeId: data.candidateId } : { partnerId: data.candidateId };
  await recordAudit(tx, {
    actor: auditActorOf(actor),
    action: "job.assigned",
    entityType: "job",
    entityId: job.id,
    after: { kind: data.kind, ...assignee, score: candidate.score },
    correlationId,
  });
  await recordAudit(tx, {
    actor: auditActorOf(actor),
    action: data.kind === "EMPLOYEE" ? "employee.assigned" : "partner.assigned",
    entityType: data.kind === "EMPLOYEE" ? "employee" : "partner",
    entityId: data.candidateId,
    after: { jobId: job.id },
    correlationId,
  });
  return candidate;
}

function logAssignmentFailure(
  ctx: ServiceContext,
  jobId: string,
  kind: string,
  error: unknown,
): void {
  const blockers = isDomainError(error) ? error.details?.["blockers"] : undefined;
  ctx.logger?.warn("assignment.failed", {
    jobId,
    kind,
    code: isDomainError(error)
      ? error.code
      : pgErrorCode(error) === "23P01"
        ? "TIME_CONFLICT"
        : "UNEXPECTED",
    blockers: Array.isArray(blockers) ? blockers.join(",") : null,
    correlationId: ctx.correlationId ?? null,
  });
}

function mapOverlap(error: unknown): never {
  if (pgErrorCode(error) === "23P01") {
    throw new DomainError("CONFLICT", "The resource is already assigned in this period", {
      blockers: ["TIME_CONFLICT"],
    });
  }
  throw error;
}

export async function assignJob(
  ctx: ServiceContext,
  input: unknown,
  configInput: OperationsConfig,
): Promise<{ score: number | null }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "job:assign");
  const config = operationsConfigSchema.parse(configInput);
  const data = parseInput(candidateInput, input);
  try {
    const candidate = await ctx.db
      .transaction(async (tx) => {
        const { booking, job } = await lockBookingAndJob(tx, data.jobId);
        return assignInTransaction(
          tx,
          actor,
          booking,
          job,
          data,
          config,
          ctx.clock.now(),
          ctx.correlationId,
        );
      })
      .catch(mapOverlap);
    ctx.logger?.info("job.assigned", {
      jobId: data.jobId,
      kind: data.kind,
      score: candidate.score,
      correlationId: ctx.correlationId ?? null,
    });
    return { score: candidate.score };
  } catch (error) {
    logAssignmentFailure(ctx, data.jobId, data.kind, error);
    throw error;
  }
}

async function releaseInTransaction(
  tx: Transaction,
  actor: Actor,
  booking: BookingRow,
  job: JobRow,
  reason: string,
  now: Date,
  correlationId: string | undefined,
): Promise<{
  booking: BookingRow;
  job: JobRow;
  released: { employeeId: string | null; partnerId: string | null };
}> {
  if (job.status !== "ASSIGNED") {
    throw new DomainError("INVALID_STATE_TRANSITION", "The job is not assigned", {
      status: job.status,
    });
  }
  const [released] = await tx
    .update(schema.jobAssignment)
    .set({
      status: "RELEASED",
      releasedAt: now,
      releasedByUserId: actor.userId,
      releaseReason: reason,
    })
    .where(and(eq(schema.jobAssignment.jobId, job.id), eq(schema.jobAssignment.status, "ACTIVE")))
    .returning({
      employeeId: schema.jobAssignment.employeeId,
      partnerId: schema.jobAssignment.partnerId,
    });
  if (released === undefined) throw new DomainError("CONFLICT", "No active assignment");
  const options = {
    actor: auditActorOf(actor),
    actorUserId: actor.userId,
    reason,
    now,
    correlationId,
  };
  const nextJob = await applyJobTransition(
    tx,
    job,
    "ASSIGNMENT_PENDING",
    { hasActiveAssignment: false, booking, fulfillmentType: null },
    options,
  );
  let nextBooking = booking;
  if (booking.status === "SCHEDULED") {
    nextBooking = await applyBookingTransition(tx, booking, "CONFIRMED", nextJob.status, options);
  }
  await recordAudit(tx, {
    actor: auditActorOf(actor),
    action: "job.assignment_released",
    entityType: "job",
    entityId: job.id,
    after: { ...released },
    correlationId,
  });
  return { booking: nextBooking, job: nextJob, released };
}

const releaseInput = z.strictObject({
  jobId: z.uuid(),
  reason: z.string().trim().min(3).max(1000),
});

export async function releaseJobAssignment(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "job:assign");
  const data = parseInput(releaseInput, input);
  await ctx.db.transaction(async (tx) => {
    const { booking, job } = await lockBookingAndJob(tx, data.jobId);
    await releaseInTransaction(
      tx,
      actor,
      booking,
      job,
      data.reason,
      ctx.clock.now(),
      ctx.correlationId,
    );
  });
}

const reassignInput = candidateInput.extend({ reason: z.string().trim().min(3).max(1000) });

/** Release + assign in one transaction (either both or neither). */
export async function reassignJob(
  ctx: ServiceContext,
  input: unknown,
  configInput: OperationsConfig,
): Promise<{ score: number | null }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "job:assign");
  const config = operationsConfigSchema.parse(configInput);
  const data = parseInput(reassignInput, input);
  const now = ctx.clock.now();
  try {
    const candidate = await ctx.db
      .transaction(async (tx) => {
        const locked = await lockBookingAndJob(tx, data.jobId);
        const { booking, job, released } = await releaseInTransaction(
          tx,
          actor,
          locked.booking,
          locked.job,
          data.reason,
          now,
          ctx.correlationId,
        );
        const assigned = await assignInTransaction(
          tx,
          actor,
          booking,
          job,
          data,
          config,
          now,
          ctx.correlationId,
        );
        await recordAudit(tx, {
          actor: auditActorOf(actor),
          action: "job.reassigned",
          entityType: "job",
          entityId: job.id,
          before: { ...released },
          after: { kind: data.kind, candidateId: data.candidateId },
          correlationId: ctx.correlationId,
        });
        return assigned;
      })
      .catch(mapOverlap);
    return { score: candidate.score };
  } catch (error) {
    logAssignmentFailure(ctx, data.jobId, data.kind, error);
    throw error;
  }
}
