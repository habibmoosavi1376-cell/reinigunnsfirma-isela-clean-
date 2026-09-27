import { recordAudit } from "@isela/audit";
import {
  assertCanGrantRole,
  auditActorOf,
  authorize,
  requireActor,
  type ServiceContext,
} from "@isela/auth";
import { and, asc, eq, schema } from "@isela/database";
import { DomainError } from "@isela/shared";
import { normalizeEmail, parseInput, trimmedText, z } from "@isela/validation";
import { registerCustomerInTransaction } from "./customers.ts";
import { hashIdentity, type CrmConfig, type IdentityKind } from "./identity.ts";

/*
 * Lead → customer → account linking (the open point from Day 2).
 *
 * - Staff only, server-side authorised. The browser never supplies a customer id, user id,
 *   coordinates or status: customers are derived from the lead's own data through the
 *   existing duplicate detection, accounts from the contact's verified e-mail address.
 * - A returning customer (same e-mail, tax id or payment reference – after normalisation)
 *   always resolves to the EXISTING record, so a new account can never reset payment or
 *   risk history.
 * - Each step is audited; an account can be linked to at most one customer (unique index).
 */

const linkLeadInput = z.strictObject({
  leadId: z.uuid(),
  taxId: trimmedText(40).optional(),
  paymentReference: trimmedText(64).optional(),
});

export type LinkLeadResult =
  | { readonly outcome: "ALREADY_LINKED"; readonly customerId: string }
  | {
      readonly outcome: "CREATED";
      readonly customerId: string;
      readonly duplicateReviewRequired: boolean;
    }
  | {
      readonly outcome: "EXISTING_CUSTOMER";
      readonly customerId: string;
      readonly matchedBy: IdentityKind;
    };

export async function linkLeadToCustomer(
  ctx: ServiceContext,
  input: unknown,
  config: CrmConfig,
): Promise<LinkLeadResult> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "lead:read");
  authorize(actor, "customer:create");
  const data = parseInput(linkLeadInput, input);

  return ctx.db.transaction(async (tx) => {
    const r = schema.serviceRequest;
    const [request] = await tx
      .select({
        id: r.id,
        customerId: r.customerId,
        customerType: r.customerType,
        companyName: schema.lead.companyName,
      })
      .from(r)
      .innerJoin(schema.lead, eq(schema.lead.id, r.leadId))
      .where(eq(r.leadId, data.leadId))
      .for("update", { of: r })
      .limit(1);
    if (request === undefined) {
      throw new DomainError("NOT_FOUND", "Lead has no service request");
    }
    if (request.customerId !== null) {
      return { outcome: "ALREADY_LINKED", customerId: request.customerId };
    }
    const [contact] = await tx
      .select({
        fullName: schema.leadContact.fullName,
        email: schema.leadContact.email,
        phone: schema.leadContact.phone,
      })
      .from(schema.leadContact)
      .where(eq(schema.leadContact.leadId, data.leadId))
      .orderBy(asc(schema.leadContact.createdAt), asc(schema.leadContact.id))
      .limit(1);
    if (contact === undefined) {
      throw new DomainError("NOT_FOUND", "Lead has no contact");
    }

    const isCompany = request.customerType !== "PRIVATE";
    const result = await registerCustomerInTransaction(
      tx,
      actor,
      {
        kind: request.customerType,
        displayName: isCompany ? request.companyName : contact.fullName,
        companyName: isCompany ? request.companyName : null,
        email: contact.email,
        phone: contact.phone,
        taxId: data.taxId ?? null,
        paymentReference: data.paymentReference ?? null,
      },
      config,
      ctx.correlationId,
    );

    await tx.update(r).set({ customerId: result.customerId }).where(eq(r.id, request.id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "lead.customer_linked",
      entityType: "lead",
      entityId: data.leadId,
      after: {
        customerId: result.customerId,
        outcome: result.outcome,
        matchedBy: result.outcome === "EXISTING_CUSTOMER" ? result.matchedBy : null,
      },
      correlationId: ctx.correlationId,
    });
    return result;
  });
}

const linkAccountInput = z.strictObject({ leadId: z.uuid() });

export type LinkAccountResult =
  | { readonly outcome: "LINKED"; readonly customerId: string; readonly userId: string }
  | { readonly outcome: "ALREADY_LINKED"; readonly customerId: string; readonly userId: string };

/**
 * Grants the scoped CUSTOMER role to the account whose VERIFIED e-mail address equals the
 * lead contact's address AND is a registered identity of the linked customer. No ids are
 * accepted from the caller.
 */
export async function linkAccountToCustomer(
  ctx: ServiceContext,
  input: unknown,
  config: CrmConfig,
): Promise<LinkAccountResult> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "customer:link_account");
  const { leadId } = parseInput(linkAccountInput, input);

  return ctx.db.transaction(async (tx) => {
    const [request] = await tx
      .select({ customerId: schema.serviceRequest.customerId })
      .from(schema.serviceRequest)
      .where(eq(schema.serviceRequest.leadId, leadId))
      .limit(1);
    const customerId = request?.customerId ?? null;
    if (customerId === null) {
      throw new DomainError("INVALID_STATE_TRANSITION", "Link the lead to a customer first");
    }
    assertCanGrantRole(actor, {
      role: "CUSTOMER",
      customerId,
      partnerId: null,
      isScopeAdmin: false,
    });

    const [contact] = await tx
      .select({ email: schema.leadContact.email })
      .from(schema.leadContact)
      .where(eq(schema.leadContact.leadId, leadId))
      .orderBy(asc(schema.leadContact.createdAt), asc(schema.leadContact.id))
      .limit(1);
    if (contact?.email == null) {
      throw new DomainError("NOT_FOUND", "Lead contact has no e-mail address");
    }
    const email = normalizeEmail(contact.email);
    const [account] = await tx
      .select({ id: schema.user.id, emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1);
    if (account === undefined || !account.emailVerified) {
      throw new DomainError("NOT_FOUND", "No verified account with this e-mail address");
    }

    // The account's e-mail must be a registered identity of exactly this customer.
    const [identity] = await tx
      .select({ id: schema.customerIdentity.id })
      .from(schema.customerIdentity)
      .where(
        and(
          eq(schema.customerIdentity.customerId, customerId),
          eq(schema.customerIdentity.kind, "EMAIL"),
          eq(schema.customerIdentity.valueHash, hashIdentity(config, "EMAIL", email)),
        ),
      )
      .limit(1);
    if (identity === undefined) {
      throw new DomainError(
        "POLICY_VIOLATION",
        "Account e-mail is not an identity of this customer",
      );
    }

    const [existing] = await tx
      .select({ customerId: schema.userRole.customerId })
      .from(schema.userRole)
      .where(and(eq(schema.userRole.userId, account.id), eq(schema.userRole.roleKey, "CUSTOMER")))
      .limit(1);
    if (existing !== undefined) {
      if (existing.customerId === customerId) {
        return { outcome: "ALREADY_LINKED", customerId, userId: account.id };
      }
      throw new DomainError("CONFLICT", "Account is already linked to another customer");
    }

    await tx.insert(schema.userRole).values({
      userId: account.id,
      roleKey: "CUSTOMER",
      customerId,
      grantedByUserId: actor.userId,
    });
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "customer.account_linked",
      entityType: "customer",
      entityId: customerId,
      after: { userId: account.id, role: "CUSTOMER", viaLeadId: leadId },
      correlationId: ctx.correlationId,
    });
    return { outcome: "LINKED", customerId, userId: account.id };
  });
}
