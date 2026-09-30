import { describe, expect, it } from "vitest";
import {
  BOOKING_STATUSES,
  BOOKING_TRANSITIONS,
  DEFAULT_OPERATIONS_CONFIG,
  JOB_STATUSES,
  JOB_TRANSITIONS,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  assertBookingTransition,
  assertJobTransition,
  assertPaymentTransition,
  evaluateCandidate,
  isPaymentSatisfied,
  localInterval,
  localTime,
  operationsConfigSchema,
  paymentRequirementFor,
  rankCandidates,
  scoreFactors,
  type BookingTransitionContext,
  type EmployeeFacts,
  type JobRequirements,
  type JobTransitionContext,
  type OperationsConfig,
  type PartnerFacts,
} from "@isela/operations";
import {
  DEFAULT_PAYMENT_POLICY,
  evaluatePaymentTerms,
  historyWithoutOrders,
} from "@isela/payment-risk";
import { ROLE_PERMISSIONS } from "@isela/auth";
import { expectDomainErrorSync } from "../support/assertions.ts";

function bookingCtx(overrides: Partial<BookingTransitionContext> = {}): BookingTransitionContext {
  return {
    paymentRequirement: "VORKASSE_REQUIRED",
    paymentStatus: "PAYMENT_CONFIRMED",
    jobStatus: "ASSIGNED",
    reason: "Test",
    ...overrides,
  };
}

function jobCtx(overrides: Partial<JobTransitionContext> = {}): JobTransitionContext {
  return {
    hasActiveAssignment: true,
    bookingStatus: "SCHEDULED",
    paymentRequirement: "VORKASSE_REQUIRED",
    paymentStatus: "PAYMENT_CONFIRMED",
    reason: "Test",
    ...overrides,
  };
}

function forbiddenPairs<S extends string>(
  statuses: readonly S[],
  transitions: Readonly<Record<S, readonly S[]>>,
): (readonly [S, S])[] {
  return statuses.flatMap((from) =>
    statuses
      .filter((to) => to !== from && !transitions[from].includes(to))
      .map((to) => [from, to] as const),
  );
}

describe("booking state machine", () => {
  it.each(forbiddenPairs(BOOKING_STATUSES, BOOKING_TRANSITIONS))("rejects %s → %s", (from, to) => {
    expectDomainErrorSync(() => {
      assertBookingTransition(from, to, bookingCtx());
    }, "INVALID_STATE_TRANSITION");
  });

  it("has terminal CANCELLED and COMPLETED states", () => {
    expect(BOOKING_TRANSITIONS.CANCELLED).toEqual([]);
    expect(BOOKING_TRANSITIONS.COMPLETED).toEqual([]);
  });

  it("waits for payment only when prepayment is required", () => {
    expect(() => {
      assertBookingTransition(
        "REQUESTED",
        "PENDING_PAYMENT",
        bookingCtx({ paymentStatus: "PAYMENT_REQUIRED" }),
      );
    }).not.toThrow();
    expectDomainErrorSync(() => {
      assertBookingTransition(
        "REQUESTED",
        "PENDING_PAYMENT",
        bookingCtx({ paymentRequirement: "CREDIT_TERMS_APPROVED", paymentStatus: null }),
      );
    }, "POLICY_VIOLATION");
  });

  it("confirms a prepayment booking only after the payment is confirmed", () => {
    for (const paymentStatus of [
      "PAYMENT_REQUIRED",
      "PAYMENT_PENDING",
      "PAYMENT_FAILED",
    ] as const) {
      expectDomainErrorSync(() => {
        assertBookingTransition("PENDING_PAYMENT", "CONFIRMED", bookingCtx({ paymentStatus }));
      }, "POLICY_VIOLATION");
    }
    expect(() => {
      assertBookingTransition("PENDING_PAYMENT", "CONFIRMED", bookingCtx({ jobStatus: null }));
    }).not.toThrow();
    expect(() => {
      assertBookingTransition(
        "REQUESTED",
        "CONFIRMED",
        bookingCtx({ paymentRequirement: "CREDIT_TERMS_APPROVED", paymentStatus: null }),
      );
    }).not.toThrow();
  });

  it("schedules only with an assigned job and completes only a completed job", () => {
    expectDomainErrorSync(() => {
      assertBookingTransition(
        "CONFIRMED",
        "SCHEDULED",
        bookingCtx({ jobStatus: "ASSIGNMENT_PENDING" }),
      );
    }, "POLICY_VIOLATION");
    expectDomainErrorSync(() => {
      assertBookingTransition("SCHEDULED", "COMPLETED", bookingCtx({ jobStatus: "IN_PROGRESS" }));
    }, "POLICY_VIOLATION");
    expect(() => {
      assertBookingTransition("SCHEDULED", "COMPLETED", bookingCtx({ jobStatus: "COMPLETED" }));
    }).not.toThrow();
  });

  it("cancels only with a reason and before the job started", () => {
    expectDomainErrorSync(() => {
      assertBookingTransition("CONFIRMED", "CANCELLED", bookingCtx({ reason: " " }));
    }, "VALIDATION_FAILED");
    expectDomainErrorSync(() => {
      assertBookingTransition("SCHEDULED", "CANCELLED", bookingCtx({ jobStatus: "IN_PROGRESS" }));
    }, "POLICY_VIOLATION");
    expect(() => {
      assertBookingTransition("SCHEDULED", "CANCELLED", bookingCtx({ jobStatus: "ASSIGNED" }));
    }).not.toThrow();
  });
});

describe("payment state machine", () => {
  it.each(forbiddenPairs(PAYMENT_STATUSES, PAYMENT_TRANSITIONS))("rejects %s → %s", (from, to) => {
    expectDomainErrorSync(() => {
      assertPaymentTransition(from, to, { bookingStatus: "CANCELLED", reference: "REF-1" });
    }, "INVALID_STATE_TRANSITION");
  });

  it("never confirms a payment without a reference (no silent success)", () => {
    expectDomainErrorSync(() => {
      assertPaymentTransition("PAYMENT_PENDING", "PAYMENT_CONFIRMED", {
        bookingStatus: "PENDING_PAYMENT",
        reference: null,
      });
    }, "VALIDATION_FAILED");
    expectDomainErrorSync(() => {
      assertPaymentTransition("PAYMENT_REQUIRED", "PAYMENT_CONFIRMED", {
        bookingStatus: "PENDING_PAYMENT",
        reference: "REF-1",
      });
    }, "INVALID_STATE_TRANSITION");
  });

  it("refunds only cancelled or completed bookings", () => {
    expectDomainErrorSync(() => {
      assertPaymentTransition("PAYMENT_CONFIRMED", "REFUND_PENDING", {
        bookingStatus: "SCHEDULED",
        reference: null,
      });
    }, "POLICY_VIOLATION");
    expect(() => {
      assertPaymentTransition("PAYMENT_CONFIRMED", "REFUND_PENDING", {
        bookingStatus: "CANCELLED",
        reference: null,
      });
    }).not.toThrow();
    expectDomainErrorSync(() => {
      assertPaymentTransition("PAYMENT_REQUIRED", "PAYMENT_PENDING", {
        bookingStatus: "CANCELLED",
        reference: null,
      });
    }, "POLICY_VIOLATION");
  });
});

describe("payment requirement (payment-risk integration)", () => {
  it("requires prepayment for customers without approved credit terms", () => {
    const decision = evaluatePaymentTerms(
      historyWithoutOrders({ status: "ACTIVE", duplicateReviewStatus: "NONE", kind: "BUSINESS" }),
      DEFAULT_PAYMENT_POLICY,
    );
    expect(paymentRequirementFor(decision)).toBe("VORKASSE_REQUIRED");
  });

  it("grants credit terms only for an explicit INVOICE decision", () => {
    const base = { creditLimitCents: null, availableCreditCents: null } as const;
    expect(
      paymentRequirementFor({
        ...base,
        outcome: "CREDIT_TERMS_ALLOWED",
        terms: "INVOICE",
        invoiceReviewEligible: true,
        reasons: ["CREDIT_TERMS_APPROVED"],
      }),
    ).toBe("CREDIT_TERMS_APPROVED");
    // Eligible but no approved credit decision yet → still prepayment.
    expect(
      paymentRequirementFor({
        ...base,
        outcome: "VORKASSE_REQUIRED",
        terms: "PREPAYMENT",
        invoiceReviewEligible: true,
        reasons: ["CREDIT_APPROVAL_REQUIRED"],
      }),
    ).toBe("VORKASSE_REQUIRED");
  });

  it("treats only confirmed payments or credit terms as satisfied", () => {
    expect(isPaymentSatisfied("VORKASSE_REQUIRED", "PAYMENT_CONFIRMED")).toBe(true);
    for (const status of [
      "PAYMENT_REQUIRED",
      "PAYMENT_PENDING",
      "PAYMENT_FAILED",
      "REFUND_PENDING",
      "REFUNDED",
    ] as const) {
      expect(isPaymentSatisfied("VORKASSE_REQUIRED", status), status).toBe(false);
    }
    expect(isPaymentSatisfied("CREDIT_TERMS_APPROVED", null)).toBe(true);
  });
});

describe("job state machine", () => {
  it.each(forbiddenPairs(JOB_STATUSES, JOB_TRANSITIONS))("rejects %s → %s", (from, to) => {
    expectDomainErrorSync(() => {
      assertJobTransition(from, to, jobCtx());
    }, "INVALID_STATE_TRANSITION");
  });

  it("follows the lifecycle without skipping steps", () => {
    expect(JOB_TRANSITIONS.PLANNED).not.toContain("ASSIGNED");
    expect(JOB_TRANSITIONS.ASSIGNED).not.toContain("COMPLETED");
    expect(JOB_TRANSITIONS.IN_PROGRESS).toEqual(["COMPLETED"]);
    expect(JOB_TRANSITIONS.COMPLETED).toEqual(["QUALITY_CHECK"]);
    expect(JOB_TRANSITIONS.QUALITY_CHECK).toEqual(["CLOSED"]);
    expect(JOB_TRANSITIONS.CLOSED).toEqual([]);
  });

  it("assigns only with an active assignment", () => {
    expectDomainErrorSync(() => {
      assertJobTransition("ASSIGNMENT_PENDING", "ASSIGNED", jobCtx({ hasActiveAssignment: false }));
    }, "POLICY_VIOLATION");
  });

  it("blocks the start while prepayment is not confirmed (payment guard)", () => {
    for (const paymentStatus of [
      "PAYMENT_REQUIRED",
      "PAYMENT_PENDING",
      "PAYMENT_FAILED",
    ] as const) {
      expectDomainErrorSync(() => {
        assertJobTransition(
          "ASSIGNED",
          "IN_PROGRESS",
          jobCtx({ bookingStatus: "PENDING_PAYMENT", paymentStatus }),
        );
      }, "POLICY_VIOLATION");
    }
    expectDomainErrorSync(() => {
      assertJobTransition("ASSIGNED", "IN_PROGRESS", jobCtx({ bookingStatus: "CANCELLED" }));
    }, "POLICY_VIOLATION");
    expect(() => {
      assertJobTransition("ASSIGNED", "IN_PROGRESS", jobCtx());
    }).not.toThrow();
    expect(() => {
      assertJobTransition(
        "ASSIGNED",
        "IN_PROGRESS",
        jobCtx({
          paymentRequirement: "CREDIT_TERMS_APPROVED",
          paymentStatus: null,
          bookingStatus: "CONFIRMED",
        }),
      );
    }).not.toThrow();
  });

  it("requires a released assignment before returning to assignment", () => {
    expectDomainErrorSync(() => {
      assertJobTransition("ASSIGNED", "ASSIGNMENT_PENDING", jobCtx());
    }, "POLICY_VIOLATION");
  });
});

// ------------------------------------------------------------------------------------------
// Assignment scoring
// ------------------------------------------------------------------------------------------

const AREA = "33333333-3333-4333-8333-333333333333";
const SERVICE = "44444444-4444-4444-8444-444444444444";
const ENABLED: OperationsConfig = { ...DEFAULT_OPERATIONS_CONFIG, partnerAssignmentEnabled: true };

const JOB: JobRequirements = {
  requiredQualifications: ["glass"],
  serviceIds: [SERVICE],
  serviceAreaId: AREA,
  local: { weekday: 2, startMinute: 540, endMinute: 720 },
  date: "2026-10-06",
};

function employee(overrides: Partial<EmployeeFacts> = {}): EmployeeFacts {
  return {
    kind: "EMPLOYEE",
    id: "55555555-5555-4555-8555-555555555555",
    name: "Mitarbeiterin Test",
    active: true,
    qualifications: ["glass", "floor"],
    serviceAreaIds: [AREA],
    workingWindows: [{ startMinute: 480, endMinute: 960 }],
    unavailable: false,
    overlappingAssignments: 0,
    jobsThatDay: 1,
    maxJobsPerDay: 4,
    distanceM: 6000,
    ...overrides,
  };
}

function partner(overrides: Partial<PartnerFacts> = {}): PartnerFacts {
  return {
    kind: "PARTNER",
    id: "66666666-6666-4666-8666-666666666666",
    name: "Partner Test",
    active: true,
    verified: true,
    offeredServiceIds: [SERVICE],
    coversAddress: true,
    validDocumentKinds: ["TRADE_REGISTRATION", "LIABILITY_INSURANCE"],
    overlappingAssignments: 0,
    maxConcurrentJobs: 2,
    distanceM: 12_000,
    ...overrides,
  };
}

describe("assignment candidates", () => {
  it("scores an eligible employee with explainable factors", () => {
    const candidate = evaluateCandidate(employee(), JOB, DEFAULT_OPERATIONS_CONFIG);
    expect(candidate).toMatchObject({
      eligible: true,
      blockers: [],
      qualificationMatch: true,
      availability: true,
      serviceMatch: true,
      serviceAreaMatch: true,
      capacity: { used: 1, max: 4 },
    });
    // Weights 30/20/20/10/10 (reliability: no data → excluded) over 90 points.
    // distance 1 − 6/30 = 0.8 → 26.67, qual 22.22, avail 22.22, service 11.11, capacity 0.75 → 8.33
    expect(candidate.score).toBe(91);
    const reliability = candidate.factors.find((f) => f.key === "reliability");
    expect(reliability).toMatchObject({ value: null, contribution: 0 });
    const sum = candidate.factors.reduce((s, f) => s + f.contribution, 0);
    expect(Math.round(sum)).toBe(candidate.score);
  });

  it.each([
    [{ active: false }, "INACTIVE"],
    [{ qualifications: ["floor"] }, "MISSING_QUALIFICATION"],
    [{ serviceAreaIds: [] }, "OUTSIDE_SERVICE_AREA"],
    [{ workingWindows: [{ startMinute: 600, endMinute: 960 }] }, "OUTSIDE_WORKING_HOURS"],
    [{ unavailable: true }, "UNAVAILABLE"],
    [{ overlappingAssignments: 1 }, "TIME_CONFLICT"],
    [{ jobsThatDay: 4 }, "CAPACITY_EXHAUSTED"],
  ] as const)("blocks an employee with %o (%s)", (overrides, blocker) => {
    const candidate = evaluateCandidate(employee(overrides), JOB, DEFAULT_OPERATIONS_CONFIG);
    expect(candidate.eligible).toBe(false);
    expect(candidate.blockers).toContain(blocker);
    expect(candidate.score).toBeNull();
  });

  it("blocks every employee when the address has no service area (fail closed)", () => {
    const candidate = evaluateCandidate(
      employee(),
      { ...JOB, serviceAreaId: null },
      DEFAULT_OPERATIONS_CONFIG,
    );
    expect(candidate.blockers).toContain("SERVICE_AREA_UNKNOWN");
  });

  it("never proposes partners while partner assignment is disabled (owner rule)", () => {
    expect(DEFAULT_OPERATIONS_CONFIG.partnerAssignmentEnabled).toBe(false);
    const candidate = evaluateCandidate(partner(), JOB, DEFAULT_OPERATIONS_CONFIG);
    expect(candidate.eligible).toBe(false);
    expect(candidate.blockers).toContain("PARTNER_ASSIGNMENT_DISABLED");
  });

  it("scores a verified, active partner once enabled", () => {
    const candidate = evaluateCandidate(partner(), JOB, ENABLED);
    expect(candidate.eligible).toBe(true);
    expect(candidate.score).toBeGreaterThan(0);
  });

  it.each([
    [{ verified: false }, "NOT_VERIFIED"],
    [{ active: false }, "INACTIVE"],
    [{ validDocumentKinds: ["TRADE_REGISTRATION"] }, "DOCUMENTS_MISSING"],
    [{ offeredServiceIds: [] }, "SERVICE_NOT_OFFERED"],
    [{ coversAddress: false }, "OUTSIDE_SERVICE_AREA"],
    [{ maxConcurrentJobs: null }, "CAPACITY_NOT_CONFIGURED"],
    [{ overlappingAssignments: 2 }, "CAPACITY_EXHAUSTED"],
  ] as const)("blocks a partner with %o (%s)", (overrides, blocker) => {
    const candidate = evaluateCandidate(partner(overrides), JOB, ENABLED);
    expect(candidate.eligible).toBe(false);
    expect(candidate.blockers).toContain(blocker);
  });

  it("blocks partners for items without a catalogue service", () => {
    const candidate = evaluateCandidate(
      partner(),
      { ...JOB, serviceIds: [SERVICE, null] },
      ENABLED,
    );
    expect(candidate.blockers).toContain("SERVICE_UNKNOWN");
  });

  it("ranks eligible candidates by score, then distance", () => {
    const near = evaluateCandidate(
      employee({ id: "a", name: "A", distanceM: 1000 }),
      JOB,
      DEFAULT_OPERATIONS_CONFIG,
    );
    const far = evaluateCandidate(
      employee({ id: "b", name: "B", distanceM: 25_000 }),
      JOB,
      DEFAULT_OPERATIONS_CONFIG,
    );
    const blocked = evaluateCandidate(
      employee({ id: "c", name: "C", unavailable: true }),
      JOB,
      DEFAULT_OPERATIONS_CONFIG,
    );
    expect(rankCandidates([blocked, far, near]).map((c) => c.name)).toEqual(["A", "B", "C"]);
  });

  it("normalises the score over the factors that have data", () => {
    const { score } = scoreFactors(
      {
        distance: null,
        qualification: 1,
        availability: 1,
        serviceMatch: 1,
        capacity: null,
        reliability: null,
      },
      DEFAULT_OPERATIONS_CONFIG.scoringWeights,
    );
    expect(score).toBe(100);
  });

  it("rejects scoring weights that do not add up to 100", () => {
    const invalid = {
      ...DEFAULT_OPERATIONS_CONFIG,
      scoringWeights: { ...DEFAULT_OPERATIONS_CONFIG.scoringWeights, distance: 90 },
    };
    expect(operationsConfigSchema.safeParse(invalid).success).toBe(false);
    expect(operationsConfigSchema.safeParse(DEFAULT_OPERATIONS_CONFIG).success).toBe(true);
  });
});

describe("business-local time", () => {
  it("resolves weekday and minute in the configured time zone (incl. DST)", () => {
    // 2026-10-06 07:30Z = Tuesday 09:30 CEST
    expect(localTime(new Date("2026-10-06T07:30:00Z"), "Europe/Berlin")).toEqual({
      date: "2026-10-06",
      weekday: 2,
      minuteOfDay: 570,
    });
    // 2026-12-01 08:30Z = Tuesday 09:30 CET
    expect(localTime(new Date("2026-12-01T08:30:00Z"), "Europe/Berlin").minuteOfDay).toBe(570);
  });

  it("supports intervals ending at midnight and rejects multi-day intervals", () => {
    expect(
      localInterval(
        new Date("2026-10-06T20:00:00Z"),
        new Date("2026-10-06T22:00:00Z"),
        "Europe/Berlin",
      ),
    ).toEqual({ date: "2026-10-06", weekday: 2, startMinute: 1320, endMinute: 1440 });
    expect(
      localInterval(
        new Date("2026-10-06T20:00:00Z"),
        new Date("2026-10-07T01:00:00Z"),
        "Europe/Berlin",
      ),
    ).toBeNull();
  });
});

describe("RBAC for day 5", () => {
  it("limits internal costs and margins to finance-capable roles", () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, grants]) => grants["finance:internal_read"] !== undefined)
      .map(([role]) => role)
      .sort();
    expect(holders).toEqual(["ADMIN", "FINANCE", "SUPER_ADMIN"]);
  });

  it("gives payment changes only to finance and administration", () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, grants]) => grants["payment:manage"] !== undefined)
      .map(([role]) => role)
      .sort();
    expect(holders).toEqual(["ADMIN", "FINANCE", "SUPER_ADMIN"]);
  });

  it("lets STAFF and PARTNER work only on own jobs and CUSTOMER read only own bookings", () => {
    expect(ROLE_PERMISSIONS.STAFF["job:read"]).toBeUndefined();
    expect(ROLE_PERMISSIONS.STAFF["job:execute_own"]).toBe("GLOBAL");
    expect(ROLE_PERMISSIONS.PARTNER["job:execute_own"]).toBe("OWN");
    expect(ROLE_PERMISSIONS.PARTNER["job:read"]).toBeUndefined();
    expect(ROLE_PERMISSIONS.CUSTOMER["booking:read"]).toBe("OWN");
    expect(ROLE_PERMISSIONS.CUSTOMER["booking:write"]).toBeUndefined();
    expect(ROLE_PERMISSIONS.DISPATCHER["job:assign"]).toBe("GLOBAL");
    expect(ROLE_PERMISSIONS.DISPATCHER["payment:manage"]).toBeUndefined();
    expect(ROLE_PERMISSIONS.DISPATCHER["finance:internal_read"]).toBeUndefined();
    expect(ROLE_PERMISSIONS.DISPATCHER["pricing:override"]).toBeUndefined();
  });
});
