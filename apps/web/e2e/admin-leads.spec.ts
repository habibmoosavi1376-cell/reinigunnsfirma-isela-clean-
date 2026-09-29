import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  createVerifiedAccount,
  grantCustomerRole,
  grantGlobalRole,
  uniqueTestEmail,
} from "./support/test-data.ts";

const PASSWORD = "e2e passphrase only for tests";
const XSS = `<script>window.__xss=1</script><img src=x onerror="window.__xss=1">`;

async function login(page: Page, email: string, next: string) {
  await page.goto(`/auth/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("E-Mail").fill(email);
  await page.getByLabel("Passwort").fill(PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await page.waitForURL((url) => url.pathname === next);
}

test.describe("back office: public request → lead → status change", () => {
  test("a dispatcher finds, opens and advances a website request", async ({ page, browser }) => {
    const marker = `E2E-Testdaten ${randomUUID().slice(0, 8)}`;
    let xssTriggered = false;
    page.on("dialog", (dialog) => {
      xssTriggered = true;
      void dialog.dismiss();
    });

    // 1. Public request (anonymous visitor).
    const visitor = await browser.newContext();
    const form = await visitor.newPage();
    await form.goto("/anfrage");
    await form.getByLabel("Kundenart").selectOption("BUSINESS");
    await form.getByLabel("Firma (bei Gewerbe/Hausverwaltung)").fill(`${marker} GmbH`);
    await form.getByLabel("Name", { exact: true }).fill(marker);
    await form.getByLabel("E-Mail", { exact: true }).fill(uniqueTestEmail("e2e-lead"));
    await form.getByLabel("Straße").fill("Teststraße");
    await form.getByLabel("Hausnummer").fill("1");
    await form.getByLabel("Postleitzahl").fill("00000");
    await form.getByLabel("Ort", { exact: true }).fill("Teststadt");
    await form.getByLabel("Gewünschte Leistung").selectOption({ index: 1 });
    await form.getByLabel("Objektart").selectOption("OFFICE");
    await form.getByLabel("Nachricht (optional)").fill(XSS);
    await form.getByLabel(/Datenschutzhinweise/).check();
    await form.getByRole("button", { name: "Anfrage senden" }).click();
    await expect(form.getByRole("status")).toContainText("Vielen Dank");
    await visitor.close();

    // 2. Dispatcher (TEST DATA role) signs in.
    const email = uniqueTestEmail("e2e-dispatcher");
    await createVerifiedAccount(page.request, email, PASSWORD);
    await grantGlobalRole(email, "DISPATCHER");
    await login(page, email, "/admin/leads");

    // 3. Lead list with server-side search; no e-mail addresses in the list.
    await page.getByLabel("Suche (Name, Firma, E-Mail, Lead-ID)").fill(marker);
    await page.getByRole("button", { name: "Filtern" }).click();
    const row = page.getByRole("row", { name: new RegExp(marker) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Gewerbe");
    await expect(page.locator("table")).not.toContainText("@example.test");

    // 4. Detail: contact, request, honest geocoding state, XSS rendered as text.
    await row.getByRole("link").click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Lead");
    await expect(page.getByText(XSS)).toBeVisible();
    await expect(page.getByText("kein Anbieter konfiguriert", { exact: false })).toBeVisible();
    await expect(page.locator("#address-title + dl")).toContainText("Unbekannt");
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();

    // 5. Status change through the state machine.
    await page.getByLabel("Neuer Status").selectOption("QUOTE_REQUEST");
    await page.getByRole("button", { name: "Status ändern" }).click();
    await expect(page.getByRole("status")).toContainText("Der Status wurde geändert.");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Angebotsanfrage");
    await expect(page.locator("#history-title + ol")).toContainText("Neu → Angebotsanfrage");

    // LOST without a reason is rejected by the server.
    await page.getByLabel("Neuer Status").selectOption("LOST");
    await page.getByRole("button", { name: "Status ändern" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Eingaben sind ungültig" }),
    ).toBeVisible();

    // 6. Unknown or malformed lead ids.
    expect((await page.goto(`/admin/leads/${randomUUID()}`))?.status()).toBe(404);
    expect((await page.goto("/admin/leads/not-a-uuid"))?.status()).toBe(404);

    // 7. Staff never enter the customer area.
    expect((await page.goto("/customer"))?.status()).toBe(403);
    expect(xssTriggered).toBe(false);
  });

  test("customers cannot open the lead back office", async ({ page }) => {
    const email = uniqueTestEmail("e2e-customer");
    await createVerifiedAccount(page.request, email, PASSWORD);
    await grantCustomerRole(email, "E2E-Testdaten Kunde");
    await login(page, email, "/customer");
    for (const path of ["/admin/leads", `/admin/leads/${randomUUID()}`, "/admin/dashboard"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(403);
      await expect(page.getByRole("heading", { level: 1, name: "Kein Zugriff" })).toBeVisible();
    }
  });
});
