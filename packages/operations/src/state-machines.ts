import { DomainError } from "@isela/shared";
import type { PaymentTermsDecision } from "@isela/payment-risk";

/*
 * Booking, payment and job lifecycles as pure transition tables plus guards. No service
 * writes a status column without passing through these functions; every transition is logged
 * append-only and audited by the calling service. The database repeats the critical guards
 * (prepayment before confirmation/start, no overlapping employee assignments).
 */

// ------------------------------------------------------------------------------------------
// Booking
// ------------------------------------------------------------------------------------------

export const BOOKING_STATUSES = [
  "REQUESTED",
  "PENDING_PAYMENT",
  "CONFIRMED",
  "SCHEDULED",
  "CANCELLED",
  "COMPLETED",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  REQUESTED: ["PENDING_PAYMENT", "CONFIRMED", "CANCELLED"],
  PENDING_PAYMENT: ["CONFIRMED", "CANCELLED"],
  // → PENDING_PAYMENT: payment protection (overdue invoice, revoked credit terms) – day 6.
  CONFIRMED: ["SCHEDULED", "COMPLETED", "CANCELLED", "PENDING_PAYMENT"],
  SCHEDULED: ["CONFIRMED", "COMPLETED", "CANCELLED", "PENDING_PAYMENT"],
  CANCELLED: [],
  COMPLETED: [],
};

export const PAYMENT_REQUIREMENTS = ["VORKASSE_REQUIRED", "CREDIT_TERMS_APPROVED"] as const;
export type PaymentRequirement = (typeof PAYMENT_REQUIREMENTS)[number];

export const PAYMENT_STATUSES = [
  "PAYMENT_REQUIRED",
  "PAYMENT_PENDING",
  "PAYMENT_CONFIRMED",
  "PAYMENT_FAILED",
  "REFUND_PENDING",
  "REFUNDED",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Payment-risk integration: only an explicit INVOICE decision of the payment-risk engine is a
 * credit term. Everything else – new customers, missing history, pending duplicate review,
 * blocked customers, manual approval still required – means prepayment (VORKASSE_REQUIRED).
 */
export function paymentRequirementFor(decision: PaymentTermsDecision): PaymentRequirement {
  return decision.terms === "INVOICE" ? "CREDIT_TERMS_APPROVED" : "VORKASSE_REQUIRED";
}

/** Whether the booking's payment situation allows confirmation and job execution. */
export function isPaymentSatisfied(
  requirement: PaymentRequirement,
  paymentStatus: PaymentStatus | null,
): boolean {
  return requirement === "CREDIT_TERMS_APPROVED" || paymentStatus === "PAYMENT_CONFIRMED";
}

export interface BookingTransitionContext {
  readonly paymentRequirement: PaymentRequirement;
  readonly paymentStatus: PaymentStatus | null;
  /** Status of the booking's job (null = no job yet). */
  readonly jobStatus: JobStatus | null;
  readonly reason: string | null;
}

export function assertBookingTransition(
  from: BookingStatus,
  to: BookingStatus,
  context: BookingTransitionContext,
): void {
  if (!BOOKING_TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Booking status transition not allowed", {
      from,
      to,
    });
  }
  const paid = isPaymentSatisfied(context.paymentRequirement, context.paymentStatus);
  switch (to) {
    case "PENDING_PAYMENT":
      if (context.paymentRequirement !== "VORKASSE_REQUIRED") {
        throw new DomainError("POLICY_VIOLATION", "No prepayment required for this booking");
      }
      // Back from CONFIRMED/SCHEDULED only when the payment protection took the credit away.
      if (from !== "REQUESTED") {
        if (context.reason === null || context.reason.trim() === "") {
          throw new DomainError("VALIDATION_FAILED", "A reason is required for this transition");
        }
        if (paid) {
          throw new DomainError("POLICY_VIOLATION", "The booking is already paid");
        }
        if (context.jobStatus !== null && !JOB_CANCELLABLE.includes(context.jobStatus)) {
          throw new DomainError("POLICY_VIOLATION", "The job has already started");
        }
      }
      break;
    case "CONFIRMED":
      if (!paid) {
        throw new DomainError("POLICY_VIOLATION", "Prepayment has not been confirmed");
      }
      if (from === "SCHEDULED" && context.jobStatus === "ASSIGNED") {
        throw new DomainError("POLICY_VIOLATION", "The job is still assigned");
      }
      break;
    case "SCHEDULED":
      if (!paid || context.jobStatus !== "ASSIGNED") {
        throw new DomainError("POLICY_VIOLATION", "Booking needs payment and an assigned job");
      }
      break;
    case "COMPLETED":
      if (context.jobStatus !== "COMPLETED") {
        throw new DomainError("POLICY_VIOLATION", "The job has not been completed");
      }
      break;
    case "CANCELLED":
      if (context.reason === null || context.reason.trim() === "") {
        throw new DomainError("VALIDATION_FAILED", "A reason is required for this transition");
      }
      if (context.jobStatus !== null && !JOB_CANCELLABLE.includes(context.jobStatus)) {
        throw new DomainError("POLICY_VIOLATION", "The job has already started");
      }
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------------------------------
// Payment
// ------------------------------------------------------------------------------------------

export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  PAYMENT_REQUIRED: ["PAYMENT_PENDING"],
  PAYMENT_PENDING: ["PAYMENT_CONFIRMED", "PAYMENT_FAILED"],
  PAYMENT_FAILED: ["PAYMENT_PENDING"],
  PAYMENT_CONFIRMED: ["REFUND_PENDING"],
  REFUND_PENDING: ["REFUNDED", "PAYMENT_CONFIRMED"],
  REFUNDED: [],
};

export interface PaymentTransitionContext {
  readonly bookingStatus: BookingStatus;
  /** Payment reference (e.g. bank statement reference) – required to confirm. */
  readonly reference: string | null;
}

export function assertPaymentTransition(
  from: PaymentStatus,
  to: PaymentStatus,
  context: PaymentTransitionContext,
): void {
  if (!PAYMENT_TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Payment status transition not allowed", {
      from,
      to,
    });
  }
  const hasReference = context.reference !== null && context.reference.trim() !== "";
  if (
    (to === "PAYMENT_CONFIRMED" || to === "REFUNDED" || to === "PAYMENT_FAILED") &&
    !hasReference
  ) {
    throw new DomainError("VALIDATION_FAILED", "A payment reference is required");
  }
  if (to === "PAYMENT_PENDING" && context.bookingStatus === "CANCELLED") {
    throw new DomainError("POLICY_VIOLATION", "The booking has been cancelled");
  }
  // A refund is only possible once the booking will not be carried out (anymore).
  if (
    to === "REFUND_PENDING" &&
    context.bookingStatus !== "CANCELLED" &&
    context.bookingStatus !== "COMPLETED"
  ) {
    throw new DomainError("POLICY_VIOLATION", "Cancel the booking before refunding");
  }
  // REFUND_PENDING → PAYMENT_CONFIRMED aborts a refund; the booking status is unaffected.
}

// ------------------------------------------------------------------------------------------
// Job
// ------------------------------------------------------------------------------------------

export const JOB_STATUSES = [
  "PLANNED",
  "ASSIGNMENT_PENDING",
  "ASSIGNED",
  "IN_PROGRESS",
  "COMPLETED",
  "QUALITY_CHECK",
  "CLOSED",
  "CANCELLED",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  PLANNED: ["ASSIGNMENT_PENDING", "CANCELLED"],
  ASSIGNMENT_PENDING: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "ASSIGNMENT_PENDING", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: ["QUALITY_CHECK"],
  QUALITY_CHECK: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

/** Job statuses in which the booking (and with it the job) can still be cancelled. */
export const JOB_CANCELLABLE: readonly JobStatus[] = [
  "PLANNED",
  "ASSIGNMENT_PENDING",
  "ASSIGNED",
  "CANCELLED",
];

/** Job statuses that block the assigned resource (overlap and capacity checks). */
export const JOB_ACTIVE_STATUSES: readonly JobStatus[] = ["ASSIGNED", "IN_PROGRESS"];

export interface JobTransitionContext {
  readonly hasActiveAssignment: boolean;
  readonly bookingStatus: BookingStatus;
  readonly paymentRequirement: PaymentRequirement;
  readonly paymentStatus: PaymentStatus | null;
  readonly reason: string | null;
}

export function assertJobTransition(
  from: JobStatus,
  to: JobStatus,
  context: JobTransitionContext,
): void {
  if (!JOB_TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Job status transition not allowed", {
      from,
      to,
    });
  }
  switch (to) {
    case "ASSIGNED":
      if (!context.hasActiveAssignment) {
        throw new DomainError("POLICY_VIOLATION", "The job has no active assignment");
      }
      break;
    case "ASSIGNMENT_PENDING":
      if (from === "ASSIGNED" && context.hasActiveAssignment) {
        throw new DomainError("POLICY_VIOLATION", "Release the assignment first");
      }
      break;
    case "IN_PROGRESS":
      if (!context.hasActiveAssignment) {
        throw new DomainError("POLICY_VIOLATION", "The job has no active assignment");
      }
      if (
        (context.bookingStatus !== "CONFIRMED" && context.bookingStatus !== "SCHEDULED") ||
        !isPaymentSatisfied(context.paymentRequirement, context.paymentStatus)
      ) {
        throw new DomainError("POLICY_VIOLATION", "Payment guard: prepayment not confirmed", {
          guard: "PAYMENT",
        });
      }
      break;
    case "CANCELLED":
      if (context.reason === null || context.reason.trim() === "") {
        throw new DomainError("VALIDATION_FAILED", "A reason is required for this transition");
      }
      break;
    default:
      break;
  }
}
