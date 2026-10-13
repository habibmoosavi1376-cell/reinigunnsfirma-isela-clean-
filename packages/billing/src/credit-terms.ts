import { recordAudit } from "@isela/audit";
import { auditActorOf, requireActor, type ServiceContext } from "@isela/auth";
import { and, eq, schema, type Transaction } from "@isela/database";
import { protectCustomerBookings } from "@isela/operations";
import { businessDateOf, lockCustomerFinance, paymentPolicySchema } from "@isela/payment-risk";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import { reevaluateCustomer } from "./evaluation.ts";
import { pgErrorCode, requireGlobal, type FinanceOptions } from "./internal.ts";

/*
 * Credit-terms approval flow: REQUESTED → APPROVED | DENIED; APPROVED → REVOKED.
 * - A request is possible only when the central engine reports the binding minimum
 *   (≥ policy.minSuccessfulPaidOrders completed AND paid jobs, no overdue invoice, no
 *   chargeback, no payment problems, no pending duplicate review, B2C rule) – the minimum is
 *   a precondition, never an approval.
 * - Approval is a decision of a SECOND person (credit_terms:approve: SUPER_ADMIN/FINANCE,
 *   MFA enforced for these roles), with a credit limit (≤ the policy's upper bound), an
 *   internal trust assessment and a reason. The database enforces four-eyes as well.
 * - Revocation (e.g. after payment problems) immediately switches not yet started credit
 *   bookings back to prepayment.
 * Every step is audited and appended to the customer's risk evaluation log.
 */

type Audit = Parameters<typeof reevaluateCustomer>[4];

function auditOf(ctx: ServiceContext): Audit {
  const actor = requireActor(ctx.actor);
  return {
    actor: auditActorOf(actor),
    actorUserId: actor.userId,
    now: ctx.clock.now(),
    correlationId: ctx.correlationId,
  };
}

const requestInput = z.strictObject({
  customerId: z.uuid(),
  reason: z.string().trim().min(3).max(1000),
});

export async function requestCreditTerms(
  ctx: ServiceContext,
  input: unknown,
  options: FinanceOptions,
): Promise<{ approvalId: string }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "credit_terms:request");
  const data = parseInput(requestInput, input);
  const audit = auditOf(ctx);
  return ctx.db
    .transaction(async (tx) => {
      await lockCustomerFinance(tx, data.customerId);
      const evaluation = await reevaluateCustomer(
        tx,
        data.customerId,
        "CREDIT_DECISION",
        options,
        audit,
      );
      if (!evaluation.decision.invoiceReviewEligible) {
        throw new DomainError("POLICY_VIOLATION", "Minimum payment history not met", {
          reasons: evaluation.decision.reasons.join(","),
        });
      }
      const [row] = await tx
        .insert(schema.creditTermsApproval)
        .values({
          customerId: data.customerId,
          status: "REQUESTED",
          requestReason: data.reason,
          requestedByUserId: actor.userId,
          requestedAt: audit.now,
        })
        .returning({ id: schema.creditTermsApproval.id });
      if (row === undefined) throw new DomainError("CONFLICT", "Request not stored");
      await recordAudit(tx, {
        actor: audit.actor,
        action: "credit_terms.requested",
        entityType: "customer",
        entityId: data.customerId,
        after: { approvalId: row.id },
        correlationId: ctx.correlationId,
      });
      return { approvalId: row.id };
    })
    .catch((error: unknown) => {
      if (pgErrorCode(error) === "23505") {
        throw new DomainError("CONFLICT", "An open request or active approval already exists");
      }
      throw error;
    });
}

async function lockApproval(tx: Transaction, approvalId: string) {
  const [ref] = await tx
    .select({ customerId: schema.creditTermsApproval.customerId })
    .from(schema.creditTermsApproval)
    .where(eq(schema.creditTermsApproval.id, approvalId))
    .limit(1);
  if (ref === undefined) throw new DomainError("NOT_FOUND", "Credit decision not found");
  await lockCustomerFinance(tx, ref.customerId);
  const [row] = await tx
    .select()
    .from(schema.creditTermsApproval)
    .where(eq(schema.creditTermsApproval.id, approvalId))
    .for("update")
    .limit(1);
  if (row === undefined) throw new DomainError("NOT_FOUND", "Credit decision not found");
  return row;
}

const approveInput = z.strictObject({
  approvalId: z.uuid(),
  creditLimitCents: z.number().int().min(1).max(5_000_000),
  trustScore: z.number().int().min(0).max(100),
  validUntil: z.iso.date().optional(),
  reason: z.string().trim().min(3).max(1000),
});

export async function approveCreditTerms(
  ctx: ServiceContext,
  input: unknown,
  options: FinanceOptions,
): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "credit_terms:approve");
  const data = parseInput(approveInput, input);
  const policy = paymentPolicySchema.parse(options.paymentPolicy.policy);
  const audit = auditOf(ctx);
  if (data.creditLimitCents > policy.defaultCreditLimitCents) {
    throw new DomainError("POLICY_VIOLATION", "Credit limit above the policy's upper bound");
  }
  if (data.trustScore < policy.minTrustScore) {
    throw new DomainError("POLICY_VIOLATION", "Trust assessment below the policy minimum");
  }
  if (
    data.validUntil !== undefined &&
    data.validUntil < businessDateOf(audit.now, options.timeZone)
  ) {
    throw new DomainError("VALIDATION_FAILED", "The validity must not lie in the past");
  }
  await ctx.db.transaction(async (tx) => {
    const approval = await lockApproval(tx, data.approvalId);
    if (approval.status !== "REQUESTED") {
      throw new DomainError("INVALID_STATE_TRANSITION", "The request has already been decided");
    }
    if (approval.requestedByUserId === actor.userId) {
      throw new DomainError("FORBIDDEN", "Four-eyes principle: a second person must decide", {
        guard: "FOUR_EYES",
      });
    }
    // The minimum must still hold at decision time (an invoice may have become overdue).
    const evaluation = await reevaluateCustomer(
      tx,
      approval.customerId,
      "CREDIT_DECISION",
      options,
      audit,
    );
    if (!evaluation.decision.invoiceReviewEligible) {
      throw new DomainError("POLICY_VIOLATION", "Minimum payment history no longer met", {
        reasons: evaluation.decision.reasons.join(","),
      });
    }
    const [updated] = await tx
      .update(schema.creditTermsApproval)
      .set({
        status: "APPROVED",
        creditLimitCents: data.creditLimitCents,
        trustScore: data.trustScore,
        validUntil: data.validUntil ?? null,
        decidedByUserId: actor.userId,
        decidedAt: audit.now,
        decisionReason: data.reason,
        version: approval.version + 1,
        updatedAt: audit.now,
      })
      .where(
        and(
          eq(schema.creditTermsApproval.id, approval.id),
          eq(schema.creditTermsApproval.version, approval.version),
        ),
      )
      .returning({ id: schema.creditTermsApproval.id });
    if (updated === undefined) throw new DomainError("CONFLICT", "Changed concurrently");
    await recordAudit(tx, {
      actor: audit.actor,
      action: "credit_terms.approved",
      entityType: "customer",
      entityId: approval.customerId,
      after: {
        approvalId: approval.id,
        creditLimitCents: data.creditLimitCents,
        validUntil: data.validUntil ?? null,
      },
      correlationId: ctx.correlationId,
    });
    await reevaluateCustomer(tx, approval.customerId, "CREDIT_DECISION", options, audit);
  });
}

const decisionInput = z.strictObject({
  approvalId: z.uuid(),
  reason: z.string().trim().min(3).max(1000),
});

export async function denyCreditTerms(
  ctx: ServiceContext,
  input: unknown,
  options: FinanceOptions,
): Promise<void> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "credit_terms:approve");
  const data = parseInput(decisionInput, input);
  const audit = auditOf(ctx);
  await ctx.db.transaction(async (tx) => {
    const approval = await lockApproval(tx, data.approvalId);
    if (approval.status !== "REQUESTED") {
      throw new DomainError("INVALID_STATE_TRANSITION", "The request has already been decided");
    }
    await tx
      .update(schema.creditTermsApproval)
      .set({
        status: "DENIED",
        decidedByUserId: actor.userId,
        decidedAt: audit.now,
        decisionReason: data.reason,
        version: approval.version + 1,
        updatedAt: audit.now,
      })
      .where(eq(schema.creditTermsApproval.id, approval.id));
    await recordAudit(tx, {
      actor: audit.actor,
      action: "credit_terms.denied",
      entityType: "customer",
      entityId: approval.customerId,
      after: { approvalId: approval.id },
      correlationId: ctx.correlationId,
    });
    await reevaluateCustomer(tx, approval.customerId, "CREDIT_DECISION", options, audit);
  });
}

export async function revokeCreditTerms(
  ctx: ServiceContext,
  input: unknown,
  options: FinanceOptions,
): Promise<{ bookingsSwitchedToPrepayment: number }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "credit_terms:request");
  const data = parseInput(decisionInput, input);
  const audit = auditOf(ctx);
  return ctx.db.transaction(async (tx) => {
    const approval = await lockApproval(tx, data.approvalId);
    if (approval.status !== "APPROVED") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Only active approvals can be revoked");
    }
    await tx
      .update(schema.creditTermsApproval)
      .set({
        status: "REVOKED",
        revokedByUserId: actor.userId,
        revokedAt: audit.now,
        revokeReason: data.reason,
        version: approval.version + 1,
        updatedAt: audit.now,
      })
      .where(eq(schema.creditTermsApproval.id, approval.id));
    await recordAudit(tx, {
      actor: audit.actor,
      action: "credit_terms.revoked",
      entityType: "customer",
      entityId: approval.customerId,
      after: { approvalId: approval.id },
      correlationId: ctx.correlationId,
    });
    const { reverted } = await protectCustomerBookings(
      tx,
      approval.customerId,
      "CREDIT_TERMS_REVOKED",
      audit,
    );
    await reevaluateCustomer(tx, approval.customerId, "CREDIT_DECISION", options, audit);
    return { bookingsSwitchedToPrepayment: reverted.length };
  });
}
