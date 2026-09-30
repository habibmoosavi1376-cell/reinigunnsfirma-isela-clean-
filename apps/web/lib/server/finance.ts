import "server-only";
import type { FinanceOptions } from "@isela/billing";
import type { DbExecutor } from "@isela/database";
import type { JobPaymentContext } from "@isela/operations";
import { GLOBAL_SCOPE, getEffectiveSetting } from "@isela/settings";
import type { Clock } from "@isela/shared";
import { loadOperationsConfig, loadPaymentPolicy } from "./operations-config";

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
  return { paymentPolicy, timeZone: operations.timeZone, billing: billing.value };
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
