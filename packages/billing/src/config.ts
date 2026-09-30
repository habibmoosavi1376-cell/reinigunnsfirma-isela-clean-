import { z } from "@isela/validation";

/*
 * Billing configuration (setting key `billing.config`). Every value is an owner decision, so
 * the default is `null` = CONFIG_REQUIRED: without it no invoice is issued (no invented
 * payment terms, number formats or due dates). Tests and deployments set the values
 * explicitly through the audited settings service.
 */

export const billingConfigSchema = z.strictObject({
  /** Invoice number series prefix, e.g. an owner-chosen abbreviation (1–10 chars, A–Z/0–9). */
  invoiceNumberPrefix: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{0,9}$/)
    .nullable(),
  /** Days until a FINAL invoice (credit terms, after service) is due. */
  paymentTermDays: z.number().int().min(0).max(120).nullable(),
  /** Days until a PREPAYMENT invoice is due. */
  prepaymentDueDays: z.number().int().min(0).max(60).nullable(),
});

export type BillingConfig = z.infer<typeof billingConfigSchema>;

export const DEFAULT_BILLING_CONFIG: BillingConfig = {
  invoiceNumberPrefix: null,
  paymentTermDays: null,
  prepaymentDueDays: null,
};

export type BillingConfigKey = keyof BillingConfig;

/** Configuration keys still missing for issuing an invoice of the given kind. */
export function missingBillingConfig(
  config: BillingConfig,
  kind: "PREPAYMENT" | "FINAL",
): BillingConfigKey[] {
  const missing: BillingConfigKey[] = [];
  if (config.invoiceNumberPrefix === null) missing.push("invoiceNumberPrefix");
  if (kind === "FINAL" && config.paymentTermDays === null) missing.push("paymentTermDays");
  if (kind === "PREPAYMENT" && config.prepaymentDueDays === null) {
    missing.push("prepaymentDueDays");
  }
  return missing;
}
