import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  createPropertyFixture,
  createTestCustomer,
  createVerifiedAccount,
  enableTotp,
  grantGlobalRole,
  insertDeadNotification,
  uniqueTestEmail,
} from "./support/test-data.ts";

/*
 * Day 8 back office: recurring contract from an accepted quote, verified holiday data,
 * idempotent generation, pause with conflict hint, status change, notification review.
 * All records are TEST DATA; the holiday region is fictitious and holds no real holidays.
 */

const PASSWORD = "e2e passphrase only for tests";
const DAY = 86_400_000;

async function login(page: Page, email: string, next: string) {
  await page.goto(`/auth/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("E-Mail").fill(email);
  await page.getByLabel("Passwort").fill(PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await page.waitForURL((url) => url.pathname === next);
}

const isoDay = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

test.describe("day 8: back office for recurring contracts and notifications", () => {
  test("protected without a session", async ({ page }) => {
    for (const path of ["/admin/contracts", "/admin/notifications", "/admin/contracts/holidays"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/auth\/login/);
    }
  });

  test("health endpoints answer without details", async ({ request }) => {
    for (const path of ["/api/health", "/api/health/ready"]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()["cache-control"]).toBe("no-store");
      expect(await response.json()).toEqual({ status: "ok" });
    }
  });

  test("an admin manages a recurring contract end to end", async ({ page }) => {
    test.setTimeout(180_000);
    const marker = `E2E-Testdaten ${randomUUID().slice(0, 8)}`;
    const customerId = await createTestCustomer(`${marker} Kunde`);
    const propertyName = await createPropertyFixture(customerId, marker);

    const adminEmail = uniqueTestEmail("e2e-d8-admin");
    await createVerifiedAccount(page.request, adminEmail, PASSWORD);
    await login(page, adminEmail, "/account/security");
    await enableTotp(page.request, PASSWORD);
    await grantGlobalRole(adminEmail, "ADMIN");

    // Accepted quote (manual test price).
    await page.goto(`/admin/customers/${customerId}`);
    await page.getByLabel("Objekt (optional)").selectOption({ label: propertyName });
    await page.getByRole("button", { name: "Angebotsentwurf anlegen" }).click();
    await expect(page.getByRole("status")).toContainText("Angebotsentwurf wurde angelegt");
    await page.getByLabel("Leistungsbereich").selectOption({ label: "Wohnungsreinigung" });
    await page.getByLabel("Beschreibung").fill("Unterhaltsreinigung (E2E)");
    await page.getByLabel("Menge").fill("2");
    await page.getByLabel("Einheit").selectOption("HOUR");
    await page.getByLabel("Einzelpreis netto in €").fill("30,00");
    await page.getByRole("button", { name: "Position hinzufügen" }).click();
    await page.getByRole("button", { name: "Zur Prüfung geben" }).click();
    await page.getByRole("button", { name: "Freigeben" }).click();
    const accept = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "Annahme erfassen" }) });
    await accept.getByLabel("Begründung/Nachweis (Pflicht)").fill("Schriftliche Annahme (E2E)");
    await accept.getByRole("button", { name: "Annahme erfassen" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Angenommen");

    // Recurring contract instead of a single booking.
    const contract = page.getByRole("form", { name: "Wiederkehrenden Auftrag anlegen" });
    await contract.getByLabel("Intervall").selectOption("WEEKLY");
    await contract.getByLabel("Erster Termin").fill(isoDay(8));
    await contract.getByLabel("Uhrzeit von (je Termin)").fill("09:00");
    await contract.getByLabel("Uhrzeit bis (je Termin)").fill("12:00");
    await contract.getByLabel("Einsatzdauer je Termin (Minuten)").fill("120");
    await contract.getByRole("button", { name: "Wiederkehrenden Auftrag anlegen" }).click();
    await page.waitForURL(/\/admin\/contracts\/[0-9a-f-]{36}/);
    const contractUrl = new URL(page.url()).pathname;
    await expect(page.getByRole("status")).toContainText("Vertrag wurde angelegt");
    // Without verified holiday data nothing is generated (no invented holidays).
    await expect(
      page.getByRole("alert").filter({ hasText: "keine freigegebenen Feiertagsdaten" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Termine für .* erzeugen/ })).toHaveCount(0);

    // Owner-side configuration: fictitious TEST region and approved (empty) TEST years.
    await page.goto("/admin/contracts/holidays");
    const settings = page.getByRole("form", { name: "Einstellungen ändern" });
    await settings.getByLabel(/Feiertagsregion/).fill("XE-E2E");
    await settings.getByLabel("Begründung der Änderung").fill("E2E-Testkonfiguration");
    await settings.getByRole("button", { name: "Einstellungen speichern" }).click();
    await expect(page.getByRole("status")).toContainText("neue Version gespeichert");
    for (const year of [...new Set([isoDay(0).slice(0, 4), isoDay(60).slice(0, 4)])]) {
      const record = page.getByRole("form", { name: "Feiertagsjahr erfassen" });
      await record.getByLabel("Jahr").fill(year);
      await record.getByLabel(/Quelle/).fill("TEST DATA – fiktiver Kalender (E2E)");
      await record.getByRole("button", { name: "Jahr geprüft freigeben" }).click();
      await expect(page.getByRole("status")).toContainText("Feiertagsjahr wurde freigegeben");
    }

    // Generation: bookings on prepayment, repeating it creates nothing twice.
    await page.goto(contractUrl);
    await page.getByRole("button", { name: /Termine für .* erzeugen/ }).click();
    await expect(page.getByRole("status")).toContainText("Termine wurden erzeugt");
    const bookedLinks = page.getByRole("link", { name: "Gebucht" });
    const count = await bookedLinks.count();
    expect(count).toBeGreaterThan(0);
    await page.getByRole("button", { name: /Termine für .* erzeugen/ }).click();
    await expect(page.getByRole("link", { name: "Gebucht" })).toHaveCount(count);
    await bookedLinks.first().click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Wartet auf Vorkasse");
    await page.goto(contractUrl);

    // Pause over the first booked appointment: hint instead of silent cancellation.
    const pause = page.getByRole("form", { name: "Pause erfassen" });
    await pause.getByLabel("Von").fill(isoDay(8));
    await pause.getByLabel("Bis").fill(isoDay(8));
    await pause.getByLabel("Grund").fill("Objekt nicht zugänglich (E2E)");
    await pause.getByRole("button", { name: "Pause erfassen" }).click();
    await expect(page.getByRole("status")).toContainText("bereits Buchungen");

    // Status change with reason; a paused contract cannot generate.
    const status = page.getByRole("form", { name: "Status ändern" });
    await status.getByLabel("Neuer Status").selectOption("PAUSED");
    await status.getByLabel("Begründung").fill("Kunde im Urlaub (E2E)");
    await status.getByRole("button", { name: "Status ändern" }).click();
    await expect(page.getByRole("status")).toContainText("Vertragsstatus wurde geändert");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Pausiert");
    await expect(page.getByRole("button", { name: /Termine für .* erzeugen/ })).toHaveCount(0);

    // Notification review: a failed delivery is closed with a reason (no e-mail involved).
    await insertDeadNotification(customerId);
    await page.goto("/admin/notifications?status=DEAD");
    await expect(page.getByText("Manuelle Prüfung erforderlich")).toBeVisible();
    const row = page.getByRole("row", { name: new RegExp(`${marker} Kunde`) });
    await row.getByLabel("Aktion").selectOption("DISMISS");
    await row.getByLabel("Begründung").fill("Kunde telefonisch informiert (E2E)");
    await row.getByRole("button", { name: "Übernehmen" }).click();
    await expect(page.getByRole("status")).toContainText("Benachrichtigung wurde geschlossen");
  });
});
