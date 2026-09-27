import type { LeadProviderKind } from "@isela/lead-finder";
import { DomainError } from "@isela/shared";

export const LEAD_STATUSES = [
  "DISCOVERED",
  "RESEARCHING",
  "QUALIFIED",
  "OUTREACH_DRAFTED",
  "CONTACTED",
  "RESPONSE",
  "QUALIFIED_OPPORTUNITY",
  "QUOTE_REQUEST",
  "QUOTE_SENT",
  "NEGOTIATION",
  "WON",
  "LOST",
  "FOLLOW_UP",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Allowed transitions (docs/DOMAIN_MODEL.md §6.4). Anything not listed is rejected. */
export const LEAD_TRANSITIONS: Readonly<Record<LeadStatus, readonly LeadStatus[]>> = {
  DISCOVERED: ["RESEARCHING", "QUALIFIED", "QUOTE_REQUEST", "LOST"],
  RESEARCHING: ["QUALIFIED", "LOST"],
  QUALIFIED: ["OUTREACH_DRAFTED", "QUOTE_REQUEST", "LOST"],
  OUTREACH_DRAFTED: ["CONTACTED", "QUALIFIED", "LOST"],
  CONTACTED: ["RESPONSE", "FOLLOW_UP", "LOST"],
  FOLLOW_UP: ["CONTACTED", "RESPONSE", "LOST"],
  RESPONSE: ["QUALIFIED_OPPORTUNITY", "FOLLOW_UP", "LOST"],
  QUALIFIED_OPPORTUNITY: ["QUOTE_REQUEST", "FOLLOW_UP", "LOST"],
  QUOTE_REQUEST: ["QUOTE_SENT", "LOST"],
  QUOTE_SENT: ["NEGOTIATION", "WON", "LOST", "FOLLOW_UP"],
  NEGOTIATION: ["QUOTE_SENT", "WON", "LOST"],
  LOST: ["FOLLOW_UP"],
  WON: [],
};

export interface LeadTransitionContext {
  readonly sourceKind: LeadProviderKind;
  /** At least one contact of the lead that is not suppressed. */
  readonly hasContactableContact: boolean;
  /** Whether a human user performs the transition (automations never contact leads). */
  readonly performedByHuman: boolean;
  readonly reason: string | null;
}

export function isLeadStatus(value: string): value is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(value);
}

/** Validates a status change including business guards; throws a DomainError otherwise. */
export function assertLeadTransition(
  from: LeadStatus,
  to: LeadStatus,
  context: LeadTransitionContext,
): void {
  if (!LEAD_TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Lead status transition not allowed", {
      from,
      to,
    });
  }
  if (
    from === "DISCOVERED" &&
    to === "QUOTE_REQUEST" &&
    context.sourceKind !== "INTERNAL_INBOUND"
  ) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "Only inbound leads can move directly to QUOTE_REQUEST",
      { from, to },
    );
  }
  if (to === "CONTACTED") {
    if (!context.performedByHuman) {
      throw new DomainError("POLICY_VIOLATION", "Contacting a lead requires a human decision");
    }
    if (!context.hasContactableContact) {
      throw new DomainError("POLICY_VIOLATION", "Lead has no contact that may be contacted");
    }
  }
  const reasonRequired = to === "LOST" || from === "LOST";
  if (reasonRequired && (context.reason === null || context.reason.trim().length < 3)) {
    throw new DomainError("VALIDATION_FAILED", "A reason is required for this transition", {
      from,
      to,
    });
  }
}
