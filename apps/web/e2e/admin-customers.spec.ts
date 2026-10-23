import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  createTestInvitation,
  createVerifiedAccount,
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

function detailsWithSummary(page: Page, summary: string) {
  return page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: new RegExp(`^${summary}$`) }) });
}

test.describe("back office: lead → customer → property → quote draft", () => {
  test("a dispatcher builds the customer file from a website request", async ({
    page,
    browser,
  }) => {
    const marker = `E2E-Testdaten ${randomUUID().slice(0, 8)}`;

    // 1. Public request (anonymous visitor, private customer).
    const visitor = await browser.newContext();
    const form = await visitor.newPage();
    await form.goto("/anfrage");
    await form.getByLabel("Kundenart").selectOption("PRIVATE");
    await form.getByLabel("Name", { exact: true }).fill(marker);
    await form.getByLabel("E-Mail", { exact: true }).fill(uniqueTestEmail("e2e-crm"));
    await form.getByLabel("Straße").fill("Kundenweg");
    await form.getByLabel("Hausnummer").fill("4");
    await form.getByLabel("Postleitzahl").fill("00000");
    await form.getByLabel("Ort", { exact: true }).fill("Teststadt");
    await form.getByLabel("Gewünschte Leistung").selectOption({ index: 1 });
    await form.getByLabel("Objektart").selectOption("PRIVATE_HOME");
    await form.getByLabel(/Datenschutzhinweise/).check();
    await form.getByRole("button", { name: "Anfrage senden" }).click();
    await expect(form.getByRole("status")).toContainText("Vielen Dank");
    await visitor.close();

    // 2. Dispatcher opens the lead and links a customer record.
    const email = uniqueTestEmail("e2e-crm-dispatcher");
    await createVerifiedAccount(page.request, email, PASSWORD);
    await grantGlobalRole(email, "DISPATCHER");
    await login(page, email, "/admin/leads");
    await page.getByLabel("Suche (Name, Firma, E-Mail, Lead-ID)").fill(marker);
    await page.getByRole("button", { name: "Filtern" }).click();
    await page
      .getByRole("row", { name: new RegExp(marker) })
      .getByRole("link")
      .click();
    await page.getByRole("button", { name: "Kundendatensatz anlegen/zuordnen" }).click();
    await expect(page.getByRole("status")).toContainText("Kundendatensatz verknüpft");

    // 3. Lead → property; the invitation needs customer:link_account (not a dispatcher right).
    await page.getByRole("button", { name: "Objekt aus Anfrage anlegen" }).click();
    await expect(page.getByRole("status")).toContainText("Objekt wurde aus der Anfrage angelegt");
    await expect(page.getByRole("button", { name: "Kundenkonto einladen" })).toHaveCount(0);

    // 4. Customer list: server-side search, counts, no contact data.
    await page
      .getByRole("navigation", { name: "Verwaltung" })
      .getByRole("link", { name: "Kunden" })
      .click();
    await expect(
      page.getByRole("navigation", { name: "Verwaltung" }).getByRole("link", { name: "Kunden" }),
    ).toHaveAttribute("aria-current", "page");
    await page.getByLabel(/^Suche \(Name, Firma/).fill(marker);
    await page.getByRole("button", { name: "Filtern" }).click();
    const row = page.getByRole("row", { name: new RegExp(marker) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("00000 Teststadt");
    await expect(page.locator("table")).not.toContainText("@example.test");

    // 5. Customer detail: primary address from the request, property, prepayment.
    await row.getByRole("link", { name: marker }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(marker);
    await expect(page.locator("#addresses-title ~ div")).toContainText("Hauptadresse");
    await expect(page.locator("#properties-title ~ div")).toContainText("Kundenweg 4, Teststadt");
    await expect(page.locator("#payment-title ~ p").first()).toContainText("Vorkasse");

    // 6. Second property (e.g. further site of the same customer) via the form.
    const create = detailsWithSummary(page, "Objekt anlegen");
    await create.locator("summary").click();
    await create.getByLabel("Bezeichnung").fill(`${marker} Büro`);
    await create.getByLabel("Objektart").selectOption("OFFICE");
    await create.getByLabel("Räume (optional)", { exact: true }).fill("5");
    await create.getByLabel("Reinigungsintervall (optional)").selectOption("BIWEEKLY");
    await create.getByRole("button", { name: "Objekt anlegen" }).click();
    await expect(page.getByRole("status")).toContainText("Das Objekt wurde angelegt.");
    await expect(page.locator("#properties-title ~ div")).toContainText(`${marker} Büro`);

    // Invalid input is rejected by the server with a clear message.
    await create.locator("summary").click();
    await create.getByLabel("Bezeichnung").fill("Ungültig");
    await create.getByLabel("Räume (optional)", { exact: true }).fill("1,5");
    await create.getByRole("button", { name: "Objekt anlegen" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Eingaben sind ungültig" }),
    ).toBeVisible();

    // 7. Quote draft: prices are entered manually and summed by the server.
    await page.getByLabel("Objekt (optional)").selectOption({ label: `${marker} Büro` });
    await page.getByRole("button", { name: "Angebotsentwurf anlegen" }).click();
    await expect(page.getByRole("status")).toContainText("Angebotsentwurf wurde angelegt");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Entwurf");
    await page.getByLabel("Beschreibung").fill("Unterhaltsreinigung Büro");
    await page.getByLabel("Menge").fill("2,5");
    await page.getByLabel("Einheit").selectOption("HOUR");
    await page.getByLabel("Einzelpreis netto in €").fill("32,90");
    await page.getByRole("button", { name: "Position hinzufügen" }).click();
    await expect(page.getByRole("status")).toContainText("Position wurde hinzugefügt");
    await expect(page.locator("#summary-title ~ dl")).toContainText("82,25");
    await expect(page.locator("#summary-title ~ dl")).toContainText("97,88");

    // 8. Review yes, release no (quote:approve is reserved for ADMIN/SUPER_ADMIN).
    await page.getByRole("button", { name: "Zur Prüfung geben" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("In Prüfung");
    await expect(page.getByRole("button", { name: "Freigeben" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Position hinzufügen" })).toHaveCount(0);

    // 9. Unknown or malformed ids.
    for (const path of [
      `/admin/customers/${randomUUID()}`,
      "/admin/customers/not-a-uuid",
      `/admin/quotes/${randomUUID()}`,
    ]) {
      expect((await page.goto(path))?.status(), path).toBe(404);
    }
    expect((await page.goto("/admin/properties"))?.status()).toBe(200);
  });

  test("an invited account accepts once and is confined to its own customer data", async ({
    page,
  }) => {
    const email = uniqueTestEmail("e2e-invitee");
    await createVerifiedAccount(page.request, email, PASSWORD);
    const token = await createTestInvitation(email, "E2E-Testdaten Eingeladen");
    await login(page, email, "/account/security");

    await page.goto(`/account/invitation?token=${token}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Einladung annehmen");
    await page.getByRole("button", { name: "Einladung annehmen" }).click();
    await expect(page.getByRole("status")).toContainText("Einladung wurde angenommen");
    expect(page.url()).not.toContain(token);
    expect((await page.goto("/customer"))?.status()).toBe(200);

    // Reuse of the same token is rejected without details.
    await page.goto(`/account/invitation?token=${token}`);
    await page.getByRole("button", { name: "Einladung annehmen" }).click();
    await expect(page.getByRole("status")).toContainText("ungültig, abgelaufen, bereits verwendet");

    // As a customer: no CRM back office, no foreign or unknown quotes.
    for (const path of [
      "/admin/customers",
      `/admin/customers/${randomUUID()}`,
      "/admin/properties",
      "/admin/quotes",
    ]) {
      expect((await page.goto(path))?.status(), path).toBe(403);
    }
    await page.goto("/customer/quotes");
    await expect(page.getByText("keine freigegebenen Angebote")).toBeVisible();
    expect((await page.goto(`/customer/quotes/${randomUUID()}`))?.status()).toBe(404);
  });
});
