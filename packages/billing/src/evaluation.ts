import { recordAudit, type AuditActor } from "@isela/audit";
import type { Transaction } from "@isela/database";
import {
  evaluateCustomerPaymentTerms,
  paymentPolicySchema,
  recordPaymentRiskEvaluation,
  type PaymentTermsEvaluation,
  type RiskEvaluationTrigger,
} from "@isela/payment-risk";
import type { FinanceOptions } from "./internal.ts";

/**
 * Re-evaluates the customer's payment terms with the central engine, appends the result to
 * the risk log and audits an outcome change (no amounts, no personal data).
 */
export async function reevaluateCustomer(
  tx: Transaction,
  customerId: string,
  trigger: RiskEvaluationTrigger,
  options: FinanceOptions,
  audit: {
    readonly actor: AuditActor;
    readonly actorUserId: string | null;
    readonly now: Date;
    readonly correlationId: string | undefined;
  },
): Promise<PaymentTermsEvaluation> {
  const evaluation = await evaluateCustomerPaymentTerms(tx, customerId, {
    policy: paymentPolicySchema.parse(options.paymentPolicy.policy),
    now: audit.now,
    timeZone: options.timeZone,
  });
  const { changed, previousOutcome } = await recordPaymentRiskEvaluation(tx, {
    customerId,
    evaluation,
    policyVersion: options.paymentPolicy.version,
    trigger,
    actorUserId: audit.actorUserId,
    now: audit.now,
  });
  if (changed) {
    await recordAudit(tx, {
      actor: audit.actor,
      action: "payment_risk.evaluation_changed",
      entityType: "customer",
      entityId: customerId,
      before: { outcome: previousOutcome },
      after: {
        outcome: evaluation.decision.outcome,
        reasons: [...evaluation.decision.reasons],
        trigger,
      },
      correlationId: audit.correlationId,
    });
  }
  return evaluation;
}
