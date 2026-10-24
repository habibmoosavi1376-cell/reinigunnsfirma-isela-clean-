import { describe, expect, it, vi } from "vitest";
import { callbackRequestInputSchema, serviceRequestInputSchema } from "@isela/crm";
import {
  CONSENT_MAX_AGE_SECONDS,
  NO_CONSENT,
  hasConsent,
  parseConsentCookie,
  serializeConsentCookie,
} from "@/lib/analytics/consent";
import {
  ANALYTICS_EVENT_NAMES,
  sanitizeAnalyticsEvent,
  sanitizePath,
} from "@/lib/analytics/events";
import {
  NOOP_ANALYTICS_PROVIDER,
  analyticsProviderFor,
  trackEvent,
  type AnalyticsProvider,
} from "@/lib/analytics/provider";
import { parseReportRange } from "@/lib/admin/report-range";
import {
  callbackFieldErrors,
  echoCallbackFormValues,
  mapCallbackForm,
} from "@/lib/forms/callback-form";
import { mapRequestForm } from "@/lib/forms/request-form";
import { classifyRoute } from "@/lib/routing/route-access";
import {
  buildBreadcrumbJsonLd,
  buildServiceJsonLd,
  excerpt,
  pageSeo,
  serializeJsonLd,
} from "@/lib/seo/seo";
import { DISALLOWED_PATHS, STATIC_SITEMAP_PATHS, buildSitemapPaths } from "@/lib/seo/sitemap";

const NOW = new Date("2026-10-13T12:00:00Z");
const BASE = "https://www.example.test";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function testProvider(): AnalyticsProvider & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    id: "test",
    enabled: true,
    purpose: "statistics",
    sent,
    send: (event) => {
      sent.push(event);
      return Promise.resolve();
    },
  };
}

describe("analytics events", () => {
  it("defines exactly the agreed events", () => {
    expect(ANALYTICS_EVENT_NAMES).toEqual([
      "page_view",
      "service_view",
      "request_started",
      "request_submitted",
      "callback_requested",
      "quote_viewed",
      "quote_accepted",
    ]);
  });

  it("accepts allowlisted properties only and drops the whole event otherwise", () => {
    expect(
      sanitizeAnalyticsEvent({
        name: "service_view",
        path: "/leistungen/bueroreinigung",
        serviceSlug: "bueroreinigung",
      }),
    ).toEqual({
      name: "service_view",
      path: "/leistungen/bueroreinigung",
      serviceSlug: "bueroreinigung",
    });
    expect(
      sanitizeAnalyticsEvent({ name: "request_submitted", email: "a@example.test" }),
    ).toBeNull();
    expect(sanitizeAnalyticsEvent({ name: "request_submitted", phone: "+4930123" })).toBeNull();
    expect(sanitizeAnalyticsEvent({ name: "unknown" })).toBeNull();
    expect(sanitizeAnalyticsEvent({ name: "page_view", customerType: "VIP" })).toBeNull();
    expect(sanitizeAnalyticsEvent({ name: "page_view", serviceSlug: "<script>" })).toBeNull();
    expect(sanitizeAnalyticsEvent(null)).toBeNull();
  });

  it("strips query strings, fragments and identifiers from paths", () => {
    expect(sanitizePath("https://x.test/anfrage?email=a@b.de#top")).toBe("/anfrage");
    expect(sanitizePath("/customer/quotes/2f1b8a3e-1b2c-4d5e-8f90-123456789abc")).toBe(
      "/customer/quotes/:id",
    );
    expect(sanitizePath("/customer/invoices/12345")).toBe("/customer/invoices/:id");
    expect(sanitizePath("/x/Max%20Mustermann")).toBe("/x/:id");
    expect(sanitizePath("/%E0%A4%A")).toBe("/:id");
  });
});

describe("consent", () => {
  it("means no consent without a valid decision", () => {
    expect(parseConsentCookie(undefined, NOW)).toEqual(NO_CONSENT);
    expect(parseConsentCookie("v1.1.1", NOW)).toEqual(NO_CONSENT);
    expect(parseConsentCookie("statistics=1", NOW)).toEqual(NO_CONSENT);
    expect(hasConsent(NO_CONSENT, "statistics")).toBe(false);
  });

  it("round-trips a decision and expires it after 12 months", () => {
    const value = serializeConsentCookie({ statistics: true, marketing: false }, NOW);
    const state = parseConsentCookie(value, NOW);
    expect(hasConsent(state, "statistics")).toBe(true);
    expect(hasConsent(state, "marketing")).toBe(false);
    const later = new Date(NOW.getTime() + (CONSENT_MAX_AGE_SECONDS + 1) * 1000);
    expect(parseConsentCookie(value, later)).toEqual(NO_CONSENT);
    const future = serializeConsentCookie(
      { statistics: true, marketing: true },
      new Date(NOW.getTime() + 86_400_000),
    );
    expect(parseConsentCookie(future, NOW)).toEqual(NO_CONSENT);
  });
});

describe("analytics dispatch", () => {
  const granted = parseConsentCookie(
    serializeConsentCookie({ statistics: true, marketing: false }, NOW),
    NOW,
  );
  const withdrawn = parseConsentCookie(
    serializeConsentCookie({ statistics: false, marketing: false }, NOW),
    NOW,
  );

  it("is a no-op while no provider is configured, even with consent", async () => {
    const spy = vi.spyOn(NOOP_ANALYTICS_PROVIDER, "send");
    expect(analyticsProviderFor("none")).toBe(NOOP_ANALYTICS_PROVIDER);
    expect(await trackEvent(NOOP_ANALYTICS_PROVIDER, granted, { name: "page_view" })).toBe(
      "NO_PROVIDER",
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends nothing without consent", async () => {
    const provider = testProvider();
    expect(await trackEvent(provider, NO_CONSENT, { name: "page_view", path: "/" })).toBe(
      "NO_CONSENT",
    );
    expect(provider.sent).toEqual([]);
  });

  it("sends with consent and stops immediately after withdrawal", async () => {
    const provider = testProvider();
    expect(await trackEvent(provider, granted, { name: "page_view", path: "/?x=1" })).toBe("SENT");
    expect(provider.sent).toEqual([{ name: "page_view", path: "/" }]);
    expect(await trackEvent(provider, withdrawn, { name: "page_view", path: "/" })).toBe(
      "NO_CONSENT",
    );
    expect(provider.sent).toHaveLength(1);
  });

  it("drops invalid events and never throws", async () => {
    const provider = testProvider();
    expect(await trackEvent(provider, granted, { name: "page_view", email: "x" })).toBe(
      "INVALID_EVENT",
    );
    const failing = { ...testProvider(), send: () => Promise.reject(new Error("down")) };
    expect(await trackEvent(failing, granted, { name: "page_view" })).toBe("FAILED");
  });
});

describe("callback form mapping", () => {
  const complete = {
    customerType: "PRIVATE",
    fullName: "Rückruf Testdaten",
    phone: "+49 30 5551234",
    privacyNoticeAcknowledged: "on",
    submissionToken: "a".repeat(32),
  };

  it("maps a complete form to a valid domain input", () => {
    const { input, isBot } = mapCallbackForm(form(complete));
    expect(isBot).toBe(false);
    expect(callbackRequestInputSchema.safeParse(input).success).toBe(true);
  });

  it("ignores non-whitelisted fields and detects the honeypot", () => {
    const { input } = mapCallbackForm(form({ ...complete, leadId: "x", status: "WON" }));
    expect(input).not.toHaveProperty("leadId");
    expect(input).not.toHaveProperty("status");
    expect(mapCallbackForm(form({ ...complete, website: "spam" })).isBot).toBe(true);
  });

  it("requires the privacy acknowledgement and a valid phone", () => {
    const { input } = mapCallbackForm(
      form({ ...complete, privacyNoticeAcknowledged: "", phone: "abc" }),
    );
    const parsed = callbackRequestInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(callbackFieldErrors([{ path: "phone" }])["phone"]).toMatch(/Telefonnummer/);
  });

  it("echoes only whitelisted, capped values (no honeypot)", () => {
    const values = echoCallbackFormValues(
      form({ ...complete, website: "spam", message: "x".repeat(900) }),
    );
    expect(values).not.toHaveProperty("website");
    expect(values.message).toHaveLength(600);
  });

  it("passes the request form token through and the schema rejects malformed tokens", () => {
    const base = {
      customerType: "PRIVATE",
      fullName: "Erika Muster",
      email: "erika@example.test",
      street: "Musterweg",
      houseNumber: "3",
      postalCode: "12345",
      city: "Musterstadt",
      serviceCategoryKey: "apartment-cleaning",
      propertyType: "APARTMENT",
      frequency: "ONCE",
      privacyNoticeAcknowledged: "on",
    };
    const ok = mapRequestForm(form({ ...base, submissionToken: "b".repeat(32) })).input;
    expect(serviceRequestInputSchema.safeParse(ok).success).toBe(true);
    const bad = mapRequestForm(
      form({ ...base, submissionToken: "<script>alert(1)</script>xxxxxxx" }),
    ).input;
    expect(serviceRequestInputSchema.safeParse(bad).success).toBe(false);
  });
});

describe("SEO metadata", () => {
  it("builds unique canonical URLs without query or trailing slash and honours noindex", () => {
    const seo = pageSeo({
      baseUrl: BASE,
      path: "/leistungen/?utm=1",
      title: "Leistungen",
      description: "D",
    });
    expect(seo.alternates.canonical).toBe("https://www.example.test/leistungen");
    expect(seo.openGraph.url).toBe(seo.alternates.canonical);
    expect(seo.robots).toEqual({ index: true, follow: true });
    expect(
      pageSeo({ baseUrl: BASE, path: "/x", title: "X", description: "D", indexable: false }).robots,
    ).toEqual({
      index: false,
      follow: true,
    });
  });

  it("builds breadcrumbs and service data without prices or ratings", () => {
    const crumbs = buildBreadcrumbJsonLd(BASE, [
      { name: "Startseite", path: "/" },
      { name: "Leistungen", path: "/leistungen" },
    ]);
    expect(crumbs).toMatchObject({ "@type": "BreadcrumbList" });
    const service = buildServiceJsonLd({
      baseUrl: BASE,
      name: "Büroreinigung",
      description: "Beschreibung",
      path: "/leistungen/bueroreinigung",
      areaServed: [],
    });
    const json = JSON.stringify(service);
    expect(json).not.toMatch(/offers|price|aggregateRating|review|openingHours/i);
    expect(service).not.toHaveProperty("areaServed");
  });

  it("escapes admin-written text inside JSON-LD (XSS)", () => {
    const service = buildServiceJsonLd({
      baseUrl: BASE,
      name: "</script><script>alert(1)</script>",
      description: "x",
      path: "/leistungen/x",
      areaServed: [],
    });
    expect(serializeJsonLd(service)).not.toContain("</script>");
  });

  it("shortens descriptions at a word boundary", () => {
    const text = `${"Wort ".repeat(60)}Ende`;
    const short = excerpt(text, 100);
    expect(short.length).toBeLessThanOrEqual(100);
    expect(short.endsWith("…")).toBe(true);
    expect(excerpt("  kurz \n text ")).toBe("kurz text");
  });
});

describe("sitemap and robots", () => {
  it("lists static pages and only indexable, well-formed service pages", () => {
    const paths = buildSitemapPaths([
      { urlSlug: "bueroreinigung", indexable: true },
      { urlSlug: "fensterreinigung", indexable: false },
      { urlSlug: "../admin", indexable: true },
    ]).map((e) => e.path);
    expect(paths).toContain("/leistungen/bueroreinigung");
    expect(paths).not.toContain("/leistungen/fensterreinigung");
    expect(paths.some((p) => p.includes(".."))).toBe(false);
    expect(paths).toEqual(expect.arrayContaining(STATIC_SITEMAP_PATHS.map((e) => e.path)));
  });

  it("never lists private areas and disallows them in robots.txt", () => {
    const paths = buildSitemapPaths([{ urlSlug: "x", indexable: true }]).map((e) => e.path);
    for (const prefix of DISALLOWED_PATHS) {
      expect(paths.some((p) => p.startsWith(prefix.replace(/\/$/, "")))).toBe(false);
    }
    expect(DISALLOWED_PATHS).toEqual(
      expect.arrayContaining(["/admin", "/customer", "/team", "/account"]),
    );
    expect(paths).not.toContain("/datenschutz/einstellungen");
  });

  it("classifies the new public pages as public and the reports page as protected", () => {
    for (const path of [
      "/leistungen",
      "/leistungen/bueroreinigung",
      "/rueckruf",
      "/datenschutz/einstellungen",
    ]) {
      expect(classifyRoute(path)).toEqual({ kind: "public" });
    }
    expect(classifyRoute("/admin/reports")).toEqual({ kind: "protected", area: "admin" });
  });
});

describe("report range", () => {
  it("defaults to the last 30 days and rejects invalid, reversed, too long or future ranges", () => {
    const range = parseReportRange({}, NOW);
    expect(range.valid).toBe(true);
    expect(range.to.toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(range.from.toISOString()).toBe("2026-09-14T00:00:00.000Z");
    expect(parseReportRange({ from: "2026-10-01", to: "2026-10-05" }, NOW)).toMatchObject({
      valid: true,
    });
    for (const params of [
      { from: "2026-13-01", to: "2026-10-05" },
      { from: "2026-10-05", to: "2026-10-01" },
      { from: "2024-01-01", to: "2026-10-01" },
      { from: "2026-10-01", to: "2027-01-01" },
      { from: "x", to: "y" },
    ]) {
      expect(parseReportRange(params, NOW).valid).toBe(false);
    }
  });

  it("uses business-local days: boundaries at local midnight, today in the local zone", () => {
    // 2026-10-13T22:30Z is already 2026-10-14 in Berlin (F7 regression).
    const lateEvening = new Date("2026-10-13T22:30:00Z");
    const range = parseReportRange({}, lateEvening, 1, 400, "Europe/Berlin");
    expect(range.fromDay).toBe("2026-10-14");
    expect(range.lastDay).toBe("2026-10-14");
    expect(range.from.toISOString()).toBe("2026-10-13T22:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-10-14T22:00:00.000Z");
    // The local "today" is selectable, the next local day is rejected as future.
    expect(
      parseReportRange(
        { from: "2026-10-14", to: "2026-10-14" },
        lateEvening,
        30,
        400,
        "Europe/Berlin",
      ).valid,
    ).toBe(true);
    expect(
      parseReportRange(
        { from: "2026-10-15", to: "2026-10-15" },
        lateEvening,
        30,
        400,
        "Europe/Berlin",
      ).valid,
    ).toBe(false);
    // DST end (25-hour day) stays one full local day.
    const dst = parseReportRange(
      { from: "2026-10-25", to: "2026-10-25" },
      new Date("2026-10-30T12:00:00Z"),
      30,
      400,
      "Europe/Berlin",
    );
    expect(dst.to.getTime() - dst.from.getTime()).toBe(25 * 3_600_000);
  });
});

describe("health checks", () => {
  it("reports ready only when the database answers in time, without details", async () => {
    const { checkReadiness, healthResponse } = await import("@/lib/server/health");
    const ok = { execute: () => Promise.resolve({ rows: [{ ok: 1 }] }) };
    const failing = { execute: () => Promise.reject(new Error("connection refused at db:5432")) };
    const hanging = { execute: () => new Promise(() => undefined) };
    type Db = Parameters<typeof checkReadiness>[0];
    expect(await checkReadiness(ok as unknown as Db)).toBe("ok");
    expect(await checkReadiness(failing as unknown as Db)).toBe("unavailable");
    expect(await checkReadiness(hanging as unknown as Db, 20)).toBe("unavailable");
    const response = healthResponse("unavailable");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "unavailable" });
  });
});
