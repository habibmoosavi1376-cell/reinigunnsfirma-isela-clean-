import { expect, test } from "@playwright/test";
import { grantCustomerRole, uniqueTestEmail, waitForMailLink } from "./support/test-data.ts";

const PASSWORD = "e2e passphrase only for tests";

test.describe("protected areas without a session", () => {
  test("customer and admin areas redirect to the login page", async ({ page }) => {
    await page.goto("/customer/requests");
    await expect(page).toHaveURL(/\/auth\/login\?next=%2Fcustomer%2Frequests$/);
    await expect(page.getByRole("heading", { level: 1, name: "Anmelden" })).toBeVisible();

    await page.goto("/ADMIN/dashboard");
    await expect(page).toHaveURL(/\/auth\/login\?next=/);
  });

  test("the auth API refuses unauthenticated session data", async ({ request }) => {
    const response = await request.get("/api/auth/get-session");
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe("null");
    expect(response.headers()["cache-control"]).toContain("no-store");
  });
});

test.describe("registration → verification → login → customer area", () => {
  test("full flow with server-side area authorization and no open redirect", async ({ page }) => {
    const email = uniqueTestEmail("e2e-register");

    await page.goto("/auth/register");
    await page.getByLabel("Name").fill("E2E-Testdaten Person");
    await page.getByLabel("E-Mail").fill(email);
    await page.getByLabel("Passwort", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Passwort wiederholen").fill(PASSWORD);
    await page.getByRole("button", { name: "Konto erstellen" }).click();
    await expect(page.getByRole("status")).toContainText("Bitte prüfen Sie Ihr Postfach");

    // Unverified accounts cannot sign in.
    await page.goto("/auth/login");
    await page.getByLabel("E-Mail").fill(email);
    await page.getByLabel("Passwort").fill(PASSWORD);
    await page.getByRole("button", { name: "Anmelden" }).click();
    await expect(page.getByRole("alert")).toBeVisible();

    await page.goto(await waitForMailLink(email, "/api/auth/verify-email"));
    await expect(page).toHaveURL(/\/auth\/verify-email\?status=verified/);
    await expect(page.getByRole("status")).toContainText("bestätigt");

    // Open-redirect attempt via ?next= falls back to the default target.
    await page.goto("/auth/login?next=%2F%2Fevil.example%2Fsteal");
    await page.getByLabel("E-Mail").fill(email);
    await page.getByLabel("Passwort").fill(PASSWORD);
    await page.getByRole("button", { name: "Anmelden" }).click();
    await page.waitForURL((url) => url.pathname === "/customer");
    expect(new URL(page.url()).host).toBe(new URL(test.info().project.use.baseURL ?? "").host);

    // Signed in, but no CUSTOMER role yet: the server refuses the area (not just the UI).
    await expect(page.getByRole("heading", { level: 1, name: "Kein Zugriff" })).toBeVisible();
    const denied = await page.request.get("/customer");
    expect(denied.status()).toBe(403);

    await grantCustomerRole(email, "E2E-Testdaten Kunde");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("E2E-Testdaten Kunde");
    await page.goto("/customer/requests");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // A customer never reaches the admin area.
    const admin = await page.goto("/admin/dashboard");
    expect(admin?.status()).toBe(403);
    await expect(page.getByRole("heading", { level: 1, name: "Kein Zugriff" })).toBeVisible();

    await page.goto("/customer");
    await page.getByRole("button", { name: "Abmelden" }).click();
    await page.waitForURL((url) => url.pathname === "/");
    await page.goto("/customer");
    await expect(page).toHaveURL(/\/auth\/login\?next=%2Fcustomer$/);
  });
});
