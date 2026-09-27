import type { Permission } from "@isela/auth";
import { DomainError } from "@isela/shared";

/*
 * Quote lifecycle. Status is never written directly: every change goes through
 * `assertQuoteTransition` and is recorded append-only (quote_status_transition). A quote is
 * only ever released to a customer by a person holding `quote:approve` – there is no
 * automatic price commitment.
 */

export const QUOTE_STATUSES = [
  "DRAFT",
  "PENDING_REVIEW",
  "SENT",
  "ACCEPTED",
  "DECLINED",
  "EXPIRED",
  "CANCELLED",
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_TRANSITIONS: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> = {
  DRAFT: ["PENDING_REVIEW", "CANCELLED"],
  PENDING_REVIEW: ["DRAFT", "SENT", "CANCELLED"],
  SENT: ["ACCEPTED", "DECLINED", "EXPIRED", "CANCELLED"],
  ACCEPTED: [],
  DECLINED: [],
  EXPIRED: [],
  CANCELLED: [],
};

/** Statuses a customer may see (drafts and internal reviews stay internal). */
export const CUSTOMER_VISIBLE_QUOTE_STATUSES: readonly QuoteStatus[] = [
  "SENT",
  "ACCEPTED",
  "DECLINED",
  "EXPIRED",
];

/** Statuses in which a quote still needs action. */
export const OPEN_QUOTE_STATUSES: readonly QuoteStatus[] = ["DRAFT", "PENDING_REVIEW", "SENT"];

/** Transitions that must be justified (stored in the append-only transition log). */
const REASON_REQUIRED: ReadonlySet<QuoteStatus> = new Set(["ACCEPTED", "DECLINED", "CANCELLED"]);

export function isQuoteStatus(value: string): value is QuoteStatus {
  return (QUOTE_STATUSES as readonly string[]).includes(value);
}

/** Permission needed for a transition; releasing to the customer needs approval rights. */
export function permissionForQuoteTransition(to: QuoteStatus): Permission {
  return to === "SENT" ? "quote:approve" : "quote:write";
}

export interface QuoteTransitionContext {
  readonly itemCount: number;
  /** ISO date (YYYY-MM-DD) the quote is valid until, after defaults were applied. */
  readonly validUntil: string | null;
  /** Today's date (YYYY-MM-DD, business time zone). */
  readonly today: string;
  readonly reason: string | null;
  /** Automated transitions (scheduler) – only expiry is allowed. */
  readonly performedBySystem: boolean;
  /** Whether the acting user created the quote (four-eyes check). */
  readonly actorIsCreator: boolean;
  readonly requireFourEyesApproval: boolean;
}

export function assertQuoteTransition(
  from: QuoteStatus,
  to: QuoteStatus,
  context: QuoteTransitionContext,
): void {
  if (!QUOTE_TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Quote status transition not allowed", {
      from,
      to,
    });
  }
  if (context.performedBySystem && to !== "EXPIRED") {
    throw new DomainError("POLICY_VIOLATION", "Only expiry may be performed automatically");
  }
  if ((to === "PENDING_REVIEW" || to === "SENT") && context.itemCount === 0) {
    throw new DomainError("POLICY_VIOLATION", "A quote without items cannot be reviewed or sent");
  }
  if (to === "SENT") {
    if (context.validUntil === null || context.validUntil < context.today) {
      throw new DomainError("POLICY_VIOLATION", "Validity date must not be in the past");
    }
    if (context.requireFourEyesApproval && context.actorIsCreator) {
      throw new DomainError("POLICY_VIOLATION", "The quote must be approved by another person");
    }
  }
  if (to === "ACCEPTED" && (context.validUntil === null || context.validUntil < context.today)) {
    throw new DomainError("POLICY_VIOLATION", "An expired quote cannot be accepted");
  }
  if (to === "EXPIRED" && (context.validUntil === null || context.validUntil >= context.today)) {
    throw new DomainError("POLICY_VIOLATION", "The quote is still valid");
  }
  if (REASON_REQUIRED.has(to) && (context.reason === null || context.reason.trim() === "")) {
    throw new DomainError("VALIDATION_FAILED", "A reason is required for this transition");
  }
}
