import { expect, test } from "@playwright/test";
import { collectCspViolations } from "./support/csp.ts";

test.describe("public website", () => {
  test("homepage renders all sections with security headers and without CSP violations", async ({
    page,
  }) => {
    const violations = await collectCspViolations(page);
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);

    const headers = response?.headers() ?? {};
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toMatch(
      /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
    );
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["x-powered-by"]).toBeUndefined();
    // HSTS only for https production deployments, never on plain http.
    expect(headers["strict-transport-security"]).toBeUndefined();

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    for (const id of ["leistungen", "privat", "gewerbe", "immobilien", "servicegebiet"]) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
    await expect(page.getByRole("link", { name: /Reinigung anfragen/ }).first()).toBeVisible();

    const jsonLd = await page.locator('script[type="application/ld+json"]').first().textContent();
    expect(JSON.parse(jsonLd ?? "{}")).toMatchObject({ "@context": "https://schema.org" });
    // No invented social proof in structured data.
    expect(jsonLd).not.toMatch(/aggregateRating|review/i);

    await page.waitForLoadState("networkidle");
    expect(violations).toEqual([]);
  });

  test("keyboard users can skip to the main content", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: /Zum Inhalt/ })).toBeFocused();
  });

  test("robots.txt and sitemap exclude private areas", async ({ request }) => {
    const robots = await (await request.get("/robots.txt")).text();
    for (const path of ["/api/", "/auth/", "/customer", "/admin", "/account"]) {
      expect(robots).toContain(`Disallow: ${path}`);
    }
    const sitemap = await (await request.get("/sitemap.xml")).text();
    expect(sitemap).toContain("<urlset");
    expect(sitemap).not.toMatch(/\/(customer|admin|account|auth)/);
  });

  test("unknown pages return 404 without internal details", async ({ page }) => {
    const response = await page.goto("/diese-seite-gibt-es-nicht");
    expect(response?.status()).toBe(404);
    await expect(page.locator("body")).not.toContainText(/at .*\.(ts|js):\d+|node_modules/);
  });
});
