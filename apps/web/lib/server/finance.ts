import "server-only";
import type { FinanceOptions, InvoiceIssuer } from "@isela/billing";
import type { DbExecutor } from "@isela/database";
import type { JobPaymentContext } from "@isela/operations";
import { GLOBAL_SCOPE, getEffectiveSetting } from "@isela/settings";
import type { Clock } from "@isela/shared";
import { loadOperationsConfig, loadPaymentPolicy } from "./operations-config";
import { getServices } from "./services";

/**
 * Effective finance configuration for one request: versioned payment policy, business time
 * zone (operations config) and billing configuration (`billing.config`, CONFIG_REQUIRED by
 * default). Always loaded on the server – never from the browser.
 */
export async function loadFinanceOptions(db: DbExecutor, clock: Clock): Promise<FinanceOptions> {
  const [paymentPolicy, operations, billing] = await Promise.all([
    loadPaymentPolicy(db, clock),
    loadOperationsConfig(db, clock),
    getEffectiveSetting(db, "billing.config", GLOBAL_SCOPE, clock.now()),
  ]);
  return {
    paymentPolicy,
    timeZone: operations.timeZone,
    billing: billing.value,
    issuer: invoiceIssuerFromEnv(),
  };
}

/** Payment context for the job-start guard (credit-terms re-evaluation). */
export async function loadJobPaymentContext(
  db: DbExecutor,
  clock: Clock,
): Promise<JobPaymentContext> {
  const [paymentPolicy, operations] = await Promise.all([
    loadPaymentPolicy(db, clock),
    loadOperationsConfig(db, clock),
  ]);
  return { paymentPolicy, timeZone: operations.timeZone };
}

/**
 * Invoice issuer from the legal configuration (BUSINESS_*). Incomplete data yields null, and
 * issuing an invoice is refused with CONFIG_REQUIRED – nothing is filled in or guessed.
 */
function invoiceIssuerFromEnv(): InvoiceIssuer | null {
  const env = getServices().env;
  if (
    env.BUSINESS_LEGAL_NAME === undefined ||
    env.BUSINESS_STREET === undefined ||
    env.BUSINESS_POSTAL_CODE === undefined ||
    env.BUSINESS_CITY === undefined
  ) {
    return null;
  }
  return {
    legalName: env.BUSINESS_LEGAL_NAME,
    street: env.BUSINESS_STREET,
    postalCode: env.BUSINESS_POSTAL_CODE,
    city: env.BUSINESS_CITY,
    vatId: env.BUSINESS_VAT_ID ?? null,
    taxNumber: env.BUSINESS_TAX_NUMBER ?? null,
  };
}
