import { describe, expect, it } from "vitest";
import { serviceRequestInputSchema } from "@isela/crm";
import {
  MARKETING_CONSENT_TEXT_VERSION,
  echoRequestFormValues,
  fieldErrorsFromIssues,
  mapRequestForm,
} from "@/lib/forms/request-form";
import {
  buildLandingPath,
  buildOrganizationJsonLd,
  canonicalUrl,
  parseLandingPath,
  serializeJsonLd,
  slugify,
} from "@/lib/seo/seo";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const complete = {
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

describe("request form mapping", () => {
  it("maps a complete form to a valid domain input", () => {
    const { input, isBot } = mapRequestForm(form(complete));
    expect(isBot).toBe(false);
    expect(serviceRequestInputSchema.safeParse(input).success).toBe(true);
  });

  it("drops fields that are not whitelisted (mass assignment)", () => {
    const { input } = mapRequestForm(
      form({ ...complete, leadId: "x", status: "WON", customerId: "y", ownerUserId: "z" }),
    );
    expect(Object.keys(input)).not.toEqual(expect.arrayContaining(["leadId"]));
    expect(input).not.toHaveProperty("status");
    expect(input).not.toHaveProperty("customerId");
    expect(input).not.toHaveProperty("ownerUserId");
  });

  it("detects the honeypot", () => {
    expect(mapRequestForm(form({ ...complete, website: "http://spam.example" })).isBot).toBe(true);
  });

  it("only records marketing consent when the box is ticked, with the text version", () => {
    expect(mapRequestForm(form(complete)).input["marketingConsent"]).toBe(false);
    const withConsent = mapRequestForm(form({ ...complete, marketingConsent: "on" })).input;
    expect(withConsent["marketingConsent"]).toBe(true);
    expect(withConsent["marketingConsentTextVersion"]).toBe(MARKETING_CONSENT_TEXT_VERSION);
  });

  it("produces German field messages without echoing values", () => {
    const messages = fieldErrorsFromIssues([
      { path: "email" },
      { path: "privacyNoticeAcknowledged" },
      { path: "unknown" },
    ]);
    expect(messages["email"]).toMatch(/E-Mail/);
    expect(messages["privacyNoticeAcknowledged"]).toMatch(/Datenschutz/);
    expect(messages["unknown"]).toBeDefined();
  });
});

describe("request and consent validation", () => {
  const base = mapRequestForm(form(complete)).input;
  const parse = (override: Record<string, unknown>) =>
    serviceRequestInputSchema.safeParse({ ...base, ...override });

  it("requires the privacy notice acknowledgement (invalid consent state)", () => {
    expect(parse({ privacyNoticeAcknowledged: false }).success).toBe(false);
    expect(parse({ privacyNoticeAcknowledged: "yes" }).success).toBe(false);
  });

  it("rejects marketing consent without text version", () => {
    expect(parse({ marketingConsent: true }).success).toBe(false);
  });

  it("rejects malformed and oversized input", () => {
    expect(parse({ email: "not-an-email" }).success).toBe(false);
    expect(parse({ postalCode: "ABC" }).success).toBe(false);
    expect(parse({ message: "x".repeat(2001) }).success).toBe(false);
    expect(parse({ fullName: "x".repeat(121) }).success).toBe(false);
    expect(parse({ approximateAreaSqm: -5 }).success).toBe(false);
    expect(parse({ frequency: "DAILY" }).success).toBe(false);
    expect(parse({ serviceCategoryKey: "../../etc" }).success).toBe(false);
  });

  it("requires a company name for business requests", () => {
    expect(parse({ customerType: "BUSINESS" }).success).toBe(false);
    expect(parse({ customerType: "BUSINESS", companyName: "Muster GmbH" }).success).toBe(true);
  });

  it("rejects unknown fields", () => {
    expect(parse({ price: 0 }).success).toBe(false);
  });
});

describe("SEO foundation", () => {
  it("builds canonical URLs without query strings or trailing slashes", () => {
    expect(canonicalUrl("https://www.example.test", "/anfrage/?utm=x")).toBe(
      "https://www.example.test/anfrage",
    );
    expect(canonicalUrl("https://www.example.test", "/")).toBe("https://www.example.test/");
  });

  it("does not invent structured data", () => {
    const minimal = buildOrganizationJsonLd({ baseUrl: "https://www.example.test" });
    expect(minimal).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "ISELA CLEAN",
      url: "https://www.example.test/",
    });
    expect(JSON.stringify(minimal)).not.toMatch(/aggregateRating|review|openingHours/);
  });

  it("escapes JSON-LD for safe embedding", () => {
    expect(serializeJsonLd({ name: "</script><script>alert(1)</script>" })).not.toContain(
      "</script>",
    );
  });

  it("derives landing paths from data and parses them back", () => {
    expect(slugify("Mülheim an der Ruhr")).toBe("muelheim-an-der-ruhr");
    const path = buildLandingPath("bueroreinigung", "Beispielstadt am See");
    expect(path).toBe("/bueroreinigung-beispielstadt-am-see");
    expect(parseLandingPath(path, ["reinigung", "bueroreinigung"])).toEqual({
      serviceSlug: "bueroreinigung",
      citySlug: "beispielstadt-am-see",
    });
    expect(parseLandingPath("/unbekannt-stadt", ["bueroreinigung"])).toBeNull();
    expect(parseLandingPath("/bueroreinigung-../../x", ["bueroreinigung"])).toBeNull();
  });
});

describe("echoRequestFormValues (keeps input after a failed submission)", () => {
  it("echoes only whitelisted fields, never the honeypot or injected fields, and caps length", () => {
    const echoed = echoRequestFormValues(
      form({
        ...complete,
        website: "http://spam.example",
        status: "WON",
        message: "x".repeat(5000),
        marketingConsent: "on",
      }),
    );
    expect(echoed.email).toBe(complete["email"]);
    expect(echoed.marketingConsent).toBe(true);
    expect(echoed.message).toHaveLength(2000);
    expect(Object.keys(echoed)).not.toContain("website");
    expect(Object.keys(echoed)).not.toContain("status");
    expect(Object.keys(echoed)).not.toContain("privacyNoticeAcknowledged");
  });
});
