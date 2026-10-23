import { randomInt } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { collectCspViolations } from "./support/csp.ts";
import {
  countCallbacksFor,
  countServiceRequestsFor,
  createVerifiedAccount,
  enableTotp,
  grantGlobalRole,
  uniqueTestEmail,
} from "./support/test-data.ts";

/*
 * Day 7: public website, SEO, conversion paths and consent. All submitted data is E2E test
 * data (example.test addresses, test phone numbers) written to the dedicated E2E database.
 */

const PASSWORD = "e2e passphrase only for tests";
const MOBILE = { width: 390, height: 844 };

function testPhone(): string {
  return `+4930555${String(randomInt(100_000, 999_999))}`;
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Every request the page made went to our own origin (no third-party tracking). */
function collectForeignRequests(page: Page, baseUrl: string): string[] {
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(baseUrl) && !url.startsWith("data:")) foreign.push(url);
  });
  return foreign;
}

test.describe("day 7: homepage and navigation", () => {
  test("offers the three main CTAs, a process section and trust facts without invented proof", async ({
    page,
    baseURL,
  }) => {
    const violations = await collectCspViolations(page);
    const foreign = collectForeignRequests(page, baseURL ?? "");
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    const hero = page.locator(".hero");
    await expect(hero.getByRole("link", { name: "Reinigung anfragen" })).toHaveAttribute(
      "href",
      "/anfrage",
    );
    await expect(hero.getByRole("link", { name: "Leistungen ansehen" })).toHaveAttribute(
      "href",
      "/leistungen",
    );
    await expect(hero.getByRole("link", { name: "Rückruf anfordern" })).toHaveAttribute(
      "href",
      "/rueckruf",
    );
    await expect(page.getByRole("heading", { name: "So funktioniert es" })).toBeVisible();
    const body = (await page.locator("main").textContent()) ?? "";
    expect(body).not.toMatch(/Sterne|★|Bewertung|zertifiziert|Referenzkunden|ab \d+ ?€/i);
    await page.waitForLoadState("networkidle");
    expect(foreign).toEqual([]);
    expect(violations).toEqual([]);
  });

  test("mobile: compact header, keyboard-operable menu, no horizontal scrolling", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    for (const path of [
      "/",
      "/leistungen",
      "/anfrage",
      "/rueckruf",
      "/datenschutz",
      "/impressum",
    ]) {
      await page.goto(path);
      await noHorizontalScroll(page);
    }
    await page.goto("/");
    const header = await page.locator(".site-header").boundingBox();
    expect(header?.height ?? 999).toBeLessThan(100);
    const menu = page.locator("details.site-nav--mobile summary");
    await expect(menu).toBeVisible();
    await menu.focus();
    await page.keyboard.press("Enter");
    const mobileNav = page.getByRole("navigation", { name: "Hauptnavigation (mobil)" });
    await expect(mobileNav.getByRole("link", { name: "Leistungen" })).toBeVisible();
    await mobileNav.getByRole("link", { name: "Leistungen" }).click();
    await expect(page).toHaveURL(/\/leistungen$/);
  });

  test("form fields are labelled and focus is visible", async ({ page }) => {
    for (const path of ["/anfrage", "/rueckruf"]) {
      await page.goto(path);
      const unlabelled = await page.evaluate(() =>
        [...document.querySelectorAll("input:not([type=hidden]), select, textarea")]
          .filter((el) => (el as HTMLInputElement).tabIndex !== -1)
          .filter((el) => ((el as HTMLInputElement).labels?.length ?? 0) === 0)
          .map((el) => el.getAttribute("name")),
      );
      expect(unlabelled).toEqual([]);
    }
    await page.goto("/rueckruf");
    await page.getByLabel("Name", { exact: true }).focus();
    const outline = await page
      .getByLabel("Name", { exact: true })
      .evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
  });
});

test.describe("day 7: service pages and SEO", () => {
  test("service pages exist for catalogue categories; unknown slugs are 404", async ({ page }) => {
    await page.goto("/leistungen");
    await expect(page.getByRole("heading", { level: 1, name: "Leistungen" })).toBeVisible();
    await page.getByRole("link", { name: "Büroreinigung" }).first().click();
    await expect(page).toHaveURL(/\/leistungen\/bueroreinigung$/);
    await expect(page.getByRole("heading", { level: 1, name: "Büroreinigung" })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Brotkrümelnavigation" }).getByRole("link"),
    ).toHaveCount(2);
    // No content written yet in the E2E data: reachable, but not for search engines.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      /\/leistungen\/bueroreinigung$/,
    );
    const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(ld.join(" ")).toContain("BreadcrumbList");
    expect(ld.join(" ")).not.toMatch(/"@type":"Service"|price|aggregateRating/);
    await page.getByRole("link", { name: "Büroreinigung anfragen" }).click();
    await expect(page.getByLabel("Gewünschte Leistung")).toHaveValue("office-cleaning");

    for (const slug of ["gibt-es-nicht", "..%2Fadmin", "BUEROREINIGUNG"]) {
      expect((await page.goto(`/leistungen/${slug}`))?.status()).toBe(404);
    }
  });

  test("every public page has a unique title, a description and a canonical URL", async ({
    page,
  }) => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    const paths = ["/", "/leistungen", "/anfrage", "/rueckruf", "/impressum", "/datenschutz"];
    for (const path of paths) {
      await page.goto(path);
      titles.add(await page.title());
      const description = await page.locator('meta[name="description"]').getAttribute("content");
      expect(description?.length ?? 0).toBeGreaterThan(40);
      descriptions.add(description ?? "");
      const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
      expect(new URL(canonical ?? "").pathname).toBe(path);
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
        "content",
        canonical ?? "",
      );
    }
    expect(titles.size).toBe(paths.length);
    expect(descriptions.size).toBe(paths.length);
  });

  test("the sitemap lists only existing, indexable pages", async ({ request }) => {
    const xml = await (await request.get("/sitemap.xml")).text();
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? "");
    const paths = urls.map((url) => new URL(url).pathname);
    expect(paths).toEqual(expect.arrayContaining(["/", "/leistungen", "/anfrage", "/rueckruf"]));
    // Service pages without content are noindex and therefore absent.
    expect(paths.filter((p) => p.startsWith("/leistungen/"))).toEqual([]);
    expect(paths).not.toContain("/datenschutz/einstellungen");
    for (const path of paths) {
      expect((await request.get(path)).status(), path).toBe(200);
    }
    const robots = await (await request.get("/robots.txt")).text();
    expect(robots).toContain("Disallow: /team");
  });
});

test.describe("day 7: conversion paths", () => {
  test("mobile request submission is stored exactly once even when sent twice", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    const email = uniqueTestEmail("e2e-d7-mobile");
    await page.goto("/anfrage");
    await page.getByLabel("Kundenart").selectOption("PRIVATE");
    await page.getByLabel("Name", { exact: true }).fill("E2E-Testdaten Mobil");
    await page.getByLabel("E-Mail", { exact: true }).fill(email);
    await page.getByLabel("Straße").fill("Teststraße");
    await page.getByLabel("Hausnummer").fill("2");
    await page.getByLabel("Postleitzahl").fill("00000");
    await page.getByLabel("Ort", { exact: true }).fill("Teststadt");
    await page.getByLabel("Gewünschte Leistung").selectOption({ index: 1 });
    await page.getByLabel("Objektart").selectOption({ index: 1 });
    await page.getByLabel("Gewünschte Häufigkeit").selectOption({ index: 1 });
    await page.getByLabel(/Datenschutzhinweise/).check();
    // Double submit (double tap / retry): both submissions carry the same form token.
    await page.locator("form.form").evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
      (form as HTMLFormElement).requestSubmit();
    });
    await expect(page.getByRole("status")).toContainText("Vielen Dank für Ihre Anfrage");
    await expect(page.getByRole("status")).toContainText("Servicegebiet");
    await page.waitForLoadState("networkidle");
    expect(await countServiceRequestsFor(email)).toBe(1);
  });

  test("callback request: validation, success without a promised time, stored once", async ({
    page,
  }) => {
    const violations = await collectCspViolations(page);
    const phone = testPhone();
    await page.goto("/rueckruf?leistung=office-cleaning");
    await expect(page.getByLabel("Leistung (optional)")).toHaveValue("office-cleaning");
    await page.getByLabel("Name", { exact: true }).fill("E2E-Testdaten Rückruf");
    await page.getByLabel("Telefonnummer", { exact: true }).fill("keine Nummer");
    await page.getByRole("button", { name: "Rückruf anfordern" }).click();
    await expect(page.locator("#cb-phone")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#cb-privacy")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("E2E-Testdaten Rückruf");

    await page.getByLabel("Telefonnummer", { exact: true }).fill(phone);
    await page.getByLabel(/Datenschutzhinweise/).check();
    await page.getByLabel("Wann passt es Ihnen am besten?").selectOption("AFTERNOON");
    await page.getByRole("button", { name: "Rückruf anfordern" }).click();
    await expect(page.getByRole("status")).toContainText("Rückrufwunsch ist eingegangen");
    await expect(page.getByRole("status")).toContainText(
      "fester Termin ist damit nicht vereinbart",
    );
    expect(await countCallbacksFor(phone)).toBe(1);
    expect(violations).toEqual([]);
  });

  test("untrusted query parameters are neither reflected nor preselected", async ({ page }) => {
    await page.goto("/rueckruf?leistung=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    await expect(page.getByLabel("Leistung (optional)")).toHaveValue("");
    expect(await page.content()).not.toContain("<script>alert(1)</script>");
  });
});

test.describe("day 7: consent and analytics", () => {
  test("no analytics without a provider: no banner, no tracking cookie, revocation works", async ({
    page,
    context,
    baseURL,
  }) => {
    const foreign = collectForeignRequests(page, baseURL ?? "");
    await page.goto("/");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto("/leistungen");
    expect((await context.cookies()).map((c) => c.name)).not.toContain("isela_consent");

    await page.goto("/datenschutz/einstellungen");
    await expect(page.locator("main")).toContainText("keine");
    await expect(page.locator("main")).toContainText("keine Einwilligung erteilt");
    await expect(page.getByRole("button", { name: "Statistik erlauben" })).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

    await page.getByRole("button", { name: "Alle optionalen Einwilligungen widerrufen" }).click();
    await expect(page.getByRole("status")).toContainText("widerrufen");
    const consent = (await context.cookies()).find((c) => c.name === "isela_consent");
    expect(consent?.value).toMatch(/^v1\.0\.0\.\d+$/);
    expect(consent?.httpOnly).toBe(true);
    await expect(page.locator("main")).toContainText("keine Einwilligung erteilt");
    await page.waitForLoadState("networkidle");
    expect(foreign).toEqual([]);
  });
});

test.describe("day 7: conversion report access", () => {
  test("finance sees the report with test-data label and unmeasured figures; anonymous is redirected", async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    const anonymous = await browser.newContext();
    const anonymousPage = await anonymous.newPage();
    await anonymousPage.goto("/admin/reports");
    await expect(anonymousPage).toHaveURL(/\/auth\/login/);
    await anonymous.close();

    const email = uniqueTestEmail("e2e-d7-report");
    await createVerifiedAccount(page.request, email, PASSWORD);
    await page.goto(`/auth/login?next=${encodeURIComponent("/account/security")}`);
    await page.getByLabel("E-Mail").fill(email);
    await page.getByLabel("Passwort").fill(PASSWORD);
    await page.getByRole("button", { name: "Anmelden" }).click();
    await page.waitForURL((url) => url.pathname === "/account/security");
    await enableTotp(page.request, PASSWORD);
    await grantGlobalRole(email, "FINANCE");

    await page.goto("/admin/reports");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Conversion-Bericht");
    await expect(page.getByRole("note")).toContainText("Testdaten");
    await expect(page.getByRole("row", { name: /Seitenbesuche/ })).toContainText("nicht gemessen");
    await expect(page.getByRole("row", { name: /Abgesendete Anfragen/ })).toContainText(
      "Datenbank",
    );
    await page.goto("/admin/reports?from=2026-13-01&to=x");
    await expect(page.getByRole("alert").filter({ hasText: "ungültig" })).toBeVisible();
  });
});
