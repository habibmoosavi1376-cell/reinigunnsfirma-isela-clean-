import { expect, test, type Page } from "@playwright/test";
import { collectCspViolations } from "./support/csp.ts";
import { countServiceRequestsFor, uniqueTestEmail } from "./support/test-data.ts";

async function fillRequestForm(page: Page, email: string) {
  await page.getByLabel("Kundenart").selectOption("PRIVATE");
  await page.getByLabel("Name", { exact: true }).fill("E2E-Testdaten Anfrage");
  await page.getByLabel("E-Mail", { exact: true }).fill(email);
  await page.getByLabel("Straße").fill("Teststraße");
  await page.getByLabel("Hausnummer").fill("1");
  await page.getByLabel("Postleitzahl").fill("00000");
  await page.getByLabel("Ort", { exact: true }).fill("Teststadt");
  await page.getByLabel("Gewünschte Leistung").selectOption({ index: 1 });
  await page.getByLabel("Objektart").selectOption({ index: 1 });
  await page.getByLabel("Gewünschte Häufigkeit").selectOption({ index: 1 });
}

test.describe("service request (lead) form", () => {
  test("stores a request only with the privacy acknowledgement and without price/booking", async ({
    page,
  }) => {
    const violations = await collectCspViolations(page);
    const email = uniqueTestEmail("e2e-request");
    await page.goto("/anfrage");
    await expect(page.getByRole("heading", { level: 1, name: "Reinigung anfragen" })).toBeVisible();
    await fillRequestForm(page, email);

    // The form uses noValidate: the acknowledgement is enforced by the server.
    await page.getByRole("button", { name: "Anfrage senden" }).click();
    await expect(page.locator("#privacyNoticeAcknowledged")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(await countServiceRequestsFor(email)).toBe(0);
    // Input survives the failed submission.
    await expect(page.getByLabel("E-Mail", { exact: true })).toHaveValue(email);

    await page.getByLabel(/Datenschutzhinweise/).check();
    await page.getByRole("button", { name: "Anfrage senden" }).click();
    await expect(page.getByRole("status")).toContainText("Vielen Dank für Ihre Anfrage");
    await expect(page.getByRole("status")).toContainText("keine Buchung");
    expect(await countServiceRequestsFor(email)).toBe(1);
    expect(violations).toEqual([]);
  });

  test("the honeypot silently drops bot submissions", async ({ page }) => {
    const email = uniqueTestEmail("e2e-bot");
    await page.goto("/anfrage");
    await fillRequestForm(page, email);
    await page.getByLabel(/Datenschutzhinweise/).check();
    // Invisible to humans (off-screen, aria-hidden); bots fill it.
    await page.locator("#website").evaluate((el) => {
      (el as HTMLInputElement).value = "https://spam.example";
    });
    await page.getByRole("button", { name: "Anfrage senden" }).click();
    await expect(page.getByRole("status")).toBeVisible();
    expect(await countServiceRequestsFor(email)).toBe(0);
  });
});
