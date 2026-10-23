import { recordAudit } from "@isela/audit";
import { eq, schema } from "@isela/database";
import { parseInput, z } from "@isela/validation";
import { auditActorOf, type ServiceContext } from "./context.ts";
import { authorize, requireActor } from "./policy.ts";

const revokeInput = z.strictObject({ userId: z.string().min(1).max(64) });

/**
 * Revokes all sessions of a user. Users may revoke their own sessions; revoking another
 * user's sessions requires `session:revoke_any`. Sessions are database-backed without
 * cookie cache, so revocation takes effect on the next request.
 */
export async function revokeAllSessions(ctx: ServiceContext, input: unknown): Promise<number> {
  const actor = requireActor(ctx.actor);
  const { userId } = parseInput(revokeInput, input);
  if (actor.userId !== userId) {
    authorize(actor, "session:revoke_any");
  }
  return ctx.db.transaction(async (tx) => {
    const removed = await tx
      .delete(schema.session)
      .where(eq(schema.session.userId, userId))
      .returning({ id: schema.session.id });
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "auth.sessions_revoked",
      entityType: "user",
      entityId: userId,
      after: { revokedSessions: removed.length },
      correlationId: ctx.correlationId,
    });
    return removed.length;
  });
}
