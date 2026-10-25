import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema } from "@isela/database";
import {
  DEFAULT_OPERATIONS_CONFIG,
  addContractPause,
  createServiceContract,
  endContractPause,
  generateContractBookings,
  getBooking,
  getServiceContract,
  listCustomerContracts,
  listNotifications,
  listServiceContracts,
  previewContractOccurrences,
  recordHolidayYear,
  reviewNotification,
  updateContractPause,
  updateContractStatus,
} from "@isela/operations";
import { expectDomainError } from "../support/assertions.ts";
import { anonymousContext, contextForRole, openTestDatabase } from "../support/fixtures.ts";
import {
  PAYMENT_POLICY,
  acceptedQuote,
  activeServiceArea,
  geocodedCustomer,
  testService,
  type StaffCtx,
} from "../support/operations.ts";

/*
 * Back office for recurring contracts and notifications: authorisation, validation,
 * optimistic concurrency and audit events. Holiday data belongs to a fictitious test region.
 */

const handle = openTestDatabase();
const db = handle.db;
afterAll(() => handle.close());

const CENTER = { latitude: -34.2, longitude: 18.9 };
const REGION = `XB-${randomBytes(2).toString("hex").toUpperCase().slice(0, 3)}`;
const TZ = DEFAULT_OPERATIONS_CONFIG.timeZone;
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const FROM = day(7);
const TO = day(60);

let dispatcher: StaffCtx;
let admin: StaffCtx;
let financeReadOnly: StaffCtx;
let ids: { serviceId: string; categoryId: string };

const generationOptions = {
  paymentPolicy: PAYMENT_POLICY,
  config: DEFAULT_OPERATIONS_CONFIG,
  holidayRegion: REGION,
};

async function newContract() {
  const customer = await geocodedCustomer(db, dispatcher, CENTER);
  const quoteId = await acceptedQuote(dispatcher, admin, { ...customer, ...ids });
  const { contractId } = await createServiceContract(dispatcher, {
    quoteId,
    frequency: "WEEKLY",
    startDate: day(9),
    endDate: null,
    windowStartMinute: 9 * 60,
    windowEndMinute: 13 * 60,
    durationMinutes: 120,
  });
  return { ...customer, contractId };
}

async function auditActions(entityId: string): Promise<string[]> {
  const rows = await db
    .select({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.entityId, entityId));
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  dispatcher = await contextForRole(db, "DISPATCHER");
  admin = await contextForRole(db, "ADMIN");
  financeReadOnly = await contextForRole(db, "FINANCE");
  await activeServiceArea(admin, CENTER);
  ids = await testService(admin, db, { qualifications: ["glass"] });
  for (const year of [...new Set([FROM.slice(0, 4), TO.slice(0, 4)])].map(Number)) {
    await recordHolidayYear(admin, {
      region: REGION,
      year,
      sourceReference: "TEST DATA – fictitious calendar for automated tests",
      holidays: [day(16)]
        .filter((d) => d.startsWith(`${String(year)}-`))
        .map((date) => ({ date, name: "Testfeiertag (fiktiv)" })),
    });
  }
});

describe("contract status management", () => {
  it("lists and shows contracts with customer, rule and pauses", async () => {
    const { contractId, customerId } = await newContract();
    const list = await listServiceContracts(dispatcher, { status: "ACTIVE" }, { timeZone: TZ });
    expect(list.items.some((c) => c.id === contractId && c.customerId === customerId)).toBe(true);
    const view = await getServiceContract(dispatcher, { contractId });
    expect(view).toMatchObject({ status: "ACTIVE", version: 1, frequency: "WEEKLY", pauses: [] });
  });

  it("changes status with optimistic locking, audits it and stops generation when paused", async () => {
    const { contractId } = await newContract();
    const results = await Promise.allSettled([
      updateContractStatus(dispatcher, {
        contractId,
        to: "PAUSED",
        expectedVersion: 1,
        reason: "Kunde im Urlaub (Test)",
      }),
      updateContractStatus(dispatcher, {
        contractId,
        to: "ENDED",
        expectedVersion: 1,
        reason: "Vertrag beendet (Test)",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });
    const view = await getServiceContract(dispatcher, { contractId });
    expect(view.version).toBe(2);
    expect(await auditActions(contractId)).toContain("service_contract.status_changed");
    if (view.status === "PAUSED") {
      await expectDomainError(
        generateContractBookings(dispatcher, { contractId, from: FROM, to: TO }, generationOptions),
        "POLICY_VIOLATION",
      );
    }
  });

  it("treats ENDED as final and rejects invalid transitions and input", async () => {
    const { contractId } = await newContract();
    await updateContractStatus(dispatcher, {
      contractId,
      to: "ENDED",
      expectedVersion: 1,
      reason: "Vertrag beendet (Test)",
    });
    await expectDomainError(
      updateContractStatus(dispatcher, {
        contractId,
        to: "ACTIVE",
        expectedVersion: 2,
        reason: "Reaktivierung (Test)",
      }),
      "POLICY_VIOLATION",
    );
    for (const bad of [
      { contractId, to: "ACTIVE", expectedVersion: 2, reason: "x" },
      { contractId, to: "DELETED", expectedVersion: 2, reason: "Test Grund" },
      { contractId: "not-a-uuid", to: "ACTIVE", expectedVersion: 2, reason: "Test Grund" },
      { contractId, to: "ACTIVE", expectedVersion: 0, reason: "Test Grund" },
    ]) {
      await expectDomainError(updateContractStatus(dispatcher, bad), "VALIDATION_FAILED");
    }
    await expectDomainError(
      addContractPause(dispatcher, {
        contractId,
        fromDate: day(20),
        toDate: day(25),
        reason: "Pause (Test)",
      }),
      "POLICY_VIOLATION",
    );
  });

  it("enforces permissions server-side (read-only, anonymous, unknown ids)", async () => {
    const { contractId } = await newContract();
    await expect(getServiceContract(financeReadOnly, { contractId })).resolves.toBeDefined();
    await expectDomainError(
      updateContractStatus(financeReadOnly, {
        contractId,
        to: "PAUSED",
        expectedVersion: 1,
        reason: "Nicht erlaubt (Test)",
      }),
      "FORBIDDEN",
    );
    await expectDomainError(
      listServiceContracts(anonymousContext(db), {}, { timeZone: TZ }),
      "UNAUTHENTICATED",
    );
    const customerCtx = await contextForRole(db, "STAFF");
    await expectDomainError(getServiceContract(customerCtx, { contractId }), "FORBIDDEN");
    await expectDomainError(
      getServiceContract(dispatcher, { contractId: "00000000-0000-4000-8000-000000000000" }),
      "NOT_FOUND",
    );
  });
});

describe("contract pauses", () => {
  it("reports existing bookings in a new pause without cancelling them", async () => {
    const { contractId } = await newContract();
    const generated = await generateContractBookings(
      dispatcher,
      { contractId, from: FROM, to: TO },
      generationOptions,
    );
    const first = generated.created[0];
    if (first === undefined) throw new Error("no booking generated");
    const result = await addContractPause(dispatcher, {
      contractId,
      fromDate: first.date,
      toDate: first.date,
      reason: "Objekt nicht zugänglich (Test)",
    });
    expect(result.conflictingBookingIds).toEqual([first.bookingId]);
    expect((await getBooking(dispatcher, { bookingId: first.bookingId })).status).not.toBe(
      "CANCELLED",
    );
    expect(await auditActions(contractId)).toContain("service_contract.paused");
  });

  it("edits and ends pauses with validation and audit; the preview honours them", async () => {
    const { contractId } = await newContract();
    const { pauseId } = await addContractPause(dispatcher, {
      contractId,
      fromDate: day(20),
      toDate: day(40),
      reason: "Renovierung (Test)",
    });
    await updateContractPause(
      dispatcher,
      { pauseId, fromDate: day(21), toDate: day(35), reason: "Renovierung verkürzt (Test)" },
      { timeZone: TZ },
    );
    await expectDomainError(
      updateContractPause(
        dispatcher,
        { pauseId, fromDate: day(30), toDate: day(21), reason: "Ungültig (Test)" },
        { timeZone: TZ },
      ),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      endContractPause(dispatcher, { pauseId, lastDay: day(10) }),
      "VALIDATION_FAILED",
    );
    await expectDomainError(
      endContractPause(dispatcher, { pauseId, lastDay: day(36) }),
      "VALIDATION_FAILED",
    );
    await endContractPause(dispatcher, { pauseId, lastDay: day(28) });
    const view = await getServiceContract(dispatcher, { contractId });
    expect(view.pauses).toEqual([
      expect.objectContaining({ id: pauseId, fromDate: day(21), toDate: day(28) }),
    ]);
    const actions = await auditActions(contractId);
    expect(actions).toEqual(
      expect.arrayContaining(["service_contract.pause_updated", "service_contract.pause_ended"]),
    );
    const preview = await previewContractOccurrences(
      dispatcher,
      { contractId, from: FROM, to: TO },
      { timeZone: TZ, holidayRegion: REGION },
    );
    expect(preview.holidayDataComplete).toBe(true);
    for (const o of preview.occurrences) {
      if (o.date >= day(21) && o.date <= day(28)) expect(o.skipReason).toBe("PAUSED");
    }
    await expectDomainError(
      updateContractPause(
        financeReadOnly,
        { pauseId, fromDate: day(21), toDate: day(30), reason: "Nicht erlaubt (Test)" },
        { timeZone: TZ },
      ),
      "FORBIDDEN",
    );
  });

  it("previews without inventing holidays when data is missing", async () => {
    const { contractId } = await newContract();
    const preview = await previewContractOccurrences(
      dispatcher,
      { contractId, from: FROM, to: TO },
      { timeZone: TZ, holidayRegion: null },
    );
    expect(preview.holidayDataComplete).toBe(false);
    expect(preview.occurrences.every((o) => o.skipReason !== "HOLIDAY")).toBe(true);
  });
});

describe("notification review", () => {
  async function outboxRow(status: "DEAD" | "UNCERTAIN" | "SUPPRESSED" | "NO_RECIPIENT") {
    const { customerId } = await geocodedCustomer(db, dispatcher, CENTER);
    const [row] = await db
      .insert(schema.notificationOutbox)
      .values({
        purpose: "APPOINTMENT_REMINDER",
        dedupeKey: `TEST:${randomBytes(8).toString("hex")}`,
        customerId,
        status,
        attempts: 3,
        claimedAt: new Date(),
        lastErrorCode: "SEND_FAILED",
      })
      .returning({ id: schema.notificationOutbox.id });
    return row?.id ?? "";
  }

  it("lists status counts without addresses or content", async () => {
    const id = await outboxRow("DEAD");
    const list = await listNotifications(dispatcher, { status: "DEAD" });
    const item = list.items.find((i) => i.id === id);
    expect(item).toMatchObject({ status: "DEAD", attempts: 3, lastErrorCode: "SEND_FAILED" });
    expect(Object.keys(item ?? {})).not.toEqual(expect.arrayContaining(["email", "to", "text"]));
    expect(list.counts.DEAD).toBeGreaterThanOrEqual(1);
  });

  it("requeues and dismisses with audit, optimistic status check and guards", async () => {
    const dead = await outboxRow("DEAD");
    await reviewNotification(dispatcher, {
      notificationId: dead,
      action: "REQUEUE",
      expectedStatus: "DEAD",
      reason: "SMTP-Störung behoben (Test)",
    });
    const [requeued] = await db
      .select()
      .from(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.id, dead));
    expect(requeued).toMatchObject({ status: "PENDING", attempts: 0, claimedAt: null });
    expect(await auditActions(dead)).toContain("notification.requeued");
    // Second click with the stale status: conflict, nothing changes.
    await expectDomainError(
      reviewNotification(dispatcher, {
        notificationId: dead,
        action: "DISMISS",
        expectedStatus: "DEAD",
        reason: "Doppelklick (Test)",
      }),
      "CONFLICT",
    );

    const uncertain = await outboxRow("UNCERTAIN");
    await expectDomainError(
      reviewNotification(dispatcher, {
        notificationId: uncertain,
        action: "REQUEUE",
        expectedStatus: "UNCERTAIN",
        reason: "Ungeprüft (Test)",
      }),
      "VALIDATION_FAILED",
    );
    await reviewNotification(dispatcher, {
      notificationId: uncertain,
      action: "DISMISS",
      expectedStatus: "UNCERTAIN",
      reason: "Zustellung beim Anbieter bestätigt (Test)",
    });
    const [dismissed] = await db
      .select({ status: schema.notificationOutbox.status })
      .from(schema.notificationOutbox)
      .where(and(eq(schema.notificationOutbox.id, uncertain)));
    expect(dismissed?.status).toBe("DISMISSED");

    const suppressed = await outboxRow("SUPPRESSED");
    await expectDomainError(
      reviewNotification(dispatcher, {
        notificationId: suppressed,
        action: "REQUEUE",
        expectedStatus: "SUPPRESSED",
        reason: "Widerspruch ignorieren (Test)",
      }),
      "POLICY_VIOLATION",
    );
    await expectDomainError(
      reviewNotification(financeReadOnly, {
        notificationId: suppressed,
        action: "DISMISS",
        expectedStatus: "NO_RECIPIENT",
        reason: "Nicht erlaubt (Test)",
      }),
      "FORBIDDEN",
    );
  });
});

describe("customer portal: own recurring contracts (IDOR)", () => {
  it("shows customers only their own contracts without internal fields", async () => {
    const own = await newContract();
    const foreign = await newContract();
    await addContractPause(dispatcher, {
      contractId: own.contractId,
      fromDate: day(30),
      toDate: day(31),
      reason: "Interne Notiz (Test)",
    });
    await generateContractBookings(
      dispatcher,
      { contractId: own.contractId, from: FROM, to: TO },
      generationOptions,
    );
    const customer = await contextForRole(db, "CUSTOMER", { customerId: own.customerId });

    const list = await listCustomerContracts(customer, { timeZone: TZ });
    expect(list.map((c) => c.id)).toEqual([own.contractId]);
    const [view] = list;
    expect(view).toMatchObject({ status: "ACTIVE", frequency: "WEEKLY" });
    expect(view?.pauses).toEqual([{ fromDate: day(30), toDate: day(31) }]);
    expect(view?.upcoming.some((o) => o.bookingId !== null)).toBe(true);
    for (const internal of ["customerId", "quoteId", "version", "durationMinutes"]) {
      expect(view, internal).not.toHaveProperty(internal);
    }
    expect(JSON.stringify(list)).not.toContain("Interne Notiz");
    expect(JSON.stringify(list)).not.toContain(foreign.contractId);

    // Back-office services stay forbidden; staff get nothing from the customer list.
    await expectDomainError(
      getServiceContract(customer, { contractId: own.contractId }),
      "FORBIDDEN",
    );
    await expectDomainError(listServiceContracts(customer, {}, { timeZone: TZ }), "FORBIDDEN");
    expect(await listCustomerContracts(dispatcher, { timeZone: TZ })).toEqual([]);
    expect(
      await listCustomerContracts(anonymousContext(db), { timeZone: TZ }).catch(() => "denied"),
    ).toBe("denied");
  });
});
