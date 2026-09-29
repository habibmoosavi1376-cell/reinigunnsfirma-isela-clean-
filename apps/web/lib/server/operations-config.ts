import "server-only";
import type { DbExecutor } from "@isela/database";
import type { OperationsConfig, PaymentPolicySnapshot } from "@isela/operations";
import { GLOBAL_SCOPE, getEffectiveSetting } from "@isela/settings";
import type { Clock } from "@isela/shared";

/** Effective operations configuration (versioned setting `operations.assignment`). */
export async function loadOperationsConfig(
  db: DbExecutor,
  clock: Clock,
): Promise<OperationsConfig> {
  const setting = await getEffectiveSetting(db, "operations.assignment", GLOBAL_SCOPE, clock.now());
  return setting.value;
}

/** Effective payment policy with its version (for the booking's decision snapshot). */
export async function loadPaymentPolicy(
  db: DbExecutor,
  clock: Clock,
): Promise<PaymentPolicySnapshot> {
  const setting = await getEffectiveSetting(db, "payment.policy", GLOBAL_SCOPE, clock.now());
  return { policy: setting.value, version: setting.version };
}
