import {
  hasGlobalPermission,
  isAuthorized,
  requireActor,
  type Actor,
  type ServiceContext,
} from "@isela/auth";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  schema,
  sql,
  type SQL,
} from "@isela/database";
import {
  evaluatePaymentTerms,
  historyWithoutOrders,
  type PaymentTermsDecision,
} from "@isela/payment-risk";
import { GLOBAL_SCOPE, getEffectiveSetting } from "@isela/settings";
import { DomainError } from "@isela/shared";
import { emailSchema, normalizeEmail, parseInput, z } from "@isela/validation";
import { hashIdentity, type CrmConfig, type IdentityKind } from "./identity.ts";
import { likePattern } from "./lead-admin.ts";
import type { LeadStatus } from "./lead-state-machine.ts";

/*
 * Back-office customer CRM read models (staff only, GLOBAL customer:read). Filters are
 * validated and translated into parameterised SQL; pagination is mandatory and bounded.
 * The list shows no contact data (e-mail/phone). E-mail search works via the keyed identity
 * hash, so plain e-mail addresses are never stored or compared in clear text.
 */

export const CUSTOMER_KINDS = ["PRIVATE", "BUSINESS", "PROPERTY_MANAGEMENT"] as const;
export const CUSTOMER_STATUSES = ["ACTIVE", "INACTIVE", "BLOCKED"] as const;
export const CUSTOMER_PAGE_SIZE_MAX = 50;

/** Lead statuses that no longer count as an open process. */
const CLOSED_LEAD_STATUSES: readonly LeadStatus[] = ["WON", "LOST"];
/** Quote statuses that still need action (by staff or the customer). */
const OPEN_QUOTE_STATUSES = ["DRAFT", "PENDING_REVIEW", "SENT"] as const;

const isoDate = z.iso.date();

export const customerListQuerySchema = z
  .strictObject({
    kind: z.enum(CUSTOMER_KINDS).optional(),
    status: z.enum(CUSTOMER_STATUSES).optional(),
    serviceAreaId: z.uuid().optional(),
    createdFrom: isoDate.optional(),
    createdTo: isoDate.optional(),
    q: z.string().trim().min(1).max(100).optional(),
    page: z.number().int().min(1).max(10_000).default(1),
    pageSize: z.number().int().min(1).max(CUSTOMER_PAGE_SIZE_MAX).default(25),
  })
  .refine(
    (f) => f.createdFrom === undefined || f.createdTo === undefined || f.createdFrom <= f.createdTo,
    { message: "createdFrom must not be after createdTo", path: ["createdFrom"] },
  );

export type CustomerListQuery = z.input<typeof customerListQuerySchema>;

export interface CustomerListItem {
  readonly id: string;
  readonly kind: (typeof CUSTOMER_KINDS)[number];
  readonly displayName: string;
  readonly companyName: string | null;
  readonly status: (typeof CUSTOMER_STATUSES)[number];
  readonly duplicateReviewStatus: "NONE" | "PENDING";
  /** "PLZ Ort" of the primary (else oldest) active address. */
  readonly primaryLocation: string | null;
  readonly leadCount: number;
  readonly propertyCount: number;
  readonly openLeadCount: number;
  /** null without quote:read. */
  readonly openQuoteCount: number | null;
  readonly lastActivityAt: Date;
  readonly createdAt: Date;
}

export interface CustomerListPage {
  readonly items: readonly CustomerListItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

function requireStaffRead(actor: Actor): void {
  // Staff views list ALL customers – an OWN-scoped customer:read (customer portal) is not enough.
  if (!hasGlobalPermission(actor, "customer:read")) {
    throw new DomainError("FORBIDDEN", "Not allowed", { permission: "customer:read" });
  }
}

function nextDay(date: string): Date {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export async function listCustomers(
  ctx: ServiceContext,
  input: unknown,
  config: CrmConfig,
): Promise<CustomerListPage> {
  const actor = requireActor(ctx.actor);
  requireStaffRead(actor);
  const f = parseInput(customerListQuerySchema, input ?? {});
  const c = schema.customer;
  const address = schema.customerAddress;
  const request = schema.serviceRequest;
  const lead = schema.lead;
  const property = schema.property;
  const quote = schema.quote;
  const area = schema.serviceArea;

  const conditions: SQL[] = [isNull(c.archivedAt)];
  if (f.kind !== undefined) conditions.push(eq(c.kind, f.kind));
  if (f.status !== undefined) conditions.push(eq(c.status, f.status));
  if (f.createdFrom !== undefined) {
    conditions.push(gte(c.createdAt, new Date(`${f.createdFrom}T00:00:00.000Z`)));
  }
  if (f.createdTo !== undefined) conditions.push(lt(c.createdAt, nextDay(f.createdTo)));
  if (f.serviceAreaId !== undefined) {
    // A customer belongs to a service area when a geocoded active address lies inside it or a
    // request of the customer was assigned to it. Pure geometry – no city/postcode shortcuts.
    const areaId = f.serviceAreaId;
    const inArea = or(
      exists(
        ctx.db
          .select({ one: sql`1` })
          .from(address)
          .innerJoin(area, eq(area.id, areaId))
          .where(
            and(
              eq(address.customerId, c.id),
              isNull(address.archivedAt),
              sql`${address.location} IS NOT NULL`,
              sql`(
                (${area.kind} = 'CIRCLE' AND ST_DWithin(${area.center}, ${address.location}, ${area.radiusM})) OR
                (${area.kind} = 'POLYGON' AND ST_Covers(${area.boundary}, ${address.location}))
              )`,
            ),
          ),
      ),
      exists(
        ctx.db
          .select({ one: sql`1` })
          .from(request)
          .where(and(eq(request.customerId, c.id), eq(request.serviceAreaId, areaId))),
      ),
    );
    if (inArea !== undefined) conditions.push(inArea);
  }
  if (f.q !== undefined) {
    const idMatch = z.uuid().safeParse(f.q);
    const emailMatch = emailSchema.safeParse(f.q);
    if (idMatch.success) {
      conditions.push(eq(c.id, idMatch.data));
    } else if (emailMatch.success) {
      const valueHash = hashIdentity(config, "EMAIL", normalizeEmail(emailMatch.data));
      conditions.push(
        exists(
          ctx.db
            .select({ one: sql`1` })
            .from(schema.customerIdentity)
            .where(
              and(
                eq(schema.customerIdentity.customerId, c.id),
                eq(schema.customerIdentity.kind, "EMAIL"),
                eq(schema.customerIdentity.valueHash, valueHash),
              ),
            ),
        ),
      );
    } else {
      const pattern = likePattern(f.q);
      const addressMatch = exists(
        ctx.db
          .select({ one: sql`1` })
          .from(address)
          .where(
            and(
              eq(address.customerId, c.id),
              isNull(address.archivedAt),
              or(ilike(address.postalCode, pattern), ilike(address.city, pattern)),
            ),
          ),
      );
      const search = or(ilike(c.displayName, pattern), ilike(c.companyName, pattern), addressMatch);
      if (search !== undefined) conditions.push(search);
    }
  }
  const where = and(...conditions);

  const showQuotes = isAuthorized(actor, "quote:read");
  const [totalRow] = await ctx.db.select({ total: count() }).from(c).where(where);
  const rows = await ctx.db
    .select({
      id: c.id,
      kind: c.kind,
      displayName: c.displayName,
      companyName: c.companyName,
      status: c.status,
      duplicateReviewStatus: c.duplicateReviewStatus,
      createdAt: c.createdAt,
      primaryLocation: sql<string | null>`(
        SELECT ${address.postalCode} || ' ' || ${address.city} FROM ${address}
        WHERE ${address.customerId} = ${c.id} AND ${address.archivedAt} IS NULL
        ORDER BY ${address.isPrimary} DESC, ${address.createdAt} ASC, ${address.id} ASC LIMIT 1
      )`,
      leadCount: sql<number>`(
        SELECT count(DISTINCT ${request.leadId})::int FROM ${request}
        WHERE ${request.customerId} = ${c.id}
      )`,
      openLeadCount: sql<number>`(
        SELECT count(DISTINCT ${lead.id})::int FROM ${request}
        INNER JOIN ${lead} ON ${lead.id} = ${request.leadId}
        WHERE ${request.customerId} = ${c.id} AND ${lead.archivedAt} IS NULL
          AND ${lead.status} NOT IN (${sql.join(
            CLOSED_LEAD_STATUSES.map((s) => sql`${s}`),
            sql`, `,
          )})
      )`,
      propertyCount: sql<number>`(
        SELECT count(*)::int FROM ${property}
        WHERE ${property.customerId} = ${c.id} AND ${property.archivedAt} IS NULL
      )`,
      openQuoteCount: sql<number>`(
        SELECT count(*)::int FROM ${quote}
        WHERE ${quote.customerId} = ${c.id} AND ${quote.status} IN (${sql.join(
          OPEN_QUOTE_STATUSES.map((s) => sql`${s}`),
          sql`, `,
        )})
      )`,
      // GREATEST ignores NULLs, so customers without related records fall back to updated_at.
      lastActivityAt: sql<Date>`GREATEST(
        ${c.updatedAt},
        (SELECT max(${request.createdAt}) FROM ${request} WHERE ${request.customerId} = ${c.id}),
        (SELECT max(${address.updatedAt}) FROM ${address} WHERE ${address.customerId} = ${c.id}),
        (SELECT max(${property.updatedAt}) FROM ${property} WHERE ${property.customerId} = ${c.id}),
        (SELECT max(${quote.updatedAt}) FROM ${quote} WHERE ${quote.customerId} = ${c.id})
      )`.mapWith(c.updatedAt),
    })
    .from(c)
    .where(where)
    .orderBy(desc(c.createdAt), desc(c.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);

  return {
    items: rows.map((row) => ({ ...row, openQuoteCount: showQuotes ? row.openQuoteCount : null })),
    total: totalRow?.total ?? 0,
    page: f.page,
    pageSize: f.pageSize,
  };
}

export interface CustomerDetail {
  readonly customer: {
    readonly id: string;
    readonly kind: (typeof CUSTOMER_KINDS)[number];
    readonly displayName: string;
    readonly companyName: string | null;
    readonly status: (typeof CUSTOMER_STATUSES)[number];
    readonly duplicateReviewStatus: "NONE" | "PENDING";
    readonly createdAt: Date;
    readonly updatedAt: Date;
    /** Which identity attributes are registered (hashes only – never the values). */
    readonly identityKinds: readonly IdentityKind[];
  };
  readonly addresses: readonly {
    readonly id: string;
    readonly addressType: "BILLING" | "SERVICE" | "OTHER";
    readonly isPrimary: boolean;
    readonly street: string;
    readonly houseNumber: string;
    readonly postalCode: string;
    readonly city: string;
    readonly country: string;
    readonly geocodingStatus: string;
    readonly verificationStatus: string;
    readonly source: string;
    readonly inServiceArea: "IN_AREA" | "OUTSIDE" | "UNKNOWN";
    readonly createdAt: Date;
  }[];
  /** null without property:read. */
  readonly properties:
    | readonly {
        readonly id: string;
        readonly addressId: string;
        readonly name: string;
        readonly propertyType: string;
        readonly areaSqm: number | null;
        readonly rooms: number | null;
        readonly bathrooms: number | null;
        readonly serviceFrequency: string | null;
        readonly serviceRequirements: string | null;
        readonly notes: string | null;
        readonly active: boolean;
        readonly createdAt: Date;
        readonly updatedAt: Date;
      }[]
    | null;
  /** Requests/leads of the customer; null without lead:read. */
  readonly requests:
    | readonly {
        readonly requestId: string;
        readonly leadId: string;
        readonly leadStatus: LeadStatus;
        readonly serviceName: string;
        readonly propertyType: string;
        readonly frequency: string;
        readonly serviceAreaStatus: "AVAILABLE" | "NOT_AVAILABLE" | "UNKNOWN";
        readonly customerAddressId: string | null;
        readonly propertyId: string | null;
        readonly createdAt: Date;
      }[]
    | null;
  /** null without quote:read. */
  readonly quotes:
    | readonly {
        readonly id: string;
        readonly status: string;
        readonly propertyId: string | null;
        readonly currency: string;
        readonly netCents: number;
        readonly grossCents: number;
        readonly validUntil: string | null;
        readonly createdAt: Date;
        readonly updatedAt: Date;
      }[]
    | null;
  /** Linked user accounts; e-mail only for roles that may change customer master data. */
  readonly accounts: readonly {
    readonly userId: string;
    readonly name: string;
    readonly email: string | null;
    readonly emailVerified: boolean;
    readonly isScopeAdmin: boolean;
    readonly linkedAt: Date;
  }[];
  /** Contact persons from the customer's requests; null without lead_contact:read. */
  readonly contacts:
    | readonly {
        readonly id: string;
        readonly leadId: string;
        readonly fullName: string;
        readonly email: string | null;
        readonly phone: string | null;
        readonly consentStatus: string;
        readonly suppressed: boolean;
      }[]
    | null;
  /** null without consent:read. */
  readonly consents:
    | readonly {
        readonly id: string;
        readonly subjectType: string;
        readonly purpose: string;
        readonly legalBasis: string;
        readonly status: string;
        readonly source: string;
        readonly textVersion: string;
        readonly createdAt: Date;
      }[]
    | null;
  /** null without audit:read. */
  readonly audit:
    | readonly {
        readonly id: number;
        readonly occurredAt: Date;
        readonly actorType: string;
        readonly action: string;
        readonly entityType: string;
      }[]
    | null;
  readonly payment: PaymentTermsDecision & {
    readonly policyVersion: number | null;
    /**
     * Where the payment history comes from. Jobs, invoices, payments and chargebacks are not
     * modelled yet, so the history is empty and prepayment always applies (fail-safe).
     */
    readonly historySource: "NO_ORDER_DATA";
  };
}

const customerIdInput = z.strictObject({ customerId: z.uuid() });

export async function getCustomerDetail(
  ctx: ServiceContext,
  input: unknown,
): Promise<CustomerDetail> {
  const actor = requireActor(ctx.actor);
  requireStaffRead(actor);
  const { customerId } = parseInput(customerIdInput, input);
  const c = schema.customer;
  const [customer] = await ctx.db
    .select({
      id: c.id,
      kind: c.kind,
      displayName: c.displayName,
      companyName: c.companyName,
      status: c.status,
      duplicateReviewStatus: c.duplicateReviewStatus,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })
    .from(c)
    .where(and(eq(c.id, customerId), isNull(c.archivedAt)))
    .limit(1);
  if (customer === undefined) {
    throw new DomainError("NOT_FOUND", "Customer not found");
  }

  const identityRows = await ctx.db
    .selectDistinct({ kind: schema.customerIdentity.kind })
    .from(schema.customerIdentity)
    .where(eq(schema.customerIdentity.customerId, customerId))
    .orderBy(schema.customerIdentity.kind);

  const a = schema.customerAddress;
  const area = schema.serviceArea;
  const addressRows = await ctx.db
    .select({
      id: a.id,
      addressType: a.addressType,
      isPrimary: a.isPrimary,
      street: a.street,
      houseNumber: a.houseNumber,
      postalCode: a.postalCode,
      city: a.city,
      country: a.country,
      geocodingStatus: a.geocodingStatus,
      verificationStatus: a.verificationStatus,
      source: a.source,
      createdAt: a.createdAt,
      hasLocation: sql<boolean>`${a.location} IS NOT NULL`,
      inArea: sql<boolean>`EXISTS (
        SELECT 1 FROM ${area}
        WHERE ${area.active} = true AND (
          (${area.kind} = 'CIRCLE' AND ST_DWithin(${area.center}, ${a.location}, ${area.radiusM})) OR
          (${area.kind} = 'POLYGON' AND ST_Covers(${area.boundary}, ${a.location}))
        )
      )`,
    })
    .from(a)
    .where(and(eq(a.customerId, customerId), isNull(a.archivedAt)))
    .orderBy(desc(a.isPrimary), asc(a.createdAt), asc(a.id));
  const addresses = addressRows.map(({ hasLocation, inArea, ...row }) => ({
    ...row,
    inServiceArea: !hasLocation
      ? ("UNKNOWN" as const)
      : inArea
        ? ("IN_AREA" as const)
        : ("OUTSIDE" as const),
  }));

  const p = schema.property;
  const properties = isAuthorized(actor, "property:read", { customerId })
    ? await ctx.db
        .select({
          id: p.id,
          addressId: p.addressId,
          name: p.name,
          propertyType: p.propertyType,
          areaSqm: p.areaSqm,
          rooms: p.rooms,
          bathrooms: p.bathrooms,
          serviceFrequency: p.serviceFrequency,
          serviceRequirements: p.serviceRequirements,
          notes: p.notes,
          active: p.active,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })
        .from(p)
        .where(and(eq(p.customerId, customerId), isNull(p.archivedAt)))
        .orderBy(desc(p.active), asc(p.createdAt), asc(p.id))
    : null;

  const r = schema.serviceRequest;
  const requestRows = await ctx.db
    .select({
      requestId: r.id,
      leadId: r.leadId,
      leadStatus: schema.lead.status,
      serviceName: schema.serviceCategory.name,
      propertyType: r.propertyType,
      frequency: r.frequency,
      serviceAreaStatus: r.serviceAreaStatus,
      customerAddressId: r.customerAddressId,
      propertyId: r.propertyId,
      createdAt: r.createdAt,
    })
    .from(r)
    .innerJoin(schema.lead, eq(schema.lead.id, r.leadId))
    .innerJoin(schema.serviceCategory, eq(schema.serviceCategory.id, r.serviceCategoryId))
    .where(eq(r.customerId, customerId))
    .orderBy(desc(r.createdAt), desc(r.id))
    .limit(100);
  const leadIds = [...new Set(requestRows.map((row) => row.leadId))];

  const q = schema.quote;
  const quotes = isAuthorized(actor, "quote:read")
    ? await ctx.db
        .select({
          id: q.id,
          status: q.status,
          propertyId: q.propertyId,
          currency: q.currency,
          netCents: q.netCents,
          grossCents: q.grossCents,
          validUntil: q.validUntil,
          createdAt: q.createdAt,
          updatedAt: q.updatedAt,
        })
        .from(q)
        .where(eq(q.customerId, customerId))
        .orderBy(desc(q.createdAt), desc(q.id))
        .limit(100)
    : null;

  const showAccountEmail = isAuthorized(actor, "customer:update", { customerId });
  const accountRows = await ctx.db
    .select({
      userId: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      emailVerified: schema.user.emailVerified,
      isScopeAdmin: schema.userRole.isScopeAdmin,
      linkedAt: schema.userRole.createdAt,
    })
    .from(schema.userRole)
    .innerJoin(schema.user, eq(schema.user.id, schema.userRole.userId))
    .where(
      and(eq(schema.userRole.customerId, customerId), eq(schema.userRole.roleKey, "CUSTOMER")),
    )
    .orderBy(asc(schema.userRole.createdAt));
  const accounts = accountRows.map((row) => ({
    ...row,
    email: showAccountEmail ? row.email : null,
  }));

  const lc = schema.leadContact;
  const contactRows =
    leadIds.length === 0
      ? []
      : await ctx.db
          .select({
            id: lc.id,
            leadId: lc.leadId,
            fullName: lc.fullName,
            email: lc.email,
            phone: lc.phone,
            consentStatus: lc.consentStatus,
            suppressed: lc.suppressed,
          })
          .from(lc)
          .where(inArray(lc.leadId, leadIds))
          .orderBy(asc(lc.createdAt), asc(lc.id));
  const contactIds = contactRows.map((row) => row.id);

  let consents: CustomerDetail["consents"] = null;
  if (isAuthorized(actor, "consent:read")) {
    const subject = or(
      and(eq(schema.consent.subjectType, "CUSTOMER"), eq(schema.consent.subjectId, customerId)),
      contactIds.length === 0
        ? undefined
        : and(
            eq(schema.consent.subjectType, "LEAD_CONTACT"),
            inArray(schema.consent.subjectId, contactIds),
          ),
    );
    consents = await ctx.db
      .select({
        id: schema.consent.id,
        subjectType: schema.consent.subjectType,
        purpose: schema.consent.purpose,
        legalBasis: schema.consent.legalBasis,
        status: schema.consent.status,
        source: schema.consent.source,
        textVersion: schema.consent.textVersion,
        createdAt: schema.consent.createdAt,
      })
      .from(schema.consent)
      .where(subject)
      .orderBy(desc(schema.consent.createdAt), desc(schema.consent.id))
      .limit(100);
  }

  let audit: CustomerDetail["audit"] = null;
  if (isAuthorized(actor, "audit:read")) {
    const entityIds = [
      customerId,
      ...addresses.map((row) => row.id),
      ...(properties ?? []).map((row) => row.id),
      ...(quotes ?? []).map((row) => row.id),
    ];
    audit = await ctx.db
      .select({
        id: schema.auditLog.id,
        occurredAt: schema.auditLog.occurredAt,
        actorType: schema.auditLog.actorType,
        action: schema.auditLog.action,
        entityType: schema.auditLog.entityType,
      })
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.entityId, entityIds))
      .orderBy(desc(schema.auditLog.occurredAt), desc(schema.auditLog.id))
      .limit(100);
  }

  const policy = await getEffectiveSetting(ctx.db, "payment.policy", GLOBAL_SCOPE, ctx.clock.now());
  const decision = evaluatePaymentTerms(historyWithoutOrders(customer), policy.value);

  return {
    customer: { ...customer, identityKinds: identityRows.map((row) => row.kind) },
    addresses,
    properties,
    requests: isAuthorized(actor, "lead:read") ? requestRows : null,
    quotes,
    accounts,
    contacts: isAuthorized(actor, "lead_contact:read") ? contactRows : null,
    consents,
    audit,
    payment: { ...decision, policyVersion: policy.version, historySource: "NO_ORDER_DATA" },
  };
}
