import { authorize, type ServiceContext } from "@isela/auth";
import { and, countDistinct, eq, gte, inArray, lt, schema, sql } from "@isela/database";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";

/*
 * Conversion report (day 7). Every figure is either counted from real domain records
 * (database) or explicitly "not measured" – nothing is estimated, sampled or invented.
 * Ratios are only computed when both figures are measured and the denominator is > 0.
 */

/** Where a metric comes from. NOT_MEASURED = no source exists (e.g. no analytics provider). */
export type MetricSource = "DATABASE" | "NOT_MEASURED";

export interface Metric {
  readonly key: ConversionMetricKey;
  readonly value: number | null;
  readonly source: MetricSource;
}

export const CONVERSION_METRIC_KEYS = [
  "pageVisits",
  "requestsStarted",
  "requestsSubmitted",
  "callbacksRequested",
  "qualifiedLeads",
  "quotesSent",
  "quotesAccepted",
  "bookingsCreated",
  "paidBookings",
  "repeatCustomers",
] as const;
export type ConversionMetricKey = (typeof CONVERSION_METRIC_KEYS)[number];

export interface Ratio {
  readonly key: "quoteAcceptance" | "requestToQualified";
  readonly numerator: ConversionMetricKey;
  readonly denominator: ConversionMetricKey;
  /** null when a figure is not measured or the denominator is zero. */
  readonly value: number | null;
}

/**
 * Operator-declared kind of data in this installation. Only "production" counts as real
 * business data; everything else is labelled as test/demo data in the report.
 */
export type DataEnvironment = "production" | "staging" | "development" | "test";

export interface ConversionReport {
  readonly from: Date;
  readonly to: Date;
  readonly environment: DataEnvironment;
  readonly realData: boolean;
  readonly metrics: readonly Metric[];
  readonly ratios: readonly Ratio[];
}

/** Maximum report range (keeps the queries bounded). */
export const MAX_REPORT_DAYS = 400;

const reportInput = z
  .strictObject({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((r) => r.from.getTime() < r.to.getTime(), {
    message: "from must be before to",
    path: ["to"],
  })
  .refine((r) => r.to.getTime() - r.from.getTime() <= MAX_REPORT_DAYS * 86_400_000, {
    message: "range too long",
    path: ["from"],
  });

/** Website-originated leads (form and callback share the internal website source). */
const WEBSITE_SOURCE_KEY = "internal-website-form";
const QUALIFIED_STATUSES = ["QUALIFIED", "QUALIFIED_OPPORTUNITY"] as const;

function ratio(
  key: Ratio["key"],
  numerator: ConversionMetricKey,
  denominator: ConversionMetricKey,
  metrics: ReadonlyMap<ConversionMetricKey, Metric>,
): Ratio {
  const n = metrics.get(numerator);
  const d = metrics.get(denominator);
  const value =
    n?.value === null || n === undefined || d?.value === null || d === undefined || d.value === 0
      ? null
      : n.value / d.value;
  return { key, numerator, denominator, value };
}

export async function getConversionReport(
  ctx: ServiceContext,
  input: unknown,
  options: { readonly environment: DataEnvironment },
): Promise<ConversionReport> {
  authorize(ctx.actor, "report:read");
  const { from, to } = parseInput(reportInput, input);
  if (to.getTime() > ctx.clock.now().getTime() + 86_400_000) {
    throw new DomainError("VALIDATION_FAILED", "Report range lies in the future", {
      issues: [{ path: "to", code: "custom" }],
    });
  }
  const db = ctx.db;
  const inRange = (column: Parameters<typeof gte>[0]) => and(gte(column, from), lt(column, to));

  const sr = schema.serviceRequest;
  const [requests] = await db
    .select({ n: countDistinct(sr.id) })
    .from(sr)
    .where(inRange(sr.createdAt));

  const cb = schema.callbackRequest;
  const [callbacks] = await db
    .select({ n: countDistinct(cb.id) })
    .from(cb)
    .where(inRange(cb.createdAt));

  const t = schema.leadStatusTransition;
  const [qualified] = await db
    .select({ n: countDistinct(t.leadId) })
    .from(t)
    .innerJoin(schema.lead, eq(schema.lead.id, t.leadId))
    .innerJoin(schema.leadSource, eq(schema.leadSource.id, schema.lead.sourceId))
    .where(
      and(
        inRange(t.createdAt),
        inArray(t.toStatus, [...QUALIFIED_STATUSES]),
        eq(schema.leadSource.key, WEBSITE_SOURCE_KEY),
      ),
    );

  const q = schema.quote;
  const [sent] = await db
    .select({ n: countDistinct(q.id) })
    .from(q)
    .where(inRange(q.sentAt));
  const [accepted] = await db
    .select({ n: countDistinct(q.id) })
    .from(q)
    .where(and(eq(q.status, "ACCEPTED"), inRange(q.decidedAt)));

  const b = schema.booking;
  const [bookings] = await db
    .select({ n: countDistinct(b.id) })
    .from(b)
    .where(inRange(b.createdAt));

  const inv = schema.invoice;
  const [paid] = await db
    .select({ n: countDistinct(inv.bookingId) })
    .from(inv)
    .where(and(eq(inv.status, "PAID"), inRange(inv.paidAt)));

  // Repeat customers: customers with a non-cancelled booking created in the range AND at
  // least one earlier non-cancelled booking.
  const [repeat] = await db
    .select({ n: countDistinct(b.customerId) })
    .from(b)
    .where(
      and(
        inRange(b.createdAt),
        sql`${b.status} <> 'CANCELLED'`,
        sql`EXISTS (
          SELECT 1 FROM ${schema.booking} AS earlier
          WHERE earlier.customer_id = ${b.customerId}
            AND earlier.status <> 'CANCELLED'
            AND earlier.created_at < ${b.createdAt}
        )`,
      ),
    );

  const counted = (key: ConversionMetricKey, value: number | undefined): Metric => ({
    key,
    value: value ?? 0,
    source: "DATABASE",
  });
  const metrics: Metric[] = [
    // No analytics provider is approved yet: visits and form starts are NOT measured.
    { key: "pageVisits", value: null, source: "NOT_MEASURED" },
    { key: "requestsStarted", value: null, source: "NOT_MEASURED" },
    counted("requestsSubmitted", requests?.n),
    counted("callbacksRequested", callbacks?.n),
    counted("qualifiedLeads", qualified?.n),
    counted("quotesSent", sent?.n),
    counted("quotesAccepted", accepted?.n),
    counted("bookingsCreated", bookings?.n),
    counted("paidBookings", paid?.n),
    counted("repeatCustomers", repeat?.n),
  ];
  const byKey = new Map(metrics.map((m) => [m.key, m]));
  return {
    from,
    to,
    environment: options.environment,
    realData: options.environment === "production",
    metrics,
    ratios: [
      ratio("requestToQualified", "qualifiedLeads", "requestsSubmitted", byKey),
      ratio("quoteAcceptance", "quotesAccepted", "quotesSent", byKey),
    ],
  };
}
