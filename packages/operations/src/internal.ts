import { recordAudit, type AuditActor } from "@isela/audit";
import { hasGlobalPermission, type Actor, type Permission } from "@isela/auth";
import { and, eq, schema, type Transaction } from "@isela/database";
import { DomainError } from "@isela/shared";
import {
  assertBookingTransition,
  assertJobTransition,
  type BookingStatus,
  type JobStatus,
} from "./state-machines.ts";

/*
 * Internal building blocks shared by the operations services. The only code paths that write
 * booking.status and job.status are `applyBookingTransition` and `applyJobTransition`: both
 * validate against the state machine, use an optimistic status condition on the locked row,
 * append the transition log and write the audit entry in the same transaction.
 */

export function requireGlobal(actor: Actor, permission: Permission): void {
  if (!hasGlobalPermission(actor, permission)) {
    throw new DomainError("FORBIDDEN", "Not allowed", { permission });
  }
}

export type BookingRow = typeof schema.booking.$inferSelect;
export type JobRow = typeof schema.job.$inferSelect;

export async function lockBooking(tx: Transaction, bookingId: string): Promise<BookingRow> {
  const [row] = await tx
    .select()
    .from(schema.booking)
    .where(eq(schema.booking.id, bookingId))
    .for("update")
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Booking not found");
  return row;
}

export async function lockJob(tx: Transaction, jobId: string): Promise<JobRow> {
  const [row] = await tx
    .select()
    .from(schema.job)
    .where(eq(schema.job.id, jobId))
    .for("update")
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Job not found");
  return row;
}

/** Locks a job's booking and then the job (the global lock order: booking → job). */
export async function lockBookingAndJob(
  tx: Transaction,
  jobId: string,
): Promise<{ booking: BookingRow; job: JobRow }> {
  const [ref] = await tx
    .select({ bookingId: schema.job.bookingId })
    .from(schema.job)
    .where(eq(schema.job.id, jobId))
    .limit(1);
  if (ref === undefined) throw new DomainError("NOT_FOUND", "Job not found");
  const booking = await lockBooking(tx, ref.bookingId);
  const job = await lockJob(tx, jobId);
  return { booking, job };
}

export async function findJobOfBooking(tx: Transaction, bookingId: string): Promise<JobRow | null> {
  const [row] = await tx
    .select()
    .from(schema.job)
    .where(eq(schema.job.bookingId, bookingId))
    .for("update")
    .limit(1);
  return row ?? null;
}

export async function hasActiveAssignment(tx: Transaction, jobId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.jobAssignment.id })
    .from(schema.jobAssignment)
    .where(and(eq(schema.jobAssignment.jobId, jobId), eq(schema.jobAssignment.status, "ACTIVE")))
    .limit(1);
  return row !== undefined;
}

export interface TransitionOptions {
  readonly actor: AuditActor;
  readonly actorUserId: string | null;
  readonly reason: string | null;
  readonly now: Date;
  readonly correlationId: string | undefined;
}

export async function applyBookingTransition(
  tx: Transaction,
  booking: BookingRow,
  to: BookingStatus,
  jobStatus: JobStatus | null,
  options: TransitionOptions,
): Promise<BookingRow> {
  assertBookingTransition(booking.status, to, {
    paymentRequirement: booking.paymentRequirement,
    paymentStatus: booking.paymentStatus,
    jobStatus,
    reason: options.reason,
  });
  const patch: Partial<typeof schema.booking.$inferInsert> = {
    status: to,
    version: booking.version + 1,
    updatedAt: options.now,
  };
  if (to === "CANCELLED") {
    patch.cancelledAt = options.now;
    patch.cancellationReason = options.reason;
  }
  if (to === "COMPLETED") patch.completedAt = options.now;
  const [updated] = await tx
    .update(schema.booking)
    .set(patch)
    .where(
      and(
        eq(schema.booking.id, booking.id),
        eq(schema.booking.status, booking.status),
        eq(schema.booking.version, booking.version),
      ),
    )
    .returning();
  if (updated === undefined) {
    throw new DomainError("CONFLICT", "Booking was changed concurrently");
  }
  await tx.insert(schema.bookingStatusTransition).values({
    bookingId: booking.id,
    fromStatus: booking.status,
    toStatus: to,
    actorUserId: options.actorUserId,
    reason: options.reason,
  });
  await recordAudit(tx, {
    actor: options.actor,
    action: "booking.status_changed",
    entityType: "booking",
    entityId: booking.id,
    before: { status: booking.status },
    after: { status: to },
    correlationId: options.correlationId,
  });
  return updated;
}

export interface JobTransitionData {
  readonly hasActiveAssignment: boolean;
  readonly booking: BookingRow;
  readonly fulfillmentType?: "IN_HOUSE" | "PARTNER" | null;
}

export async function applyJobTransition(
  tx: Transaction,
  job: JobRow,
  to: JobStatus,
  data: JobTransitionData,
  options: TransitionOptions,
): Promise<JobRow> {
  assertJobTransition(job.status, to, {
    hasActiveAssignment: data.hasActiveAssignment,
    bookingStatus: data.booking.status,
    paymentRequirement: data.booking.paymentRequirement,
    paymentStatus: data.booking.paymentStatus,
    reason: options.reason,
  });
  const patch: Partial<typeof schema.job.$inferInsert> = {
    status: to,
    version: job.version + 1,
    updatedAt: options.now,
  };
  if (data.fulfillmentType !== undefined) patch.fulfillmentType = data.fulfillmentType;
  if (to === "IN_PROGRESS") patch.startedAt = options.now;
  if (to === "COMPLETED") patch.completedAt = options.now;
  if (to === "CLOSED") patch.closedAt = options.now;
  const [updated] = await tx
    .update(schema.job)
    .set(patch)
    .where(
      and(
        eq(schema.job.id, job.id),
        eq(schema.job.status, job.status),
        eq(schema.job.version, job.version),
      ),
    )
    .returning();
  if (updated === undefined) {
    throw new DomainError("CONFLICT", "Job was changed concurrently");
  }
  await tx.insert(schema.jobStatusTransition).values({
    jobId: job.id,
    fromStatus: job.status,
    toStatus: to,
    actorUserId: options.actorUserId,
    reason: options.reason,
  });
  await recordAudit(tx, {
    actor: options.actor,
    action: "job.status_changed",
    entityType: "job",
    entityId: job.id,
    before: { status: job.status },
    after: { status: to },
    correlationId: options.correlationId,
  });
  return updated;
}

/** PostgreSQL error code of a (possibly wrapped) driver error. */
export function pgErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = cause?.code ?? (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
