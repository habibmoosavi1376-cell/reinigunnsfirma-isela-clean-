import { describe, expect, it } from "vitest";
import {
  LEAD_STATUSES,
  LEAD_TRANSITIONS,
  assertLeadTransition,
  type LeadStatus,
  type LeadTransitionContext,
} from "@isela/crm";
import { expectDomainErrorSync } from "../support/assertions.ts";

const permissive: LeadTransitionContext = {
  sourceKind: "INTERNAL_INBOUND",
  hasContactableContact: true,
  performedByHuman: true,
  reason: "documented reason",
};

describe("lead state machine", () => {
  const allowed: [LeadStatus, LeadStatus][] = LEAD_STATUSES.flatMap((from) =>
    LEAD_TRANSITIONS[from].map((to): [LeadStatus, LeadStatus] => [from, to]),
  );
  const forbidden: [LeadStatus, LeadStatus][] = LEAD_STATUSES.flatMap((from) =>
    LEAD_STATUSES.filter((to) => !LEAD_TRANSITIONS[from].includes(to)).map(
      (to): [LeadStatus, LeadStatus] => [from, to],
    ),
  );

  it.each(allowed)("allows %s → %s when guards are satisfied", (from, to) => {
    expect(() => {
      assertLeadTransition(from, to, permissive);
    }).not.toThrow();
  });

  it.each(forbidden)("rejects %s → %s", (from, to) => {
    expectDomainErrorSync(() => {
      assertLeadTransition(from, to, permissive);
    }, "INVALID_STATE_TRANSITION");
  });

  it("treats WON as a terminal state", () => {
    expect(LEAD_TRANSITIONS.WON).toEqual([]);
  });

  it("requires a human to contact a lead", () => {
    expectDomainErrorSync(() => {
      assertLeadTransition("OUTREACH_DRAFTED", "CONTACTED", {
        ...permissive,
        performedByHuman: false,
      });
    }, "POLICY_VIOLATION");
  });

  it("requires a contact that is not suppressed", () => {
    expectDomainErrorSync(() => {
      assertLeadTransition("OUTREACH_DRAFTED", "CONTACTED", {
        ...permissive,
        hasContactableContact: false,
      });
    }, "POLICY_VIOLATION");
  });

  it("requires a reason for LOST and for reactivation", () => {
    expectDomainErrorSync(() => {
      assertLeadTransition("QUALIFIED", "LOST", { ...permissive, reason: null });
    }, "VALIDATION_FAILED");
    expectDomainErrorSync(() => {
      assertLeadTransition("LOST", "FOLLOW_UP", { ...permissive, reason: " " });
    }, "VALIDATION_FAILED");
  });

  it("only lets inbound leads jump to QUOTE_REQUEST", () => {
    expectDomainErrorSync(() => {
      assertLeadTransition("DISCOVERED", "QUOTE_REQUEST", {
        ...permissive,
        sourceKind: "BUSINESS_SEARCH",
      });
    }, "INVALID_STATE_TRANSITION");
  });
});
