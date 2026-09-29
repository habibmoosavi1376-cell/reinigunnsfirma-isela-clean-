import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  createOperationsFixture,
  createVerifiedAccount,
  enableTotp,
  grantCustomerRole,
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

/** A Tuesday at least one week ahead (YYYY-MM-DD). */
function futureTuesday(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 7 + ((2 - date.getUTCDay() + 7) % 7));
  return date.toISOString().slice(0, 10);
}

function panel(page: Page, heading: string) {
  return page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
}

test.describe("day 5: service → quote → booking → job → assignment", () => {
  test("an admin runs the flow and the customer sees only the own booking", async ({
    page,
    browser,
  }) => {
    // Two sign-ups; the unchanged sign-up rate limit may require waiting for its window.
    test.setTimeout(240_000);
    const marker = `E2E-Testdaten ${randomUUID().slice(0, 8)}`;
    const qualification = `e2e-${randomUUID().slice(0, 6)}`;

    // Customer account with a TEST-DATA customer, property, area and qualified employee.
    const customerEmail = uniqueTestEmail("e2e-ops-customer");
    const customerContext = await browser.newContext();
    const customerPage = await customerContext.newPage();
    await createVerifiedAccount(customerPage.request, customerEmail, PASSWORD);
    const customerId = await grantCustomerRole(customerEmail, `${marker} Kunde`);
    const fixture = await createOperationsFixture(customerId, marker, qualification);

    // Admin with genuine TOTP enrolment (privileged roles need MFA).
    const adminEmail = uniqueTestEmail("e2e-ops-admin");
    await createVerifiedAccount(page.request, adminEmail, PASSWORD);
    await login(page, adminEmail, "/account/security");
    await enableTotp(page.request, PASSWORD);
    await grantGlobalRole(adminEmail, "ADMIN");

    // 1. Admin creates and checks a catalogue service (no prices in the catalogue).
    await page.goto("/admin/services");
    const newService = panel(page, "Leistung anlegen");
    await newService.getByLabel("Kategorie").selectOption({ label: "Wohnungsreinigung" });
    await newService.getByLabel("Schlüssel (slug)").fill(`e2e-${randomUUID().slice(0, 8)}`);
    await newService.getByLabel("Name", { exact: true }).fill(`${marker} Leistung`);
    await newService.getByLabel("Einheit", { exact: true }).selectOption("HOUR");
    await newService.getByLabel("Dauermodell").selectOption("FIXED");
    await newService.getByLabel("Minuten (fest bzw. Rüstzeit)").fill("180");
    await newService
      .getByLabel("Erforderliche Qualifikationen (kommagetrennt)")
      .fill(qualification);
    await newService.getByRole("button", { name: "Leistung anlegen" }).click();
    await expect(page.getByRole("status")).toContainText("Leistung wurde gespeichert");
    const serviceRow = page.getByRole("row", { name: new RegExp(`${marker} Leistung`) });
    await expect(serviceRow).toContainText("Manuelles Angebot");
    await expect(serviceRow).toContainText(qualification);

    // 2. Quote: draft with a manual price, review, release, recorded acceptance.
    await page.goto(`/admin/customers/${customerId}`);
    await page.getByLabel("Objekt (optional)").selectOption({ label: fixture.propertyName });
    await page.getByRole("button", { name: "Angebotsentwurf anlegen" }).click();
    await expect(page.getByRole("status")).toContainText("Angebotsentwurf wurde angelegt");
    await page.getByLabel("Leistungsbereich").selectOption({ label: "Wohnungsreinigung" });
    await page
      .getByLabel("Katalogleistung (optional)")
      .selectOption({ label: `${marker} Leistung (Stunde(n))` });
    await page.getByLabel("Beschreibung").fill("Wohnungsreinigung (E2E)");
    await page.getByLabel("Menge").fill("3");
    await page.getByLabel("Einheit").selectOption("HOUR");
    await page.getByLabel("Einzelpreis netto in €").fill("30,00");
    await page.getByRole("button", { name: "Position hinzufügen" }).click();
    await expect(page.locator("#summary-title ~ dl")).toContainText("107,10");
    await page.getByRole("button", { name: "Zur Prüfung geben" }).click();
    await page.getByRole("button", { name: "Freigeben" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Freigegeben");
    const accept = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "Annahme erfassen" }) });
    await accept.getByLabel("Begründung/Nachweis (Pflicht)").fill("Schriftliche Annahme (E2E)");
    await accept.getByRole("button", { name: "Annahme erfassen" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Angenommen");

    // 3. Booking from the accepted quote: prepayment required (new customer).
    await page.getByLabel("Wunschtermin").fill(futureTuesday());
    await page.getByLabel("Zeitfenster von").fill("09:00");
    await page.getByLabel("Zeitfenster bis").fill("13:00");
    await page.getByLabel("Dauer in Minuten").fill("180");
    await page.getByRole("button", { name: "Buchung anlegen" }).click();
    await page.waitForURL(/\/admin\/bookings\/[0-9a-f-]{36}/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Wartet auf Vorkasse");
    await expect(panel(page, "Zahlung")).toContainText("Vorkasse erforderlich");
    const bookingUrl = page.url();

    // 4. Booking → job → assignment (server-side candidate check).
    await page.getByRole("button", { name: "Einsatz planen" }).click();
    await page.waitForURL(/\/admin\/jobs\/[0-9a-f-]{36}/);
    const jobPath = new URL(page.url()).pathname;
    await page.getByRole("button", { name: "Zur Disposition freigeben" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Zuweisung offen");
    const candidate = page.getByRole("row", { name: new RegExp(fixture.employeeName) });
    await expect(candidate).toContainText("Qualifikation");
    await candidate.getByRole("button", { name: "Zuweisen" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Zugewiesen");

    // Payment guard: the job cannot start before the prepayment is confirmed.
    await page.getByRole("button", { name: "Einsatz beginnen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "nicht zulässig" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Zugewiesen");

    // 5. Finance step (ADMIN holds payment:manage): confirmation needs a reference.
    await page.goto(bookingUrl);
    await page.getByRole("button", { name: "Zahlung erwartet" }).click();
    const confirm = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "Zahlungseingang bestätigen" }) });
    await confirm.getByLabel("Zahlungsreferenz / Nachweis (Pflicht)").fill("Kontoauszug E2E");
    await confirm.getByRole("button", { name: "Zahlungseingang bestätigen" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Eingeplant");

    // 6. The customer sees the own booking – without staff names or internal data.
    await login(customerPage, customerEmail, "/customer/jobs");
    const bookingRow = customerPage.getByRole("row", { name: new RegExp(fixture.propertyName) });
    await expect(bookingRow).toContainText("Eingeplant");
    await expect(bookingRow).toContainText("Zahlung bestätigt");
    await bookingRow.getByRole("link").click();
    await expect(customerPage.getByRole("heading", { level: 1 })).toContainText(
      fixture.propertyName,
    );
    await expect(customerPage.locator("main")).not.toContainText(fixture.employeeName);
    await expect(customerPage.locator("main")).not.toContainText("Deckungsbeitrag");

    // 7. Wrong user: foreign or internal resources give 403/404.
    expect((await customerPage.goto(`/customer/bookings/${randomUUID()}`))?.status()).toBe(404);
    expect((await customerPage.goto(jobPath))?.status()).toBe(403);
    expect((await customerPage.goto(new URL(bookingUrl).pathname))?.status()).toBe(403);
    expect((await customerPage.goto("/team/jobs"))?.status()).toBe(403);
    const bookingId = new URL(bookingUrl).pathname.split("/").at(-1) ?? "";
    expect((await page.goto(`/customer/bookings/${bookingId}`))?.status()).toBe(403);
    expect((await page.goto(`/admin/jobs/${randomUUID()}`))?.status()).toBe(404);
    await customerContext.close();
  });
});
