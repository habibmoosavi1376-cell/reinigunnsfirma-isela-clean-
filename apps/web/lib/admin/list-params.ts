/**
 * Shared parsing of back-office list search params. Values are only pre-shaped here; the
 * domain schemas validate them (bounded pagination, enums, uuids). An invalid combination
 * falls back to the first page and is reported to the UI.
 */

export type SearchParams = Record<string, string | string[] | undefined>;

export function firstParam(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return /^\d{1,6}$/.test(value) ? Number(value) : Number.NaN;
}

export function parseListParams<T>(
  params: SearchParams,
  keys: readonly string[],
  schema: {
    safeParse(input: unknown): { success: true; data: T } | { success: false };
  },
): { query: T | null; raw: Record<string, string> } {
  const raw: Record<string, string> = {};
  const input: Record<string, unknown> = {};
  for (const key of keys) {
    const value = firstParam(params[key]);
    if (value !== undefined) {
      raw[key] = value;
      input[key] = value;
    }
  }
  for (const key of ["page", "pageSize"] as const) {
    const value = toInt(firstParam(params[key]));
    if (value !== undefined) input[key] = value;
  }
  const parsed = schema.safeParse(input);
  return { query: parsed.success ? parsed.data : null, raw };
}

/** Query string for pagination links (only the validated filter values). */
export function listQueryString(
  filters: Record<string, string | number | undefined>,
  page: number,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && key !== "page" && key !== "pageSize") {
      params.set(key, String(value));
    }
  }
  params.set("page", String(page));
  return params.toString();
}
