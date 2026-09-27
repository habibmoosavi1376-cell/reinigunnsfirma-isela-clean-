import { recordAudit } from "@isela/audit";
import {
  assertCanGrantRole,
  auditActorOf,
  authorize,
  requireActor,
  type ServiceContext,
} from "@isela/auth";
import { and, asc, consumeRateLimit, eq, isNull, schema } from "@isela/database";
import { DomainError } from "@isela/shared";
import { normalizeEmail, parseInput, trimmedText, z } from "@isela/validation";
import { ensureAddressFromRequest } from "./addresses.ts";
import { registerCustomerInTransaction } from "./customers.ts";
import { hashIdentity, keyedHash, type CrmConfig, type IdentityKind } from "./identity.ts";

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
  authorize(actor, "customer_address:write");
  const data = parseInput(linkLeadInput, input);

  return ctx.db.transaction(async (tx) => {
    const r = schema.serviceRequest;
    const [request] = await tx
      .select({
        id: r.id,
        customerId: r.customerId,
        customerAddressId: r.customerAddressId,
        customerType: r.customerType,
        companyName: schema.lead.companyName,
        street: r.street,
        houseNumber: r.houseNumber,
        postalCode: r.postalCode,
        city: r.city,
        country: r.country,
        latitude: r.latitude,
        longitude: r.longitude,
        geocodingStatus: r.geocodingStatus,
        serviceAreaCheckedAt: r.serviceAreaCheckedAt,
      })
      .from(r)
      .innerJoin(schema.lead, eq(schema.lead.id, r.leadId))
      .where(eq(r.leadId, data.leadId))
      .for("update", { of: r })
      .limit(1);
    if (request === undefined) {
      throw new DomainError("NOT_FOUND", "Lead has no service request");
    }

    /** Lead → CustomerAddress: reuse or create the service address (audited, idempotent). */
    const linkAddress = async (customerId: string): Promise<string> => {
      if (request.customerAddressId !== null) return request.customerAddressId;
      const { addressId, created } = await ensureAddressFromRequest(
        tx,
        customerId,
        request,
        ctx.clock.now(),
      );
      await tx.update(r).set({ customerId, customerAddressId: addressId }).where(eq(r.id, request.id));
      if (created) {
        await recordAudit(tx, {
          actor: auditActorOf(actor),
          action: "customer_address.created",
          entityType: "customer_address",
          entityId: addressId,
          after: { customerId, addressType: "SERVICE", source: "service_request", serviceRequestId: request.id },
          correlationId: ctx.correlationId,
        });
      }
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: "lead.address_linked",
        entityType: "lead",
        entityId: data.leadId,
        after: { customerId, addressId, reused: !created },
        correlationId: ctx.correlationId,
      });
      return addressId;
    };

    if (request.customerId !== null) {
      await linkAddress(request.customerId);
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
    await linkAddress(result.customerId);
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

const leadIdInput = z.strictObject({ leadId: z.uuid(), name: trimmedText(200).optional() });

export type PropertyFromLeadResult =
  | { readonly outcome: "CREATED"; readonly propertyId: string }
  | { readonly outcome: "ALREADY_CREATED"; readonly propertyId: string };

/**
 * Lead → Property: creates the property described by the request (type, area, interval) at
 * the customer address derived from the same request. Idempotent per request (row lock).
 */
export async function createPropertyFromLead(
  ctx: ServiceContext,
  input: unknown,
): Promise<PropertyFromLeadResult> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "lead:read");
  authorize(actor, "property:write");
  const data = parseInput(leadIdInput, input);
  return ctx.db.transaction(async (tx) => {
    const r = schema.serviceRequest;
    const [request] = await tx
      .select({
        id: r.id,
        customerId: r.customerId,
        customerAddressId: r.customerAddressId,
        propertyId: r.propertyId,
        propertyType: r.propertyType,
        approximateAreaSqm: r.approximateAreaSqm,
        frequency: r.frequency,
        street: r.street,
        houseNumber: r.houseNumber,
        city: r.city,
      })
      .from(r)
      .where(eq(r.leadId, data.leadId))
      .for("update")
      .limit(1);
    if (request === undefined) {
      throw new DomainError("NOT_FOUND", "Lead has no service request");
    }
    if (request.propertyId !== null) {
      return { outcome: "ALREADY_CREATED", propertyId: request.propertyId };
    }
    if (request.customerId === null || request.customerAddressId === null) {
      throw new DomainError("INVALID_STATE_TRANSITION", "Link the lead to a customer first");
    }
    const [row] = await tx
      .insert(schema.property)
      .values({
        customerId: request.customerId,
        addressId: request.customerAddressId,
        name: data.name ?? `${request.street} ${request.houseNumber}, ${request.city}`,
        propertyType: request.propertyType,
        areaSqm: request.approximateAreaSqm,
        serviceFrequency: request.frequency,
      })
      .returning({ id: schema.property.id });
    if (row === undefined) {
      throw new DomainError("CONFLICT", "Property could not be created");
    }
    await tx.update(r).set({ propertyId: row.id }).where(eq(r.id, request.id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "property.created",
      entityType: "property",
      entityId: row.id,
      after: {
        customerId: request.customerId,
        addressId: request.customerAddressId,
        propertyType: request.propertyType,
        source: "service_request",
        serviceRequestId: request.id,
      },
      correlationId: ctx.correlationId,
    });
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "lead.property_linked",
      entityType: "lead",
      entityId: data.leadId,
      after: { customerId: request.customerId, propertyId: row.id },
      correlationId: ctx.correlationId,
    });
    return { outcome: "CREATED", propertyId: row.id };
  });
}

/** Limits for invitations sent from the back office. */
export const INVITATION_LIMITS = { perCustomerPerDay: 3, perActorPerHour: 20 } as const;

export interface LeadInvitationDeps {
  readonly config: CrmConfig;
  /** Creates and sends the invitation (existing auth flow: hashed one-time token, expiry). */
  readonly invite: (
    ctx: ServiceContext,
    input: { email: string; role: "CUSTOMER"; customerId: string },
  ) => Promise<{ invitationId: string; expiresAt: Date }>;
}

/**
 * Lead → (existing or new) customer → invitation to create/link an account. Only for the
 * lead contact's e-mail address, and only if it is a registered identity of exactly the
 * linked customer (no invitation to foreign or unverified customer assignments). Older open
 * invitations for the same address and customer are revoked (one valid token at a time).
 * Rate-limited per customer and per staff member.
 */
export async function inviteLeadContact(
  ctx: ServiceContext,
  input: unknown,
  deps: LeadInvitationDeps,
): Promise<{ invitationId: string; expiresAt: Date }> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "lead:read");
  authorize(actor, "customer:link_account");
  const { leadId } = parseInput(linkAccountInput, input);

  const [request] = await ctx.db
    .select({ customerId: schema.serviceRequest.customerId })
    .from(schema.serviceRequest)
    .where(eq(schema.serviceRequest.leadId, leadId))
    .limit(1);
  const customerId = request?.customerId ?? null;
  if (customerId === null) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Link the lead to a customer first");
  }
  const [contact] = await ctx.db
    .select({ email: schema.leadContact.email, suppressed: schema.leadContact.suppressed })
    .from(schema.leadContact)
    .where(eq(schema.leadContact.leadId, leadId))
    .orderBy(asc(schema.leadContact.createdAt), asc(schema.leadContact.id))
    .limit(1);
  if (contact?.email == null) {
    throw new DomainError("NOT_FOUND", "Lead contact has no e-mail address");
  }
  if (contact.suppressed) {
    throw new DomainError("POLICY_VIOLATION", "Contact objected to contact (suppressed)");
  }
  const email = normalizeEmail(contact.email);
  const [identity] = await ctx.db
    .select({ id: schema.customerIdentity.id })
    .from(schema.customerIdentity)
    .where(
      and(
        eq(schema.customerIdentity.customerId, customerId),
        eq(schema.customerIdentity.kind, "EMAIL"),
        eq(schema.customerIdentity.valueHash, hashIdentity(deps.config, "EMAIL", email)),
      ),
    )
    .limit(1);
  if (identity === undefined) {
    throw new DomainError("POLICY_VIOLATION", "E-mail is not an identity of this customer");
  }
  const [linked] = await ctx.db
    .select({ customerId: schema.userRole.customerId })
    .from(schema.userRole)
    .innerJoin(schema.user, eq(schema.user.id, schema.userRole.userId))
    .where(and(eq(schema.user.email, email), eq(schema.userRole.roleKey, "CUSTOMER")))
    .limit(1);
  if (linked !== undefined) {
    throw new DomainError("CONFLICT", "An account with this e-mail is already linked");
  }

  const now = ctx.clock.now();
  const perCustomer = await consumeRateLimit(
    ctx.db,
    `invitation:customer:${keyedHash(deps.config, "invitation-customer", customerId)}`,
    INVITATION_LIMITS.perCustomerPerDay,
    24 * 3600,
    now,
  );
  const perActor = await consumeRateLimit(
    ctx.db,
    `invitation:actor:${keyedHash(deps.config, "invitation-actor", actor.userId)}`,
    INVITATION_LIMITS.perActorPerHour,
    3600,
    now,
  );
  if (!perCustomer.allowed || !perActor.allowed) {
    throw new DomainError("RATE_LIMITED", "Too many invitations, please try again later");
  }

  await ctx.db.transaction(async (tx) => {
    const revoked = await tx
      .update(schema.invitation)
      .set({ revokedAt: now })
      .where(
        and(
          eq(schema.invitation.emailNormalized, email),
          eq(schema.invitation.customerId, customerId),
          isNull(schema.invitation.acceptedAt),
          isNull(schema.invitation.revokedAt),
        ),
      )
      .returning({ id: schema.invitation.id });
    for (const row of revoked) {
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: "auth.invitation_revoked",
        entityType: "invitation",
        entityId: row.id,
        after: { reason: "superseded" },
        correlationId: ctx.correlationId,
      });
    }
  });
  const result = await deps.invite(ctx, { email, role: "CUSTOMER", customerId });
  await ctx.db.transaction(async (tx) => {
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "lead.customer_invited",
      entityType: "lead",
      entityId: leadId,
      after: { customerId, invitationId: result.invitationId },
      correlationId: ctx.correlationId,
    });
  });
  return result;
}

