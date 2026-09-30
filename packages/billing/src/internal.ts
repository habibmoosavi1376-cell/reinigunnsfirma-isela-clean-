import { recordAudit, type AuditActor } from "@isela/audit";
import { hasGlobalPermission, type Actor, type Permission } from "@isela/auth";
import { and, eq, schema, type Transaction } from "@isela/database";
import type { PaymentPolicySnapshot } from "@isela/operations";
import { DomainError } from "@isela/shared";
import type { BillingConfig } from "./config.ts";
import {
  assertInvoiceTransition,
  assertPaymentRecordTransition,
  type InvoiceStatus,
  type PaymentRecordStatus,
} from "./state-machines.ts";

/*
 * Internal building blocks of the billing services. The only code paths that write
 * invoice.status/paid_cents and payment.status/applied_cents are `applyInvoiceChange` and
 * `applyPaymentChange`: both validate against the state machine, use an optimistic version
 * condition on the locked row, append the transition log and write the audit entry in the
 * same transaction. Global lock order: customer-finance advisory lock → booking → invoice →
 * payment.
 */

/** Effective configuration every finance operation needs (loaded server-side per request). */
export interface FinanceOptions {
  readonly paymentPolicy: PaymentPolicySnapshot;
  /** Business time zone (operations config) for issue/due dates and overdue checks. */
  readonly timeZone: string;
  readonly billing: BillingConfig;
}

export function requireGlobal(actor: Actor, permission: Permission): void {
  if (!hasGlobalPermission(actor, permission)) {
    throw new DomainError("FORBIDDEN", "Not allowed", { permission });
  }
}

export type InvoiceRow = typeof schema.invoice.$inferSelect;
export type PaymentRow = typeof schema.payment.$inferSelect;
export type BookingRow = typeof schema.booking.$inferSelect;

export async function lockBookingRow(tx: Transaction, bookingId: string): Promise<BookingRow> {
  const [row] = await tx
    .select()
    .from(schema.booking)
    .where(eq(schema.booking.id, bookingId))
    .for("update")
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Booking not found");
  return row;
}

export async function lockInvoice(tx: Transaction, invoiceId: string): Promise<InvoiceRow> {
  const [row] = await tx
    .select()
    .from(schema.invoice)
    .where(eq(schema.invoice.id, invoiceId))
    .for("update")
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Invoice not found");
  return row;
}

export async function lockPayment(tx: Transaction, paymentId: string): Promise<PaymentRow> {
  const [row] = await tx
    .select()
    .from(schema.payment)
    .where(eq(schema.payment.id, paymentId))
    .for("update")
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Payment not found");
  return row;
}

/** Reads the ids needed to take locks in the global order without locking yet. */
export async function invoiceRefs(
  tx: Transaction,
  invoiceId: string,
): Promise<{ customerId: string; bookingId: string }> {
  const [row] = await tx
    .select({ customerId: schema.invoice.customerId, bookingId: schema.invoice.bookingId })
    .from(schema.invoice)
    .where(eq(schema.invoice.id, invoiceId))
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Invoice not found");
  return row;
}

export async function paymentRefs(
  tx: Transaction,
  paymentId: string,
): Promise<{ customerId: string; invoiceId: string; bookingId: string }> {
  const [row] = await tx
    .select({
      customerId: schema.payment.customerId,
      invoiceId: schema.payment.invoiceId,
      bookingId: schema.invoice.bookingId,
    })
    .from(schema.payment)
    .innerJoin(schema.invoice, eq(schema.invoice.id, schema.payment.invoiceId))
    .where(eq(schema.payment.id, paymentId))
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Payment not found");
  return row;
}

export interface ChangeOptions {
  readonly actor: AuditActor;
  readonly actorUserId: string | null;
  readonly reason: string | null;
  readonly now: Date;
  readonly correlationId: string | undefined;
}

/**
 * Writes an invoice change (status and/or amount/date fields) with the version check; a
 * status change is validated, logged append-only and audited.
 */
export async function applyInvoiceChange(
  tx: Transaction,
  invoice: InvoiceRow,
  patch: Partial<typeof schema.invoice.$inferInsert> & { status?: InvoiceStatus },
  options: ChangeOptions,
): Promise<InvoiceRow> {
  const to = patch.status ?? invoice.status;
  if (to !== invoice.status) assertInvoiceTransition(invoice.status, to, options);
  const [updated] = await tx
    .update(schema.invoice)
    .set({ ...patch, version: invoice.version + 1, updatedAt: options.now })
    .where(
      and(
        eq(schema.invoice.id, invoice.id),
        eq(schema.invoice.status, invoice.status),
        eq(schema.invoice.version, invoice.version),
      ),
    )
    .returning();
  if (updated === undefined) throw new DomainError("CONFLICT", "Invoice was changed concurrently");
  if (to !== invoice.status) {
    await tx.insert(schema.invoiceStatusTransition).values({
      invoiceId: invoice.id,
      fromStatus: invoice.status,
      toStatus: to,
      actorUserId: options.actorUserId,
      reason: options.reason,
    });
    await recordAudit(tx, {
      actor: options.actor,
      action: to === "OVERDUE" ? "invoice.overdue" : "invoice.status_changed",
      entityType: "invoice",
      entityId: invoice.id,
      before: { status: invoice.status },
      after: { status: to },
      correlationId: options.correlationId,
    });
  }
  return updated;
}

export async function applyPaymentChange(
  tx: Transaction,
  payment: PaymentRow,
  to: PaymentRecordStatus,
  patch: Partial<typeof schema.payment.$inferInsert>,
  options: ChangeOptions & { readonly providerEventId?: string | null },
): Promise<PaymentRow> {
  assertPaymentRecordTransition(payment.status, to, options);
  const [updated] = await tx
    .update(schema.payment)
    .set({ ...patch, status: to, version: payment.version + 1, updatedAt: options.now })
    .where(
      and(
        eq(schema.payment.id, payment.id),
        eq(schema.payment.status, payment.status),
        eq(schema.payment.version, payment.version),
      ),
    )
    .returning();
  if (updated === undefined) throw new DomainError("CONFLICT", "Payment was changed concurrently");
  await tx.insert(schema.paymentTransition).values({
    paymentId: payment.id,
    fromStatus: payment.status,
    toStatus: to,
    actorUserId: options.actorUserId,
    providerEventId: options.providerEventId ?? null,
    reason: options.reason,
  });
  const action: Partial<Record<PaymentRecordStatus, string>> = {
    CONFIRMED: payment.status === "REFUND_PENDING" ? "payment.refund_aborted" : "payment.confirmed",
    FAILED: "payment.failed",
    REFUND_PENDING: "payment.refund_requested",
    REFUNDED: "payment.refunded",
    CHARGED_BACK: "payment.charged_back",
    AUTHORIZED: "payment.authorized",
  };
  await recordAudit(tx, {
    actor: options.actor,
    action: action[to] ?? "payment.status_changed",
    entityType: "payment",
    entityId: payment.id,
    before: { status: payment.status },
    after: {
      status: to,
      invoiceId: payment.invoiceId,
      appliedCents: updated.appliedCents,
      source:
        options.providerEventId === undefined || options.providerEventId === null
          ? "MANUAL"
          : "PROVIDER",
    },
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

/** PostgreSQL constraint name of a (possibly wrapped) driver error. */
export function pgConstraint(error: unknown): string | undefined {
  const cause = (error as { cause?: { constraint?: unknown } } | undefined)?.cause;
  const constraint =
    cause?.constraint ?? (error as { constraint?: unknown } | undefined)?.constraint;
  return typeof constraint === "string" ? constraint : undefined;
}
