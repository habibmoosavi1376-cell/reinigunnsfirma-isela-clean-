import { randomUUID } from "node:crypto";
import type { ServiceContext } from "@isela/auth";
import {
  confirmPayment,
  createInvoiceForBooking,
  getInvoice,
  issueInvoice,
  recordPayment,
  releaseInvoice,
  type BillingConfig,
  type FinanceOptions,
  type InvoiceKind,
  type PaymentMethod,
} from "@isela/billing";
import { createCatalogService, createServiceArea, setServiceAreaActive } from "@isela/catalog";
import { createProperty, linkLeadToCustomer, submitServiceRequest } from "@isela/crm";
import { eq, schema, type Database } from "@isela/database";
import {
  DEFAULT_OPERATIONS_CONFIG,
  addWorkingWindow,
  createEmployee,
  setEmployeeServiceAreas,
  type OperationsConfig,
} from "@isela/operations";
import { DEFAULT_PAYMENT_POLICY } from "@isela/payment-risk";
import {
  DEFAULT_QUOTE_CONFIG,
  addQuoteItem,
  createQuoteDraft,
  transitionQuote,
} from "@isela/quotes";
import { systemClock, type DomainLogger, type LogFields } from "@isela/shared";
import { TEST_CRM_CONFIG, uniqueEmail } from "./fixtures.ts";

/*
 * Fixtures for the day-5 operations tests. All records are clearly marked test data. The
 * address coordinates are set directly because no geocoding provider runs in tests; amounts
 * are test values, not business prices.
 */

export type StaffCtx = ServiceContext & { actor: NonNullable<ServiceContext["actor"]> };

export const PAYMENT_POLICY = { policy: DEFAULT_PAYMENT_POLICY, version: null };
/** Billing configuration for tests only – clearly test values, not owner decisions. */
export const TEST_BILLING_CONFIG: BillingConfig = {
  invoiceNumberPrefix: "TEST",
  paymentTermDays: 14,
  prepaymentDueDays: 7,
};
export const FINANCE_OPTIONS: FinanceOptions = {
  paymentPolicy: PAYMENT_POLICY,
  timeZone: DEFAULT_OPERATIONS_CONFIG.timeZone,
  billing: TEST_BILLING_CONFIG,
};

/** Creates, issues and releases the invoice of a booking (finance). */
export async function releasedInvoice(
  finance: StaffCtx,
  bookingId: string,
  kind: InvoiceKind = "PREPAYMENT",
  options: FinanceOptions = FINANCE_OPTIONS,
): Promise<string> {
  const { invoiceId } = await createInvoiceForBooking(finance, { bookingId, kind });
  await issueInvoice(finance, { invoiceId }, options);
  await releaseInvoice(finance, { invoiceId }, options);
  return invoiceId;
}

/** Records and confirms a manual payment (default: the full outstanding amount). */
export async function payInvoice(
  finance: StaffCtx,
  invoiceId: string,
  options: {
    amountCents?: number;
    method?: PaymentMethod;
    reference?: string;
    finance?: FinanceOptions;
  } = {},
): Promise<string> {
  const invoice = await getInvoice(finance, { invoiceId });
  const { paymentId } = await recordPayment(finance, {
    invoiceId,
    amountCents: options.amountCents ?? invoice.outstandingCents,
    method: options.method ?? "BANK_TRANSFER",
    reference: options.reference ?? `Kontoauszug Test ${randomUUID()}`,
    receivedAt: finance.clock.now().toISOString(),
    idempotencyKey: `test:${randomUUID()}`,
  });
  await confirmPayment(finance, { paymentId }, options.finance ?? FINANCE_OPTIONS);
  return paymentId;
}

/** Day-6 prepayment path: prepayment invoice → recorded and confirmed payment. */
export async function payPrepayment(finance: StaffCtx, bookingId: string): Promise<string> {
  const invoiceId = await releasedInvoice(finance, bookingId, "PREPAYMENT");
  await payInvoice(finance, invoiceId);
  return invoiceId;
}

export const PARTNERS_ENABLED: OperationsConfig = {
  ...DEFAULT_OPERATIONS_CONFIG,
  partnerAssignmentEnabled: true,
};

/** Captures structured log events (to assert events and the absence of personal data). */
export class CapturingLogger implements DomainLogger {
  readonly events: { level: "info" | "warn"; event: string; fields: LogFields }[] = [];

  info(event: string, fields: LogFields = {}): void {
    this.events.push({ level: "info", event, fields });
  }

  warn(event: string, fields: LogFields = {}): void {
    this.events.push({ level: "warn", event, fields });
  }
}

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

/** Active CIRCLE service area with top priority around `center`. */
export async function activeServiceArea(
  admin: StaffCtx,
  center: GeoPoint,
  radiusM = 20_000,
): Promise<string> {
  const id = await createServiceArea(admin, {
    kind: "CIRCLE",
    key: `test-area-${randomUUID().slice(0, 8)}`,
    name: "Testgebiet (Testdaten)",
    center,
    radiusM,
    priority: 1,
  });
  await setServiceAreaActive(admin, { serviceAreaId: id, active: true });
  return id;
}

export async function testService(
  admin: StaffCtx,
  db: Database,
  options: { qualifications?: string[]; pricingStrategy?: "MANUAL_QUOTE" | "RULE_BASED" } = {},
): Promise<{ serviceId: string; categoryId: string }> {
  const [category] = await db
    .select({ id: schema.serviceCategory.id })
    .from(schema.serviceCategory)
    .where(eq(schema.serviceCategory.key, "apartment-cleaning"));
  const categoryId = category?.id ?? "";
  const serviceId = await createCatalogService(admin, {
    categoryId,
    key: `test-service-${randomUUID().slice(0, 8)}`,
    name: "Testleistung Wohnung",
    unit: "HOUR",
    durationModel: "FIXED",
    baseDurationMinutes: 180,
    durationPerUnitSeconds: null,
    pricingStrategy: options.pricingStrategy ?? "MANUAL_QUOTE",
    requiredQualifications: options.qualifications ?? [],
  });
  return { serviceId, categoryId };
}

let counter = 0;

/** Lead → customer → property with a trusted (test) coordinate on the address. */
export async function geocodedCustomer(
  db: Database,
  dispatcher: StaffCtx,
  point: GeoPoint,
  options: { readonly email?: string } = {},
): Promise<{ customerId: string; propertyId: string; addressId: string }> {
  counter += 1;
  const lead = await submitServiceRequest(
    {
      customerType: "PRIVATE",
      fullName: "Buchung Testdaten",
      email: options.email ?? uniqueEmail("booking"),
      street: "Buchungsweg",
      houseNumber: String(counter),
      postalCode: "12345",
      city: "Teststadt",
      serviceCategoryKey: "apartment-cleaning",
      propertyType: "APARTMENT",
      frequency: "ONCE",
      privacyNoticeAcknowledged: true,
      privacyNoticeVersion: "test-v1",
    },
    {
      db,
      clock: systemClock,
      config: TEST_CRM_CONFIG,
      requester: null,
      clientKey: `198.51.100.${String(counter % 250)}-ops`,
      rateLimitPerHour: 500,
    },
  );
  const { customerId } = await linkLeadToCustomer(
    dispatcher,
    { leadId: lead.leadId },
    TEST_CRM_CONFIG,
  );
  const [address] = await db
    .select({ id: schema.customerAddress.id })
    .from(schema.customerAddress)
    .where(eq(schema.customerAddress.customerId, customerId));
  const addressId = address?.id ?? "";
  await db
    .update(schema.customerAddress)
    .set({
      latitude: point.latitude,
      longitude: point.longitude,
      geocodingStatus: "MANUAL",
      geocodedAt: new Date(),
    })
    .where(eq(schema.customerAddress.id, addressId));
  const propertyId = await createProperty(dispatcher, {
    customerId,
    addressId,
    name: "Objekt Testdaten",
    propertyType: "APARTMENT",
  });
  return { customerId, propertyId, addressId };
}

/** Quote with one manual test item, reviewed, sent and accepted. */
export async function acceptedQuote(
  dispatcher: StaffCtx,
  admin: StaffCtx,
  ids: { customerId: string; propertyId: string; categoryId: string; serviceId: string },
): Promise<string> {
  const quoteId = await createQuoteDraft(dispatcher, {
    customerId: ids.customerId,
    propertyId: ids.propertyId,
  });
  await addQuoteItem(
    dispatcher,
    {
      quoteId,
      serviceCategoryId: ids.categoryId,
      serviceId: ids.serviceId,
      description: "Testleistung",
      quantity: 3,
      unit: "HOUR",
      unitPriceCents: 3000,
    },
    DEFAULT_QUOTE_CONFIG,
  );
  await transitionQuote(dispatcher, { quoteId, to: "PENDING_REVIEW" }, DEFAULT_QUOTE_CONFIG);
  await transitionQuote(admin, { quoteId, to: "SENT" }, DEFAULT_QUOTE_CONFIG);
  await transitionQuote(
    dispatcher,
    { quoteId, to: "ACCEPTED", reason: "Kunde hat schriftlich angenommen (Test)" },
    DEFAULT_QUOTE_CONFIG,
  );
  return quoteId;
}

/**
 * A future Tuesday 08:00 UTC (10:00 CEST / 09:00 CET) plus `slotHours` – at least one week
 * ahead so that the window is always in the future.
 */
export function futureSlot(weeksAhead: number, slotHours = 0, durationMinutes = 180) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8));
  const daysToTuesday = (2 - start.getUTCDay() + 7) % 7;
  start.setUTCDate(start.getUTCDate() + daysToTuesday + 7 * weeksAhead);
  start.setUTCHours(start.getUTCHours() + slotHours);
  const end = new Date(start.getTime() + 4 * 60 * 60_000);
  return {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    durationMinutes,
  };
}

/** Active employee with qualifications, the area and working hours 07:00–20:00 every day. */
export async function staffedEmployee(
  admin: StaffCtx,
  options: {
    serviceAreaId: string;
    qualifications?: string[];
    base?: GeoPoint;
    maxJobsPerDay?: number;
    name?: string;
  },
): Promise<string> {
  const employeeId = await createEmployee(admin, {
    displayName: options.name ?? "Mitarbeitende Testdaten",
    qualifications: options.qualifications ?? [],
    maxJobsPerDay: options.maxJobsPerDay ?? 4,
    ...(options.base === undefined
      ? {}
      : { baseLatitude: options.base.latitude, baseLongitude: options.base.longitude }),
  });
  await setEmployeeServiceAreas(admin, { employeeId, serviceAreaIds: [options.serviceAreaId] });
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await addWorkingWindow(admin, { employeeId, weekday, startMinute: 420, endMinute: 1200 });
  }
  return employeeId;
}
