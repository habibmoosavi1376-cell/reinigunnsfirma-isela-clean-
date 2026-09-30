import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  configureTestBilling,
  createTestCustomer,
  createVerifiedAccount,
  enableTotp,
  grantGlobalRole,
  uniqueTestEmail,
} from "./support/test-data.ts";

const PASSWORD = "e2e passphrase only for tests";

async function login(page: Page, email: string, next: string) {
  await page.goto(`/auth/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("E-Mail").fill(email);
  await page.getByLabel("Passwort").fill(PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await page.waitForURL((url) => url.pathname === next);
}

test.describe("day 6: finance back office", () => {
  test("finance works with invoices, payments and payment risk; others are refused", async ({
    page,
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    await configureTestBilling();
    const marker = `E2E-Testdaten ${randomUUID().slice(0, 8)}`;
    const customerId = await createTestCustomer(`${marker} Kunde`);

    // FINANCE user with genuine TOTP enrolment (privileged roles need MFA).
    const email = uniqueTestEmail("e2e-finance");
    await createVerifiedAccount(page.request, email, PASSWORD);
    await login(page, email, "/account/security");
    await enableTotp(page.request, PASSWORD);
    await grantGlobalRole(email, "FINANCE");

    // Invoice list with filters (overdue filter) and the payment list.
    await page.goto("/admin/invoices?overdue=1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rechnungen");
    await expect(page.getByLabel("Nur überfällige")).toBeChecked();
    await page.goto("/admin/invoices?minGross=abc");
    await expect(page.getByRole("alert").filter({ hasText: "ungültig" })).toBeVisible();
    await page.goto("/admin/payments");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Zahlungen");
    await expect(page.locator("main")).toContainText("Kein Zahlungsanbieter ist aktiv");

    // Overdue run and payment-risk view of a new customer: prepayment, no credit request.
    await page.goto("/admin/payment-risk");
    await page.getByRole("button", { name: "Fälligkeitslauf starten" }).click();
    await expect(page.getByRole("status")).toContainText("Fälligkeitslauf wurde ausgeführt");
    await page.goto(`/admin/payment-risk/${customerId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Vorkasse erforderlich");
    await expect(page.locator("main")).toContainText("Neukunde");
    await expect(page.locator("main")).toContainText(
      "Die Mindestvoraussetzungen sind nicht erfüllt",
    );
    await expect(page.getByRole("button", { name: "Rechnungskauf beantragen" })).toHaveCount(0);
    await page.getByRole("button", { name: "Neu bewerten" }).click();
    await expect(page.getByRole("status")).toContainText("neu bewertet");
    await page.goto("/admin/payment-risk?outcome=VORKASSE_REQUIRED");
    await expect(page.getByRole("row", { name: new RegExp(`${marker} Kunde`) })).toBeVisible();

    // Authorisation: unknown ids 404, modules outside the finance role 403.
    expect((await page.goto(`/admin/invoices/${randomUUID()}`))?.status()).toBe(404);
    expect((await page.goto(`/admin/payment-risk/${randomUUID()}`))?.status()).toBe(404);
    expect((await page.goto("/admin/employees"))?.status()).toBe(403);

    // Anonymous visitors never reach finance pages; webhooks without a provider do not exist.
    const anonymous = await browser.newContext();
    const anonymousPage = await anonymous.newPage();
    await anonymousPage.goto("/admin/invoices");
    await expect(anonymousPage).toHaveURL(/\/auth\/login/);
    await anonymous.close();
    const webhook = await request.post("/api/payments/webhooks/test-psp", {
      data: { id: "evt_forged", type: "payment.succeeded" },
    });
    expect(webhook.status()).toBe(404);
  });
});
