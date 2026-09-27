import { authorize, isAuthorized, requireActor, type ServiceContext } from "@isela/auth";
import {
  and,
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
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import { LEAD_STATUSES, LEAD_TRANSITIONS, type LeadStatus } from "./lead-state-machine.ts";
import { REQUEST_CUSTOMER_TYPES } from "./service-requests.ts";

/*
 * Back-office read models for leads. All filters are validated (Zod) and translated into
 * parameterised Drizzle expressions – there is no string-built SQL. Pagination is mandatory
 * and bounded. Lists show minimal personal data (name only, no e-mail/phone).
 */

const slug = z
  .string()
  .trim()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const isoDate = z.iso.date();

export const LEAD_PAGE_SIZE_MAX = 50;

export const leadListQuerySchema = z
  .strictObject({
    status: z.array(z.enum(LEAD_STATUSES)).max(LEAD_STATUSES.length).optional(),
    customerType: z.enum(REQUEST_CUSTOMER_TYPES).optional(),
    serviceCategoryKey: slug.optional(),
    serviceAreaId: z.uuid().optional(),
    availability: z.enum(["AVAILABLE", "NOT_AVAILABLE", "UNKNOWN"]).optional(),
    sourceKey: slug.optional(),
    createdFrom: isoDate.optional(),
    createdTo: isoDate.optional(),
    q: z.string().trim().min(1).max(100).optional(),
    page: z.number().int().min(1).max(10_000).default(1),
    pageSize: z.number().int().min(1).max(LEAD_PAGE_SIZE_MAX).default(25),
  })
  .refine(
    (f) => f.createdFrom === undefined || f.createdTo === undefined || f.createdFrom <= f.createdTo,
    {
      message: "createdFrom must not be after createdTo",
      path: ["createdFrom"],
    },
  );

export type LeadListQuery = z.input<typeof leadListQuerySchema>;

export interface LeadListItem {
  readonly id: string;
  readonly status: LeadStatus;
  readonly sourceName: string;
  readonly customerType: (typeof REQUEST_CUSTOMER_TYPES)[number] | null;
  /** Contact name only (null without lead_contact:read). */
  readonly contactName: string | null;
  readonly companyName: string;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly serviceName: string | null;
  readonly availability: "AVAILABLE" | "NOT_AVAILABLE" | "UNKNOWN" | null;
  readonly score: number | null;
  readonly createdAt: Date;
}

export interface LeadListPage {
  readonly items: readonly LeadListItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/** Escapes LIKE wildcards so user search text is matched literally. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function nextDay(date: string): Date {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export async function listLeads(ctx: ServiceContext, input: unknown): Promise<LeadListPage> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "lead:read");
  const f = parseInput(leadListQuerySchema, input ?? {});
  const lead = schema.lead;
  const request = schema.serviceRequest;
  const category = schema.serviceCategory;
  const source = schema.leadSource;
  const contact = schema.leadContact;

  const conditions: SQL[] = [isNull(lead.archivedAt)];
  if (f.status !== undefined && f.status.length > 0)
    conditions.push(inArray(lead.status, f.status));
  if (f.customerType !== undefined) conditions.push(eq(request.customerType, f.customerType));
  if (f.serviceCategoryKey !== undefined) conditions.push(eq(category.key, f.serviceCategoryKey));
  if (f.serviceAreaId !== undefined) conditions.push(eq(request.serviceAreaId, f.serviceAreaId));
  if (f.availability !== undefined) conditions.push(eq(request.serviceAreaStatus, f.availability));
  if (f.sourceKey !== undefined) conditions.push(eq(source.key, f.sourceKey));
  if (f.createdFrom !== undefined) {
    conditions.push(gte(lead.createdAt, new Date(`${f.createdFrom}T00:00:00.000Z`)));
  }
  if (f.createdTo !== undefined) conditions.push(lt(lead.createdAt, nextDay(f.createdTo)));
  if (f.q !== undefined) {
    const idMatch = z.uuid().safeParse(f.q);
    if (idMatch.success) {
      conditions.push(eq(lead.id, idMatch.data));
    } else {
      const pattern = likePattern(f.q);
      const contactMatch = exists(
        ctx.db
          .select({ one: sql`1` })
          .from(contact)
          .where(
            and(
              eq(contact.leadId, lead.id),
              or(ilike(contact.fullName, pattern), ilike(contact.email, pattern)),
            ),
          ),
      );
      const searchCondition = or(ilike(lead.companyName, pattern), contactMatch);
      if (searchCondition !== undefined) conditions.push(searchCondition);
    }
  }
  const where = and(...conditions);

  const showContactName = isAuthorized(actor, "lead_contact:read");
  const contactName = sql<string | null>`(
    SELECT ${contact.fullName} FROM ${contact}
    WHERE ${contact.leadId} = ${lead.id}
    ORDER BY ${contact.createdAt} ASC, ${contact.id} ASC LIMIT 1
  )`;

  const [totalRow] = await ctx.db
    .select({ total: count() })
    .from(lead)
    .innerJoin(source, eq(source.id, lead.sourceId))
    .leftJoin(request, eq(request.leadId, lead.id))
    .leftJoin(category, eq(category.id, request.serviceCategoryId))
    .where(where);

  const rows = await ctx.db
    .select({
      id: lead.id,
      status: lead.status,
      sourceName: source.name,
      customerType: request.customerType,
      contactName,
      companyName: lead.companyName,
      postalCode: lead.postalCode,
      city: lead.city,
      serviceName: category.name,
      availability: request.serviceAreaStatus,
      score: lead.score,
      createdAt: lead.createdAt,
    })
    .from(lead)
    .innerJoin(source, eq(source.id, lead.sourceId))
    .leftJoin(request, eq(request.leadId, lead.id))
    .leftJoin(category, eq(category.id, request.serviceCategoryId))
    .where(where)
    .orderBy(desc(lead.createdAt), desc(lead.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);

  return {
    items: rows.map((row) => ({ ...row, contactName: showContactName ? row.contactName : null })),
    total: totalRow?.total ?? 0,
    page: f.page,
    pageSize: f.pageSize,
  };
}

/** Transitions offered in the UI; the state machine re-validates on submit. */
export function offeredTransitions(status: LeadStatus, sourceKind: string): readonly LeadStatus[] {
  return LEAD_TRANSITIONS[status].filter(
    (to) =>
      !(status === "DISCOVERED" && to === "QUOTE_REQUEST" && sourceKind !== "INTERNAL_INBOUND"),
  );
}

const leadIdInput = z.strictObject({ leadId: z.uuid() });

export interface LeadDetail {
  readonly lead: {
    readonly id: string;
    readonly status: LeadStatus;
    readonly companyName: string;
    readonly segment: string | null;
    readonly score: number | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly source: { readonly key: string; readonly name: string; readonly kind: string };
  };
  readonly request: {
    readonly id: string;
    readonly customerType: (typeof REQUEST_CUSTOMER_TYPES)[number];
    readonly serviceName: string;
    readonly propertyType: string;
    readonly approximateAreaSqm: number | null;
    readonly frequency: string;
    readonly numberOfProperties: number | null;
    readonly message: string | null;
    readonly street: string;
    readonly houseNumber: string;
    readonly postalCode: string;
    readonly city: string;
    readonly country: string;
    readonly latitude: number | null;
    readonly longitude: number | null;
    readonly geocodingStatus: string;
    readonly serviceAreaStatus: "AVAILABLE" | "NOT_AVAILABLE" | "UNKNOWN";
    readonly serviceAreaName: string | null;
    readonly serviceAreaCheckedAt: Date | null;
    readonly privacyNoticeVersion: string;
    readonly privacyNoticeAcknowledgedAt: Date;
    readonly customerId: string | null;
    readonly customerName: string | null;
  } | null;
  /** null without lead_contact:read. */
  readonly contacts:
    | readonly {
        readonly id: string;
        readonly fullName: string;
        readonly email: string | null;
        readonly phone: string | null;
        readonly legalBasis: string;
        readonly consentStatus: string;
        readonly suppressed: boolean;
      }[]
    | null;
  readonly geocoding: readonly {
    readonly id: string;
    readonly provider: string;
    readonly outcome: string;
    readonly precision: string | null;
    readonly confidence: number | null;
    readonly normalizedAddress: string | null;
    readonly region: string | null;
    readonly reasons: readonly string[];
    readonly byStaff: boolean;
    readonly createdAt: Date;
  }[];
  /** null without consent:read. */
  readonly consents:
    | readonly {
        readonly id: string;
        readonly subjectId: string;
        readonly purpose: string;
        readonly legalBasis: string;
        readonly status: string;
        readonly source: string;
        readonly textVersion: string;
        readonly createdAt: Date;
      }[]
    | null;
  readonly history: readonly {
    readonly fromStatus: LeadStatus;
    readonly toStatus: LeadStatus;
    readonly actorName: string | null;
    readonly reason: string | null;
    readonly createdAt: Date;
  }[];
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
  readonly allowedTransitions: readonly LeadStatus[];
}

export async function getLeadDetail(ctx: ServiceContext, input: unknown): Promise<LeadDetail> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "lead:read");
  const { leadId } = parseInput(leadIdInput, input);
  const l = schema.lead;
  const src = schema.leadSource;
  const [lead] = await ctx.db
    .select({
      id: l.id,
      status: l.status,
      companyName: l.companyName,
      segment: l.segment,
      score: l.score,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      sourceKey: src.key,
      sourceName: src.name,
      sourceKind: src.providerKind,
    })
    .from(l)
    .innerJoin(src, eq(src.id, l.sourceId))
    .where(and(eq(l.id, leadId), isNull(l.archivedAt)))
    .limit(1);
  if (lead === undefined) {
    throw new DomainError("NOT_FOUND", "Lead not found");
  }

  const r = schema.serviceRequest;
  const [request] = await ctx.db
    .select({
      id: r.id,
      customerType: r.customerType,
      serviceName: schema.serviceCategory.name,
      propertyType: r.propertyType,
      approximateAreaSqm: r.approximateAreaSqm,
      frequency: r.frequency,
      numberOfProperties: r.numberOfProperties,
      message: r.message,
      street: r.street,
      houseNumber: r.houseNumber,
      postalCode: r.postalCode,
      city: r.city,
      country: r.country,
      latitude: r.latitude,
      longitude: r.longitude,
      geocodingStatus: r.geocodingStatus,
      serviceAreaStatus: r.serviceAreaStatus,
      serviceAreaName: schema.serviceArea.name,
      serviceAreaCheckedAt: r.serviceAreaCheckedAt,
      privacyNoticeVersion: r.privacyNoticeVersion,
      privacyNoticeAcknowledgedAt: r.privacyNoticeAcknowledgedAt,
      customerId: r.customerId,
      customerName: schema.customer.displayName,
    })
    .from(r)
    .innerJoin(schema.serviceCategory, eq(schema.serviceCategory.id, r.serviceCategoryId))
    .leftJoin(schema.serviceArea, eq(schema.serviceArea.id, r.serviceAreaId))
    .leftJoin(schema.customer, eq(schema.customer.id, r.customerId))
    .where(eq(r.leadId, leadId))
    .limit(1);

  const c = schema.leadContact;
  const contactRows = await ctx.db
    .select({
      id: c.id,
      fullName: c.fullName,
      email: c.email,
      phone: c.phone,
      legalBasis: c.legalBasis,
      consentStatus: c.consentStatus,
      suppressed: c.suppressed,
    })
    .from(c)
    .where(eq(c.leadId, leadId))
    .orderBy(c.createdAt, c.id);
  const contactIds = contactRows.map((row) => row.id);

  const a = schema.geocodingAttempt;
  const geocodingRows =
    request === undefined
      ? []
      : await ctx.db
          .select()
          .from(a)
          .where(eq(a.serviceRequestId, request.id))
          .orderBy(desc(a.createdAt), desc(a.id))
          .limit(20);

  const consentRows =
    isAuthorized(actor, "consent:read") && contactIds.length > 0
      ? await ctx.db
          .select({
            id: schema.consent.id,
            subjectId: schema.consent.subjectId,
            purpose: schema.consent.purpose,
            legalBasis: schema.consent.legalBasis,
            status: schema.consent.status,
            source: schema.consent.source,
            textVersion: schema.consent.textVersion,
            createdAt: schema.consent.createdAt,
          })
          .from(schema.consent)
          .where(
            and(
              eq(schema.consent.subjectType, "LEAD_CONTACT"),
              inArray(schema.consent.subjectId, contactIds),
            ),
          )
          .orderBy(desc(schema.consent.createdAt), desc(schema.consent.id))
      : isAuthorized(actor, "consent:read")
        ? []
        : null;

  const t = schema.leadStatusTransition;
  const history = await ctx.db
    .select({
      fromStatus: t.fromStatus,
      toStatus: t.toStatus,
      actorName: schema.user.name,
      reason: t.reason,
      createdAt: t.createdAt,
    })
    .from(t)
    .leftJoin(schema.user, eq(schema.user.id, t.actorUserId))
    .where(eq(t.leadId, leadId))
    .orderBy(desc(t.createdAt), desc(t.id));

  let audit: LeadDetail["audit"] = null;
  if (isAuthorized(actor, "audit:read")) {
    const entityIds = [leadId, ...(request === undefined ? [] : [request.id]), ...contactIds];
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

  return {
    lead: {
      id: lead.id,
      status: lead.status,
      companyName: lead.companyName,
      segment: lead.segment,
      score: lead.score,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      source: { key: lead.sourceKey, name: lead.sourceName, kind: lead.sourceKind },
    },
    request: request ?? null,
    contacts: isAuthorized(actor, "lead_contact:read") ? contactRows : null,
    geocoding: geocodingRows.map((row) => ({
      id: row.id,
      provider: row.provider,
      outcome: row.outcome,
      precision: row.precision,
      confidence: row.confidence,
      normalizedAddress:
        row.street === null && row.city === null
          ? null
          : [
              [row.street, row.houseNumber].filter((v) => v !== null).join(" "),
              [row.postalCode, row.city].filter((v) => v !== null).join(" "),
            ]
              .filter((v) => v !== "")
              .join(", "),
      region: row.region,
      reasons: row.reasons,
      byStaff: row.performedByUserId !== null,
      createdAt: row.createdAt,
    })),
    consents: consentRows,
    history,
    audit,
    allowedTransitions: isAuthorized(actor, "lead:transition")
      ? offeredTransitions(lead.status, lead.sourceKind)
      : [],
  };
}

/** Lead sources for the back-office filter (requires lead:read). */
export async function listLeadSourceOptions(
  ctx: ServiceContext,
): Promise<{ key: string; name: string }[]> {
  authorize(ctx.actor, "lead:read");
  return ctx.db
    .select({ key: schema.leadSource.key, name: schema.leadSource.name })
    .from(schema.leadSource)
    .orderBy(schema.leadSource.name);
}
