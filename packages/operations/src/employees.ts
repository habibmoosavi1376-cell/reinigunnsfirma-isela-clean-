import { recordAudit } from "@isela/audit";
import { auditActorOf, requireActor, type ServiceContext } from "@isela/auth";
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNull,
  schema,
  type SQL,
  type Transaction,
} from "@isela/database";
import { DomainError } from "@isela/shared";
import { latitudeSchema, longitudeSchema, parseInput, trimmedText, z } from "@isela/validation";
import { pgErrorCode, requireGlobal } from "./internal.ts";

/*
 * Employees (own staff). Master data, qualifications, service areas, weekly working windows
 * and absences are maintained by employee:manage; dispatch reads them (employee:read).
 * Absences carry a neutral kind only – no reasons and no health data. STAFF accounts are
 * linked explicitly and see only their own assigned jobs (never other employees).
 */

const qualificationKey = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(64);
const qualificationsSchema = z
  .array(qualificationKey)
  .max(50)
  .transform((q) => [...new Set(q)].sort());

const createInput = z.strictObject({
  displayName: trimmedText(200),
  qualifications: qualificationsSchema.optional(),
  maxJobsPerDay: z.number().int().min(1).max(50).nullable().optional(),
  baseLatitude: latitudeSchema.nullable().optional(),
  baseLongitude: longitudeSchema.nullable().optional(),
});

function assertCoordinates(lat: number | null | undefined, lng: number | null | undefined): void {
  if ((lat == null) !== (lng == null)) {
    throw new DomainError("VALIDATION_FAILED", "Latitude and longitude must be set together");
  }
}

export async function createEmployee(ctx: ServiceContext, input: unknown): Promise<string> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "employee:manage");
  const data = parseInput(createInput, input);
  assertCoordinates(data.baseLatitude, data.baseLongitude);
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.employee)
      .values({
        displayName: data.displayName,
        qualifications: data.qualifications ?? [],
        maxJobsPerDay: data.maxJobsPerDay ?? null,
        baseLatitude: data.baseLatitude ?? null,
        baseLongitude: data.baseLongitude ?? null,
      })
      .returning({ id: schema.employee.id });
    if (row === undefined) throw new DomainError("CONFLICT", "Employee could not be created");
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "employee.created",
      entityType: "employee",
      entityId: row.id,
      after: {
        qualifications: data.qualifications ?? [],
        maxJobsPerDay: data.maxJobsPerDay ?? null,
      },
      correlationId: ctx.correlationId,
    });
    return row.id;
  });
}

const updateInput = z.strictObject({
  employeeId: z.uuid(),
  displayName: trimmedText(200).optional(),
  active: z.boolean().optional(),
  qualifications: qualificationsSchema.optional(),
  maxJobsPerDay: z.number().int().min(1).max(50).nullable().optional(),
});

export async function updateEmployee(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "employee:manage");
  const data = parseInput(updateInput, input);
  const { employeeId, ...patch } = data;
  const changedFields = Object.keys(patch);
  if (changedFields.length === 0) throw new DomainError("VALIDATION_FAILED", "Nothing to update");
  await ctx.db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.employee)
      .set({ ...patch, updatedAt: ctx.clock.now() })
      .where(and(eq(schema.employee.id, employeeId), isNull(schema.employee.archivedAt)))
      .returning({ id: schema.employee.id });
    if (updated.length === 0) throw new DomainError("NOT_FOUND", "Employee not found");
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "employee.updated",
      entityType: "employee",
      entityId: employeeId,
      after: {
        changedFields,
        ...(patch.active === undefined ? {} : { active: patch.active }),
        ...(patch.qualifications === undefined ? {} : { qualifications: patch.qualifications }),
      },
      correlationId: ctx.correlationId,
    });
  });
}

const serviceAreasInput = z.strictObject({
  employeeId: z.uuid(),
  serviceAreaIds: z.array(z.uuid()).max(50),
});

export async function setEmployeeServiceAreas(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "employee:manage");
  const data = parseInput(serviceAreasInput, input);
  const areaIds = [...new Set(data.serviceAreaIds)];
  await ctx.db.transaction(async (tx) => {
    await assertEmployee(tx, data.employeeId);
    if (areaIds.length > 0) {
      const found = await tx
        .select({ id: schema.serviceArea.id })
        .from(schema.serviceArea)
        .where(inArray(schema.serviceArea.id, areaIds));
      if (found.length !== areaIds.length) {
        throw new DomainError("NOT_FOUND", "Service area not found");
      }
    }
    await tx
      .delete(schema.employeeServiceArea)
      .where(eq(schema.employeeServiceArea.employeeId, data.employeeId));
    if (areaIds.length > 0) {
      await tx
        .insert(schema.employeeServiceArea)
        .values(areaIds.map((serviceAreaId) => ({ employeeId: data.employeeId, serviceAreaId })));
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "employee.service_areas_changed",
      entityType: "employee",
      entityId: data.employeeId,
      after: { serviceAreaIds: areaIds },
      correlationId: ctx.correlationId,
    });
  });
}

async function assertEmployee(tx: Transaction, employeeId: string): Promise<void> {
  const [row] = await tx
    .select({ id: schema.employee.id })
    .from(schema.employee)
    .where(and(eq(schema.employee.id, employeeId), isNull(schema.employee.archivedAt)))
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Employee not found");
}

const windowInput = z
  .strictObject({
    employeeId: z.uuid(),
    weekday: z.number().int().min(1).max(7),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .refine((w) => w.endMinute > w.startMinute, { message: "End must be after start" });

export async function addWorkingWindow(ctx: ServiceContext, input: unknown): Promise<string> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "employee:manage");
  const data = parseInput(windowInput, input);
  return ctx.db.transaction(async (tx) => {
    await assertEmployee(tx, data.employeeId);
    const [row] = await tx
      .insert(schema.employeeWorkingWindow)
      .values(data)
      .returning({ id: schema.employeeWorkingWindow.id });
    if (row === undefined) throw new DomainError("CONFLICT", "Window could not be created");
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "employee.working_window_added",
      entityType: "employee",
      entityId: data.employeeId,
      after: { weekday: data.weekday, startMinute: data.startMinute, endMinute: data.endMinute },
      correlationId: ctx.correlationId,
    });
    return row.id;
  });
}

const removeWindowInput = z.strictObject({ employeeId: z.uuid(), windowId: z.uuid() });

export async function removeWorkingWindow(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "employee:manage");
  const data = parseInput(removeWindowInput, input);
  await ctx.db.transaction(async (tx) => {
    const deleted = await tx
      .delete(schema.employeeWorkingWindow)
      .where(
        and(
          eq(schema.employeeWorkingWindow.id, data.windowId),
          eq(schema.employeeWorkingWindow.employeeId, data.employeeId),
        ),
      )
      .returning({ id: schema.employeeWorkingWindow.id });
    if (deleted.length === 0) throw new DomainError("NOT_FOUND", "Working window not found");
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "employee.working_window_removed",
      entityType: "employee",
      entityId: data.employeeId,
      after: { windowId: data.windowId },
      correlationId: ctx.correlationId,
    });
  });
}

const unavailabilityInput = z
  .strictObject({
    employeeId: z.uuid(),
    kind: z.enum(["ABSENCE", "TRAINING", "OTHER"]),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
  })
  .refine((u) => new Date(u.endsAt) > new Date(u.startsAt), { message: "End must be after start" });

export async function addUnavailability(ctx: ServiceContext, input: unknown): Promise<string> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "employee:manage");
  const data = parseInput(unavailabilityInput, input);
  return ctx.db.transaction(async (tx) => {
    await assertEmployee(tx, data.employeeId);
    const [row] = await tx
      .insert(schema.employeeUnavailability)
      .values({
        employeeId: data.employeeId,
        kind: data.kind,
        startsAt: new Date(data.startsAt),
        endsAt: new Date(data.endsAt),
        createdByUserId: actor.userId,
      })
      .returning({ id: schema.employeeUnavailability.id });
    if (row === undefined) throw new DomainError("CONFLICT", "Absence could not be created");
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "employee.unavailability_added",
      entityType: "employee",
      entityId: data.employeeId,
      after: { kind: data.kind },
      correlationId: ctx.correlationId,
    });
    return row.id;
  });
}

const linkInput = z.strictObject({ employeeId: z.uuid(), userId: z.string().min(1).max(100) });

/** Links a STAFF account to an employee (one account per employee and vice versa). */
export async function linkEmployeeAccount(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "employee:manage");
  const data = parseInput(linkInput, input);
  await ctx.db
    .transaction(async (tx) => {
      await assertEmployee(tx, data.employeeId);
      const [staff] = await tx
        .select({ userId: schema.userRole.userId })
        .from(schema.userRole)
        .where(and(eq(schema.userRole.userId, data.userId), eq(schema.userRole.roleKey, "STAFF")))
        .limit(1);
      if (staff === undefined) throw new DomainError("NOT_FOUND", "Staff account not found");
      await tx
        .update(schema.employee)
        .set({ userId: data.userId, updatedAt: ctx.clock.now() })
        .where(eq(schema.employee.id, data.employeeId));
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: "employee.account_linked",
        entityType: "employee",
        entityId: data.employeeId,
        after: { userId: data.userId },
        correlationId: ctx.correlationId,
      });
    })
    .catch((error: unknown) => {
      if (pgErrorCode(error) === "23505") {
        throw new DomainError("CONFLICT", "The account is already linked to an employee");
      }
      throw error;
    });
}

// ------------------------------------------------------------------------------------------
// Read models
// ------------------------------------------------------------------------------------------

export interface EmployeeListItem {
  readonly id: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly qualifications: readonly string[];
  readonly maxJobsPerDay: number | null;
  readonly hasAccount: boolean;
  readonly serviceAreas: number;
  readonly workingWindows: number;
}

const listInput = z.strictObject({
  active: z.boolean().optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(50).default(25),
});

export async function listEmployees(ctx: ServiceContext, input: unknown) {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "employee:read");
  const f = parseInput(listInput, input ?? {});
  const e = schema.employee;
  const conditions: SQL[] = [isNull(e.archivedAt)];
  if (f.active !== undefined) conditions.push(eq(e.active, f.active));
  const where = and(...conditions);
  const [totalRow] = await ctx.db.select({ total: count() }).from(e).where(where);
  const rows = await ctx.db
    .select({
      id: e.id,
      displayName: e.displayName,
      active: e.active,
      qualifications: e.qualifications,
      maxJobsPerDay: e.maxJobsPerDay,
      userId: e.userId,
    })
    .from(e)
    .where(where)
    .orderBy(asc(e.displayName), asc(e.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  const ids = rows.map((r) => r.id);
  const [areas, windows] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([
          ctx.db
            .select({ employeeId: schema.employeeServiceArea.employeeId, n: count() })
            .from(schema.employeeServiceArea)
            .where(inArray(schema.employeeServiceArea.employeeId, ids))
            .groupBy(schema.employeeServiceArea.employeeId),
          ctx.db
            .select({ employeeId: schema.employeeWorkingWindow.employeeId, n: count() })
            .from(schema.employeeWorkingWindow)
            .where(inArray(schema.employeeWorkingWindow.employeeId, ids))
            .groupBy(schema.employeeWorkingWindow.employeeId),
        ]);
  const items: EmployeeListItem[] = rows.map(({ userId, ...r }) => ({
    ...r,
    hasAccount: userId !== null,
    serviceAreas: areas.find((a) => a.employeeId === r.id)?.n ?? 0,
    workingWindows: windows.find((w) => w.employeeId === r.id)?.n ?? 0,
  }));
  return { items, total: totalRow?.total ?? 0, page: f.page, pageSize: f.pageSize };
}

export interface EmployeeDetail {
  readonly id: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly qualifications: readonly string[];
  readonly maxJobsPerDay: number | null;
  readonly hasBaseLocation: boolean;
  readonly accountName: string | null;
  readonly serviceAreas: readonly { readonly id: string; readonly name: string }[];
  readonly workingWindows: readonly {
    readonly id: string;
    readonly weekday: number;
    readonly startMinute: number;
    readonly endMinute: number;
  }[];
  readonly unavailability: readonly {
    readonly id: string;
    readonly kind: "ABSENCE" | "TRAINING" | "OTHER";
    readonly startsAt: Date;
    readonly endsAt: Date;
  }[];
  readonly upcomingAssignments: readonly {
    readonly jobId: string;
    readonly startsAt: Date;
    readonly endsAt: Date;
  }[];
}

const employeeIdInput = z.strictObject({ employeeId: z.uuid() });

export async function getEmployee(ctx: ServiceContext, input: unknown): Promise<EmployeeDetail> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "employee:read");
  const { employeeId } = parseInput(employeeIdInput, input);
  const e = schema.employee;
  const [row] = await ctx.db
    .select({
      id: e.id,
      displayName: e.displayName,
      active: e.active,
      qualifications: e.qualifications,
      maxJobsPerDay: e.maxJobsPerDay,
      baseLatitude: e.baseLatitude,
      accountName: schema.user.name,
    })
    .from(e)
    .leftJoin(schema.user, eq(schema.user.id, e.userId))
    .where(and(eq(e.id, employeeId), isNull(e.archivedAt)))
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Employee not found");
  const now = ctx.clock.now();
  const [serviceAreas, workingWindows, unavailability, upcomingAssignments] = await Promise.all([
    ctx.db
      .select({ id: schema.serviceArea.id, name: schema.serviceArea.name })
      .from(schema.employeeServiceArea)
      .innerJoin(
        schema.serviceArea,
        eq(schema.serviceArea.id, schema.employeeServiceArea.serviceAreaId),
      )
      .where(eq(schema.employeeServiceArea.employeeId, employeeId))
      .orderBy(asc(schema.serviceArea.name)),
    ctx.db
      .select({
        id: schema.employeeWorkingWindow.id,
        weekday: schema.employeeWorkingWindow.weekday,
        startMinute: schema.employeeWorkingWindow.startMinute,
        endMinute: schema.employeeWorkingWindow.endMinute,
      })
      .from(schema.employeeWorkingWindow)
      .where(eq(schema.employeeWorkingWindow.employeeId, employeeId))
      .orderBy(
        asc(schema.employeeWorkingWindow.weekday),
        asc(schema.employeeWorkingWindow.startMinute),
      ),
    ctx.db
      .select({
        id: schema.employeeUnavailability.id,
        kind: schema.employeeUnavailability.kind,
        startsAt: schema.employeeUnavailability.startsAt,
        endsAt: schema.employeeUnavailability.endsAt,
      })
      .from(schema.employeeUnavailability)
      .where(
        and(
          eq(schema.employeeUnavailability.employeeId, employeeId),
          gte(schema.employeeUnavailability.endsAt, now),
        ),
      )
      .orderBy(asc(schema.employeeUnavailability.startsAt))
      .limit(50),
    ctx.db
      .select({
        jobId: schema.jobAssignment.jobId,
        startsAt: schema.jobAssignment.startsAt,
        endsAt: schema.jobAssignment.endsAt,
      })
      .from(schema.jobAssignment)
      .where(
        and(
          eq(schema.jobAssignment.employeeId, employeeId),
          eq(schema.jobAssignment.status, "ACTIVE"),
          gte(schema.jobAssignment.endsAt, now),
        ),
      )
      .orderBy(asc(schema.jobAssignment.startsAt))
      .limit(50),
  ]);
  return {
    id: row.id,
    displayName: row.displayName,
    active: row.active,
    qualifications: row.qualifications,
    maxJobsPerDay: row.maxJobsPerDay,
    hasBaseLocation: row.baseLatitude !== null,
    accountName: row.accountName,
    serviceAreas,
    workingWindows,
    unavailability,
    upcomingAssignments,
  };
}

/** STAFF accounts that are not linked to an employee yet (for the link form; names only). */
export async function listLinkableStaffAccounts(
  ctx: ServiceContext,
): Promise<{ userId: string; name: string }[]> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "employee:manage");
  const rows = await ctx.db
    .select({ userId: schema.userRole.userId, name: schema.user.name, linked: schema.employee.id })
    .from(schema.userRole)
    .innerJoin(schema.user, eq(schema.user.id, schema.userRole.userId))
    .leftJoin(schema.employee, eq(schema.employee.userId, schema.userRole.userId))
    .where(eq(schema.userRole.roleKey, "STAFF"))
    .orderBy(asc(schema.user.name))
    .limit(200);
  return rows.filter((r) => r.linked === null).map((r) => ({ userId: r.userId, name: r.name }));
}
