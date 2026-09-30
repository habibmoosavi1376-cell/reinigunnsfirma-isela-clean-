import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema } from "@isela/database";
import {
  DEFAULT_OPERATIONS_CONFIG,
  assignJob,
  cancelBooking,
  createBookingFromQuote,
  createJobForBooking,
  getBooking,
  getEmployee,
  getJob,
  linkEmployeeAccount,
  listAssignmentCandidates,
  listEmployees,
  listOwnJobs,
  reassignJob,
  releaseJobAssignment,
  transitionJob,
  transitionPaymentStatus,
  updateEmployee,
  addUnavailability,
} from "@isela/operations";
import {
  addPartnerDocument,
  createPartner,
  getPartnerDetail,
  listPartners,
  reviewPartnerDocument,
  setPartnerServices,
  verifyAndActivatePartner,
} from "@isela/partners";
import { isDomainError } from "@isela/shared";
import { expectDomainError, expectPgError } from "../support/assertions.ts";
import { contextForRole, openTestDatabase } from "../support/fixtures.ts";
import {
  CapturingLogger,
  PARTNERS_ENABLED,
  PAYMENT_POLICY,
  acceptedQuote,
  activeServiceArea,
  futureSlot,
  geocodedCustomer,
  payPrepayment,
  staffedEmployee,
  testService,
  type StaffCtx,
} from "../support/operations.ts";

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

// Remote test coordinates (test data only), different from the bookings test area.
const CENTER = { latitude: -36.85, longitude: 174.76 };
const NEAR = { latitude: -36.86, longitude: 174.77 };
const CONFIG = DEFAULT_OPERATIONS_CONFIG;
const OPTIONS = { paymentPolicy: PAYMENT_POLICY, config: CONFIG };
const TODAY = new Date().toISOString().slice(0, 10);

let dispatcher: StaffCtx;
let admin: StaffCtx;
let finance: StaffCtx;
let areaId: string;
let ids: { serviceId: string; categoryId: string };
let week = 0;

/** A job waiting for assignment (booking PENDING_PAYMENT). Each call uses a new week. */
async function pendingJob(slotWeek?: number) {
  week += 1;
  const customer = await geocodedCustomer(db, dispatcher, NEAR);
  const quoteId = await acceptedQuote(dispatcher, admin, { ...customer, ...ids });
  const { bookingId } = await createBookingFromQuote(
    dispatcher,
    { quoteId, ...futureSlot(slotWeek ?? week) },
    OPTIONS,
  );
  const { jobId } = await createJobForBooking(dispatcher, { bookingId });
  await transitionJob(dispatcher, { jobId, to: "ASSIGNMENT_PENDING" });
  return { jobId, bookingId, customerId: customer.customerId };
}

/** Since day 6 a prepayment is confirmed only through a fully paid prepayment invoice. */
async function confirmPayment(bookingId: string) {
  await transitionPaymentStatus(finance, { bookingId, to: "PAYMENT_PENDING" });
  await payPrepayment(finance, bookingId);
}

async function verifiedPartner(options: { services?: string[]; capacity?: number | null } = {}) {
  const partnerId = await createPartner(admin, {
    legalName: `Partnerbetrieb ${randomUUID().slice(0, 6)} (Testdaten)`,
    baseLatitude: CENTER.latitude,
    baseLongitude: CENTER.longitude,
    serviceRadiusM: 30_000,
    maxConcurrentJobs: options.capacity === undefined ? 2 : options.capacity,
  });
  for (const kind of ["TRADE_REGISTRATION", "LIABILITY_INSURANCE"] as const) {
    const documentId = await addPartnerDocument(admin, {
      partnerId,
      kind,
      validUntil: "2099-12-31",
    });
    await reviewPartnerDocument(admin, { partnerId, documentId, decision: "VERIFIED" });
  }
  await setPartnerServices(admin, { partnerId, serviceIds: options.services ?? [ids.serviceId] });
  await verifyAndActivatePartner(
    admin,
    { partnerId },
    { requiredDocumentKinds: CONFIG.requiredPartnerDocumentKinds, today: TODAY },
  );
  return partnerId;
}

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  admin = await contextForRole(db, "ADMIN");
  finance = await contextForRole(db, "FINANCE");
  areaId = await activeServiceArea(admin, CENTER);
  ids = await testService(admin, db, { qualifications: ["glass"] });
});

describe("assignment candidates", () => {
  it("lists explainable candidates and keeps partners off by default", async () => {
    const { jobId } = await pendingJob();
    const qualified = await staffedEmployee(admin, {
      serviceAreaId: areaId,
      qualifications: ["glass"],
      base: CENTER,
      name: "Qualifiziert (Test)",
    });
    const unqualified = await staffedEmployee(admin, {
      serviceAreaId: areaId,
      qualifications: [],
      name: "Ohne Qualifikation (Test)",
    });
    await verifiedPartner();
    const candidates = await listAssignmentCandidates(dispatcher, { jobId }, CONFIG);
    const good = candidates.find((c) => c.employeeId === qualified);
    const bad = candidates.find((c) => c.employeeId === unqualified);
    expect(good).toMatchObject({
      eligible: true,
      qualificationMatch: true,
      serviceAreaMatch: true,
    });
    expect(good?.score).toBeGreaterThan(0);
    expect(good?.factors.map((f) => f.key)).toEqual([
      "distance",
      "qualification",
      "availability",
      "serviceMatch",
      "capacity",
      "reliability",
    ]);
    expect(bad).toMatchObject({ eligible: false, blockers: ["MISSING_QUALIFICATION"] });
    const partners = candidates.filter((c) => c.kind === "PARTNER");
    expect(partners.length).toBeGreaterThan(0);
    for (const p of partners) expect(p.blockers).toContain("PARTNER_ASSIGNMENT_DISABLED");
    // Eligible candidates come first.
    expect(candidates[0]?.eligible).toBe(true);
  });

  it("is not available to roles without job:assign", async () => {
    const { jobId } = await pendingJob();
    await expectDomainError(listAssignmentCandidates(finance, { jobId }, CONFIG), "FORBIDDEN");
    const staff = await contextForRole(db, "STAFF");
    await expectDomainError(listAssignmentCandidates(staff, { jobId }, CONFIG), "FORBIDDEN");
  });
});

describe("employee assignment", () => {
  it("assigns an eligible employee, audits it and schedules after payment", async () => {
    const logger = new CapturingLogger();
    const { jobId, bookingId } = await pendingJob();
    const employeeId = await staffedEmployee(admin, {
      serviceAreaId: areaId,
      qualifications: ["glass"],
    });
    const result = await assignJob(
      { ...dispatcher, logger },
      { jobId, kind: "EMPLOYEE", candidateId: employeeId },
      CONFIG,
    );
    expect(result.score).toBeGreaterThan(0);
    const job = await getJob(dispatcher, { jobId });
    expect(job).toMatchObject({
      status: "ASSIGNED",
      fulfillmentType: "IN_HOUSE",
      assignment: { kind: "EMPLOYEE", id: employeeId },
    });
    // Booking still waits for prepayment; confirmation schedules it.
    expect((await getBooking(dispatcher, { bookingId })).status).toBe("PENDING_PAYMENT");
    await confirmPayment(bookingId);
    expect((await getBooking(dispatcher, { bookingId })).status).toBe("SCHEDULED");
    const actions = await db
      .select({ action: schema.auditLog.action, entityType: schema.auditLog.entityType })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, employeeId));
    expect(actions.map((a) => a.action)).toContain("employee.assigned");
    const jobActions = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, jobId));
    expect(jobActions.map((a) => a.action)).toEqual(
      expect.arrayContaining(["job.created", "job.status_changed", "job.assigned"]),
    );
    expect(logger.events.map((e) => e.event)).toContain("job.assigned");
  });

  it("rejects forged, ineligible and unauthorised assignments", async () => {
    const logger = new CapturingLogger();
    const { jobId } = await pendingJob();
    await expectDomainError(
      assignJob(
        { ...dispatcher, logger },
        { jobId, kind: "EMPLOYEE", candidateId: randomUUID() },
        CONFIG,
      ),
      "NOT_FOUND",
    );
    const unqualified = await staffedEmployee(admin, { serviceAreaId: areaId, qualifications: [] });
    await expectDomainError(
      assignJob(
        { ...dispatcher, logger },
        { jobId, kind: "EMPLOYEE", candidateId: unqualified },
        CONFIG,
      ),
      "POLICY_VIOLATION",
    );
    const inactive = await staffedEmployee(admin, {
      serviceAreaId: areaId,
      qualifications: ["glass"],
    });
    await updateEmployee(admin, { employeeId: inactive, active: false });
    await expectDomainError(
      assignJob(dispatcher, { jobId, kind: "EMPLOYEE", candidateId: inactive }, CONFIG),
      "POLICY_VIOLATION",
    );
    const absent = await staffedEmployee(admin, {
      serviceAreaId: areaId,
      qualifications: ["glass"],
    });
    const [job] = await db.select().from(schema.job).where(eq(schema.job.id, jobId));
    await addUnavailability(admin, {
      employeeId: absent,
      kind: "ABSENCE",
      startsAt: job?.scheduledStart.toISOString() ?? "",
      endsAt: job?.scheduledEnd.toISOString() ?? "",
    });
    await expectDomainError(
      assignJob(dispatcher, { jobId, kind: "EMPLOYEE", candidateId: absent }, CONFIG),
      "POLICY_VIOLATION",
    );
    const eligible = await staffedEmployee(admin, {
      serviceAreaId: areaId,
      qualifications: ["glass"],
    });
    await expectDomainError(
      assignJob(finance, { jobId, kind: "EMPLOYEE", candidateId: eligible }, CONFIG),
      "FORBIDDEN",
    );
    await expectDomainError(
      assignJob(dispatcher, { jobId, kind: "EMPLOYEE", candidateId: eligible, score: 100 }, CONFIG),
      "VALIDATION_FAILED",
    );
    const failures = logger.events.filter((e) => e.event === "assignment.failed");
    expect(failures).toHaveLength(2);
    expect(failures[1]?.fields["blockers"]).toBe("MISSING_QUALIFICATION");
  });

  it("prevents double booking of an employee under concurrent assignment", async () => {
    // Two jobs in the same week slot → same period.
    week += 1;
    const slotWeek = week;
    const first = await pendingJob(slotWeek);
    const second = await pendingJob(slotWeek);
    const employeeId = await staffedEmployee(admin, {
      serviceAreaId: areaId,
      qualifications: ["glass"],
    });
    const results = await Promise.allSettled([
      assignJob(
        dispatcher,
        { jobId: first.jobId, kind: "EMPLOYEE", candidateId: employeeId },
        CONFIG,
      ),
      assignJob(admin, { jobId: second.jobId, kind: "EMPLOYEE", candidateId: employeeId }, CONFIG),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((r) => r.status === "rejected");
    expect(
      failure !== undefined &&
        (isDomainError(failure.reason, "POLICY_VIOLATION") ||
          isDomainError(failure.reason, "CONFLICT")),
    ).toBe(true);
    const active = await db
      .select({ id: schema.jobAssignment.id })
      .from(schema.jobAssignment)
      .where(
        and(
          eq(schema.jobAssignment.employeeId, employeeId),
          eq(schema.jobAssignment.status, "ACTIVE"),
        ),
      );
    expect(active).toHaveLength(1);
    // Database guard: an overlapping ACTIVE assignment is rejected even when inserted directly.
    const [existing] = await db
      .select()
      .from(schema.jobAssignment)
      .where(eq(schema.jobAssignment.employeeId, employeeId));
    const otherJob = existing?.jobId === first.jobId ? second.jobId : first.jobId;
    await expectPgError(
      db.insert(schema.jobAssignment).values({
        jobId: otherJob,
        employeeId,
        startsAt: existing?.startsAt ?? new Date(),
        endsAt: existing?.endsAt ?? new Date(),
        factors: {},
        assignedByUserId: dispatcher.actor.userId,
      }),
      "23P01",
    );
  });

  it("reassigns and releases with audit and booking synchronisation", async () => {
    const { jobId, bookingId } = await pendingJob();
    await confirmPayment(bookingId);
    const a = await staffedEmployee(admin, { serviceAreaId: areaId, qualifications: ["glass"] });
    const b = await staffedEmployee(admin, { serviceAreaId: areaId, qualifications: ["glass"] });
    await assignJob(dispatcher, { jobId, kind: "EMPLOYEE", candidateId: a }, CONFIG);
    expect((await getBooking(dispatcher, { bookingId })).status).toBe("SCHEDULED");
    await expectDomainError(
      reassignJob(dispatcher, { jobId, kind: "EMPLOYEE", candidateId: b, reason: "" }, CONFIG),
      "VALIDATION_FAILED",
    );
    await reassignJob(
      dispatcher,
      { jobId, kind: "EMPLOYEE", candidateId: b, reason: "Vertretung (Test)" },
      CONFIG,
    );
    const job = await getJob(dispatcher, { jobId });
    expect(job.assignment?.id).toBe(b);
    expect(job.assignmentHistory.map((h) => h.status)).toEqual(["ACTIVE", "RELEASED"]);
    await releaseJobAssignment(dispatcher, { jobId, reason: "Termin wird neu disponiert (Test)" });
    expect((await getJob(dispatcher, { jobId })).status).toBe("ASSIGNMENT_PENDING");
    expect((await getBooking(dispatcher, { bookingId })).status).toBe("CONFIRMED");
    const actions = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, jobId));
    expect(actions.map((x) => x.action)).toEqual(
      expect.arrayContaining(["job.reassigned", "job.assignment_released"]),
    );
    // Released assignments are evidence: they cannot be reactivated or deleted.
    await expectPgError(
      db
        .update(schema.jobAssignment)
        .set({ status: "ACTIVE" })
        .where(eq(schema.jobAssignment.jobId, jobId)),
      "23000",
    );
  });
});

describe("partner assignment", () => {
  it("assigns only verified partners and only when the owner enabled it", async () => {
    const { jobId } = await pendingJob();
    const partnerId = await verifiedPartner();
    await expectDomainError(
      assignJob(dispatcher, { jobId, kind: "PARTNER", candidateId: partnerId }, CONFIG),
      "POLICY_VIOLATION",
    );
    const unverified = await createPartner(admin, {
      legalName: "Ungeprüfter Partner (Testdaten)",
      baseLatitude: CENTER.latitude,
      baseLongitude: CENTER.longitude,
      serviceRadiusM: 30_000,
      maxConcurrentJobs: 5,
    });
    await setPartnerServices(admin, { partnerId: unverified, serviceIds: [ids.serviceId] });
    await expectDomainError(
      assignJob(dispatcher, { jobId, kind: "PARTNER", candidateId: unverified }, PARTNERS_ENABLED),
      "POLICY_VIOLATION",
    );
    const wrongService = await verifiedPartner({ services: [] });
    await expectDomainError(
      assignJob(
        dispatcher,
        { jobId, kind: "PARTNER", candidateId: wrongService },
        PARTNERS_ENABLED,
      ),
      "POLICY_VIOLATION",
    );
    await assignJob(
      dispatcher,
      { jobId, kind: "PARTNER", candidateId: partnerId },
      PARTNERS_ENABLED,
    );
    const job = await getJob(dispatcher, { jobId });
    expect(job).toMatchObject({
      fulfillmentType: "PARTNER",
      assignment: { kind: "PARTNER", id: partnerId },
    });
  });

  it("refuses partner activation without verified documents", async () => {
    const partnerId = await createPartner(admin, {
      legalName: "Partner ohne Nachweise (Testdaten)",
      baseLatitude: CENTER.latitude,
      baseLongitude: CENTER.longitude,
      serviceRadiusM: 10_000,
    });
    await addPartnerDocument(admin, {
      partnerId,
      kind: "TRADE_REGISTRATION",
      validUntil: "2099-12-31",
    });
    await expectDomainError(
      verifyAndActivatePartner(
        admin,
        { partnerId },
        { requiredDocumentKinds: CONFIG.requiredPartnerDocumentKinds, today: TODAY },
      ),
      "POLICY_VIOLATION",
    );
    await expectDomainError(
      verifyAndActivatePartner(
        dispatcher,
        { partnerId },
        { requiredDocumentKinds: CONFIG.requiredPartnerDocumentKinds, today: TODAY },
      ),
      "FORBIDDEN",
    );
    // Database guard: ACTIVE without verification is impossible.
    await expectPgError(
      db.update(schema.partner).set({ status: "ACTIVE" }).where(eq(schema.partner.id, partnerId)),
      "23514",
    );
  });

  it("limits partners to their own data (IDOR)", async () => {
    const own = await verifiedPartner();
    const other = await verifiedPartner();
    const partnerUser = await contextForRole(db, "PARTNER", { partnerId: own });
    expect((await getPartnerDetail(partnerUser, { partnerId: own })).id).toBe(own);
    await expectDomainError(getPartnerDetail(partnerUser, { partnerId: other }), "FORBIDDEN");
    const list = await listPartners(partnerUser, {});
    expect(list.items.map((p) => p.id)).toEqual([own]);
    await expectDomainError(getEmployee(partnerUser, { employeeId: randomUUID() }), "FORBIDDEN");
  });
});

describe("job execution and payment guard", () => {
  it("lets only the assigned employee start, and only after prepayment", async () => {
    const logger = new CapturingLogger();
    const { jobId, bookingId } = await pendingJob();
    const employeeId = await staffedEmployee(admin, {
      serviceAreaId: areaId,
      qualifications: ["glass"],
    });
    const staff = await contextForRole(db, "STAFF");
    const otherStaff = await contextForRole(db, "STAFF");
    await linkEmployeeAccount(admin, { employeeId, userId: staff.actor.userId });
    await assignJob(dispatcher, { jobId, kind: "EMPLOYEE", candidateId: employeeId }, CONFIG);

    // Job IDOR: a different staff member sees nothing and cannot act.
    expect(await listOwnJobs(otherStaff, {})).toEqual([]);
    await expectDomainError(listOwnJobs(otherStaff, { jobId }), "NOT_FOUND");
    await expectDomainError(transitionJob(otherStaff, { jobId, to: "IN_PROGRESS" }), "NOT_FOUND");
    await expectDomainError(getJob(staff, { jobId }), "FORBIDDEN");
    await expectDomainError(getEmployee(staff, { employeeId }), "FORBIDDEN");

    const ownJobs = await listOwnJobs(staff, {});
    expect(ownJobs.map((j) => j.id)).toEqual([jobId]);
    expect(ownJobs[0]).not.toHaveProperty("grossCents");
    expect(ownJobs[0]).not.toHaveProperty("customerName");

    // Payment guard (prepayment missing).
    await expectDomainError(
      transitionJob({ ...staff, logger }, { jobId, to: "IN_PROGRESS" }),
      "POLICY_VIOLATION",
    );
    expect(logger.events).toEqual([
      expect.objectContaining({ event: "payment_guard.blocked", level: "warn" }),
    ]);
    // The database blocks the start as well, even without the service.
    await expectPgError(
      db.update(schema.job).set({ status: "IN_PROGRESS" }).where(eq(schema.job.id, jobId)),
      "23514",
    );

    await confirmPayment(bookingId);
    await expectDomainError(transitionJob(staff, { jobId, to: "QUALITY_CHECK" }), "FORBIDDEN");
    expect(await transitionJob(staff, { jobId, to: "IN_PROGRESS" })).toBe("IN_PROGRESS");
    await expectDomainError(
      transitionJob(dispatcher, { jobId, to: "CLOSED" }),
      "INVALID_STATE_TRANSITION",
    );
    expect(await transitionJob(staff, { jobId, to: "COMPLETED" })).toBe("COMPLETED");
    expect((await getBooking(dispatcher, { bookingId })).status).toBe("COMPLETED");
    expect(await transitionJob(dispatcher, { jobId, to: "QUALITY_CHECK" })).toBe("QUALITY_CHECK");
    expect(await transitionJob(dispatcher, { jobId, to: "CLOSED" })).toBe("CLOSED");
    const history = (await getJob(dispatcher, { jobId })).history.map((h) => h.toStatus);
    expect(history).toEqual([
      "CLOSED",
      "QUALITY_CHECK",
      "COMPLETED",
      "IN_PROGRESS",
      "ASSIGNED",
      "ASSIGNMENT_PENDING",
      "PLANNED",
    ]);
  });

  it("lets a partner user progress only jobs of its own partner", async () => {
    const { jobId, bookingId } = await pendingJob();
    const partnerId = await verifiedPartner();
    const otherPartner = await verifiedPartner();
    await assignJob(
      dispatcher,
      { jobId, kind: "PARTNER", candidateId: partnerId },
      PARTNERS_ENABLED,
    );
    await confirmPayment(bookingId);
    const foreignPartnerUser = await contextForRole(db, "PARTNER", { partnerId: otherPartner });
    await expectDomainError(
      transitionJob(foreignPartnerUser, { jobId, to: "IN_PROGRESS" }),
      "NOT_FOUND",
    );
    const partnerUser = await contextForRole(db, "PARTNER", { partnerId });
    expect((await listOwnJobs(partnerUser, {})).map((j) => j.id)).toContain(jobId);
    expect(await transitionJob(partnerUser, { jobId, to: "IN_PROGRESS" })).toBe("IN_PROGRESS");
  });

  it("cannot cancel a booking whose job already started", async () => {
    const { jobId, bookingId } = await pendingJob();
    const employeeId = await staffedEmployee(admin, {
      serviceAreaId: areaId,
      qualifications: ["glass"],
    });
    await assignJob(dispatcher, { jobId, kind: "EMPLOYEE", candidateId: employeeId }, CONFIG);
    await confirmPayment(bookingId);
    await transitionJob(dispatcher, { jobId, to: "IN_PROGRESS" });
    await expectDomainError(
      cancelBooking(dispatcher, { bookingId, reason: "zu spät (Test)" }),
      "POLICY_VIOLATION",
    );
  });
});

describe("job detail and internal data", () => {
  it("shows internal finance and audit only to authorised roles", async () => {
    const { jobId } = await pendingJob();
    const dispatcherView = await getJob(dispatcher, { jobId });
    expect(dispatcherView.internalFinance).toBeNull();
    expect(dispatcherView.audit).toBeNull();
    expect(dispatcherView).toMatchObject({
      booking: { paymentRequirement: "VORKASSE_REQUIRED", paymentStatus: "PAYMENT_REQUIRED" },
      services: ["Testleistung"],
    });
    const financeView = await getJob(finance, { jobId });
    expect(financeView.internalFinance).toEqual({
      internalCostCents: null,
      contributionMarginCents: null,
      pricedItems: 0,
      manualItems: 1,
    });
    expect(financeView.audit?.map((a) => a.action)).toContain("job.created");
  });

  it("keeps employee data to staff with employee:read", async () => {
    const employeeId = await staffedEmployee(admin, {
      serviceAreaId: areaId,
      qualifications: ["glass"],
    });
    const detail = await getEmployee(dispatcher, { employeeId });
    expect(detail.workingWindows).toHaveLength(7);
    expect(detail.serviceAreas.map((a) => a.id)).toEqual([areaId]);
    expect((await listEmployees(dispatcher, {})).total).toBeGreaterThan(0);
    await expectDomainError(updateEmployee(dispatcher, { employeeId, active: false }), "FORBIDDEN");
    await expectDomainError(getEmployee(finance, { employeeId }), "FORBIDDEN");
    const customer = await contextForRole(db, "CUSTOMER", {
      customerId: (await geocodedCustomer(db, dispatcher, NEAR)).customerId,
    });
    await expectDomainError(getEmployee(customer, { employeeId }), "FORBIDDEN");
    await expectDomainError(
      updateEmployee(admin, { employeeId, active: false, userId: "forged" }),
      "VALIDATION_FAILED",
    );
  });
});
