import { leadListQuerySchema, type LeadListQuery } from "@isela/crm";

/**
 * Translates URL search params of /admin/leads into a validated lead query. Unknown params
 * are ignored, values are validated by the domain schema (bounded pagination); an invalid
 * combination falls back to the default first page and is reported to the UI.
 */

type Params = Record<string, string | string[] | undefined>;

const SINGLE_KEYS = [
  "customerType",
  "serviceCategoryKey",
  "serviceAreaId",
  "availability",
  "sourceKey",
  "createdFrom",
  "createdTo",
  "q",
] as const;

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v;
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return /^\d{1,6}$/.test(value) ? Number(value) : Number.NaN;
}

export interface ParsedLeadFilters {
  readonly query: LeadListQuery;
  readonly invalid: boolean;
}

export function leadQueryFromSearchParams(params: Params): ParsedLeadFilters {
  const raw: Record<string, unknown> = {};
  for (const key of SINGLE_KEYS) {
    const value = first(params[key]);
    if (value !== undefined) raw[key] = value;
  }
  const statusParam = params["status"];
  const statuses = (Array.isArray(statusParam) ? statusParam : [statusParam]).filter(
    (s): s is string => typeof s === "string" && s !== "",
  );
  if (statuses.length > 0) raw["status"] = statuses;
  const page = toInt(first(params["page"]));
  const pageSize = toInt(first(params["pageSize"]));
  if (page !== undefined) raw["page"] = page;
  if (pageSize !== undefined) raw["pageSize"] = pageSize;

  const parsed = leadListQuerySchema.safeParse(raw);
  return parsed.success
    ? { query: parsed.data, invalid: false }
    : { query: { page: 1, pageSize: 25 }, invalid: true };
}

/** Builds the query string for pagination links (only set filters, validated values). */
export function leadQueryString(query: LeadListQuery, page: number): string {
  const params = new URLSearchParams();
  for (const key of SINGLE_KEYS) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  for (const status of query.status ?? []) params.append("status", status);
  if (query.pageSize !== undefined && query.pageSize !== 25) {
    params.set("pageSize", String(query.pageSize));
  }
  params.set("page", String(page));
  return params.toString();
}
