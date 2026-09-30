import { addDays } from "@isela/quotes";
import { DomainError } from "@isela/shared";

/*
 * Invoice and payment lifecycles as pure transition tables. No service writes a status column
 * without passing through these functions; the database repeats both tables in triggers
 * (migration 0007), so even a direct UPDATE cannot skip a state.
 *
 * Invoice:
 *   DRAFT ──issue──▶ ISSUED ──release──▶ OPEN ──payments/due date──▶ PARTIALLY_PAID / PAID / OVERDUE
 *   DRAFT ──▶ CANCELLED (no number used)        ISSUED/OPEN/… ──▶ VOID (number kept, never reused)
 * The payment-driven statuses (OPEN, PARTIALLY_PAID, PAID, OVERDUE) are always DERIVED from
 * amounts and dates by `deriveInvoiceStatus` – never chosen by a user.
 */

export const INVOICE_STATUSES = [
  "DRAFT",
  "ISSUED",
  "OPEN",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
  "VOID",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_KINDS = ["PREPAYMENT", "FINAL"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  DRAFT: ["ISSUED", "CANCELLED"],
  ISSUED: ["OPEN", "VOID"],
  OPEN: ["PARTIALLY_PAID", "PAID", "OVERDUE", "VOID"],
  PARTIALLY_PAID: ["OPEN", "PAID", "OVERDUE", "VOID"],
  OVERDUE: ["OPEN", "PARTIALLY_PAID", "PAID", "VOID"],
  PAID: ["OPEN", "PARTIALLY_PAID", "OVERDUE", "VOID"],
  CANCELLED: [],
  VOID: [],
};

/** Statuses in which payments can be recorded against the invoice. */
export const PAYABLE_INVOICE_STATUSES: readonly InvoiceStatus[] = [
  "OPEN",
  "PARTIALLY_PAID",
  "OVERDUE",
];

/** Statuses visible to the customer (issued documents only – never drafts). */
export const CUSTOMER_VISIBLE_INVOICE_STATUSES: readonly InvoiceStatus[] = [
  "OPEN",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "VOID",
];

export function assertInvoiceTransition(
  from: InvoiceStatus,
  to: InvoiceStatus,
  context: { readonly reason: string | null },
): void {
  if (!INVOICE_TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Invoice status transition not allowed", {
      from,
      to,
    });
  }
  if ((to === "VOID" || to === "CANCELLED") && (context.reason ?? "").trim() === "") {
    throw new DomainError("VALIDATION_FAILED", "A reason is required for this transition");
  }
}

/**
 * Payment-driven status of an issued, released invoice:
 * - PAID            paid == gross
 * - OVERDUE         outstanding > 0 and today > due date + grace days
 * - PARTIALLY_PAID  0 < paid < gross (not overdue)
 * - OPEN            nothing paid (not overdue)
 * Partial payments never make an invoice PAID (policy `partialPaymentCountsAsPaid` = false).
 */
export function deriveInvoiceStatus(input: {
  readonly status: InvoiceStatus;
  readonly grossCents: number;
  readonly paidCents: number;
  readonly dueDate: string | null;
  readonly today: string;
  readonly graceDays: number;
}): InvoiceStatus {
  if (!PAYABLE_INVOICE_STATUSES.includes(input.status) && input.status !== "PAID") {
    return input.status;
  }
  if (input.paidCents >= input.grossCents) return "PAID";
  if (input.dueDate !== null && input.today > addDays(input.dueDate, input.graceDays)) {
    return "OVERDUE";
  }
  return input.paidCents > 0 ? "PARTIALLY_PAID" : "OPEN";
}

// ------------------------------------------------------------------------------------------
// Payment
// ------------------------------------------------------------------------------------------

export const PAYMENT_RECORD_STATUSES = [
  "PENDING",
  "AUTHORIZED",
  "CONFIRMED",
  "FAILED",
  "REFUND_PENDING",
  "REFUNDED",
  "CHARGED_BACK",
] as const;
export type PaymentRecordStatus = (typeof PAYMENT_RECORD_STATUSES)[number];

export const PAYMENT_METHODS = ["BANK_TRANSFER", "SEPA_DIRECT_DEBIT", "CARD"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_RECORD_TRANSITIONS: Readonly<
  Record<PaymentRecordStatus, readonly PaymentRecordStatus[]>
> = {
  PENDING: ["AUTHORIZED", "CONFIRMED", "FAILED"],
  AUTHORIZED: ["CONFIRMED", "FAILED"],
  CONFIRMED: ["REFUND_PENDING", "CHARGED_BACK"],
  REFUND_PENDING: ["REFUNDED", "CONFIRMED"],
  FAILED: [],
  REFUNDED: [],
  CHARGED_BACK: [],
};

export function assertPaymentRecordTransition(
  from: PaymentRecordStatus,
  to: PaymentRecordStatus,
  context: { readonly reason: string | null },
): void {
  if (!PAYMENT_RECORD_TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Payment status transition not allowed", {
      from,
      to,
    });
  }
  const needsReason: readonly PaymentRecordStatus[] = [
    "FAILED",
    "REFUND_PENDING",
    "REFUNDED",
    "CHARGED_BACK",
  ];
  if (needsReason.includes(to) && (context.reason ?? "").trim() === "") {
    throw new DomainError("VALIDATION_FAILED", "A reason is required for this transition");
  }
}

/** Payment statuses whose applied amount counts towards the invoice. */
export const APPLIED_PAYMENT_STATUSES: readonly PaymentRecordStatus[] = [
  "CONFIRMED",
  "REFUND_PENDING",
];
