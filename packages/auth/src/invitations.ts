import { createHash, randomBytes } from "node:crypto";
import { recordAudit } from "@isela/audit";
import { and, eq, isNull, schema } from "@isela/database";
import type { EmailSender } from "@isela/notifications";
import { DomainError } from "@isela/shared";
import { emailSchema, normalizeEmail, parseInput, z } from "@isela/validation";
import { auditActorOf, type ServiceContext } from "./context.ts";
import { ROLES, type Role } from "./permissions.ts";
import { assertCanGrantRole, requireActor } from "./policy.ts";

const INVITATION_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const ROLE_KEYS = Object.keys(ROLES) as [Role, ...Role[]];

const createInvitationInput = z.strictObject({
  email: emailSchema,
  role: z.enum(ROLE_KEYS),
  customerId: z.uuid().nullable().default(null),
  partnerId: z.uuid().nullable().default(null),
  isScopeAdmin: z.boolean().default(false),
});

const acceptInvitationInput = z.strictObject({
  token: z.string().min(32).max(128),
});

export interface InvitationDeps {
  readonly emailSender: EmailSender;
  /** Builds the acceptance link sent by e-mail, e.g. `${baseUrl}/invitation?token=…`. */
  readonly acceptUrl: (token: string) => string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Invites a user (B2B customer users, partner staff, internal roles). The inviter can only
 * grant roles they are allowed to grant (privilege-escalation guard). The token is sent by
 * e-mail only; the database stores its SHA-256 hash.
 */
export async function createInvitation(
  ctx: ServiceContext,
  input: unknown,
  deps: InvitationDeps,
): Promise<{ invitationId: string; expiresAt: Date }> {
  const actor = requireActor(ctx.actor);
  const data = parseInput(createInvitationInput, input);
  assertCanGrantRole(actor, data);

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(ctx.clock.now().getTime() + INVITATION_VALIDITY_MS);
  const email = normalizeEmail(data.email);

  const invitationId = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.invitation)
      .values({
        emailNormalized: email,
        tokenHash: hashToken(token),
        roleKey: data.role,
        customerId: data.customerId,
        partnerId: data.partnerId,
        isScopeAdmin: data.isScopeAdmin,
        invitedByUserId: actor.userId,
        expiresAt,
      })
      .returning({ id: schema.invitation.id });
    if (row === undefined) {
      throw new DomainError("CONFLICT", "Invitation could not be created");
    }
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "auth.invitation_created",
      entityType: "invitation",
      entityId: row.id,
      after: {
        role: data.role,
        customerId: data.customerId,
        partnerId: data.partnerId,
        isScopeAdmin: data.isScopeAdmin,
        expiresAt,
      },
      correlationId: ctx.correlationId,
    });
    return row.id;
  });

  await deps.emailSender.send({
    to: email,
    subject: "ISELA CLEAN – Einladung",
    text: `Sie wurden zu ISELA CLEAN eingeladen. Einladung annehmen (7 Tage gültig): ${deps.acceptUrl(token)}`,
    purpose: "auth.invitation",
  });

  return { invitationId, expiresAt };
}

/**
 * Accepts an invitation for the signed-in user. The user's e-mail must be verified and must
 * match the invited address. Invalid, expired, revoked or used tokens yield NOT_FOUND
 * without revealing which condition failed.
 */
export async function acceptInvitation(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  const { token } = parseInput(acceptInvitationInput, input);
  const now = ctx.clock.now();

  await ctx.db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.tokenHash, hashToken(token)),
          isNull(schema.invitation.acceptedAt),
          isNull(schema.invitation.revokedAt),
        ),
      )
      .for("update")
      .limit(1);
    const [account] = await tx
      .select({ email: schema.user.email, emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.id, actor.userId))
      .limit(1);

    if (
      invitation === undefined ||
      invitation.expiresAt.getTime() <= now.getTime() ||
      account === undefined ||
      !account.emailVerified ||
      normalizeEmail(account.email) !== invitation.emailNormalized
    ) {
      throw new DomainError("NOT_FOUND", "Invitation not found or no longer valid");
    }

    await tx
      .insert(schema.userRole)
      .values({
        userId: actor.userId,
        roleKey: invitation.roleKey,
        customerId: invitation.customerId,
        partnerId: invitation.partnerId,
        isScopeAdmin: invitation.isScopeAdmin,
        grantedByUserId: invitation.invitedByUserId,
      })
      .onConflictDoNothing();
    await tx
      .update(schema.invitation)
      .set({ acceptedAt: now, acceptedByUserId: actor.userId })
      .where(eq(schema.invitation.id, invitation.id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "auth.invitation_accepted",
      entityType: "invitation",
      entityId: invitation.id,
      after: { role: invitation.roleKey, userId: actor.userId },
      correlationId: ctx.correlationId,
    });
  });
}
