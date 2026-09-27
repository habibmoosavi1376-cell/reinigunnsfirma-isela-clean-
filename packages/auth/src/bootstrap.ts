import { recordAudit } from "@isela/audit";
import { eq, schema, sql, type Database } from "@isela/database";
import { DomainError } from "@isela/shared";

/**
 * Grants SUPER_ADMIN to the first verified user. Refuses when a SUPER_ADMIN already exists,
 * so the function cannot be used to escalate privileges later. Intended for an operator
 * CLI during initial setup; the grant is audited as a SYSTEM action.
 */
export async function bootstrapSuperAdmin(db: Database, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialise concurrent bootstrap attempts.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('isela.bootstrap_super_admin'))`);
    const [existing] = await tx
      .select({ id: schema.userRole.id })
      .from(schema.userRole)
      .where(eq(schema.userRole.roleKey, "SUPER_ADMIN"))
      .limit(1);
    if (existing !== undefined) {
      throw new DomainError("CONFLICT", "A SUPER_ADMIN already exists");
    }
    const [account] = await tx
      .select({ emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .limit(1);
    if (account?.emailVerified !== true) {
      throw new DomainError("VALIDATION_FAILED", "User must exist and have a verified e-mail");
    }
    await tx.insert(schema.userRole).values({ userId, roleKey: "SUPER_ADMIN" });
    await recordAudit(tx, {
      actor: { type: "SYSTEM" },
      action: "auth.super_admin_bootstrapped",
      entityType: "user",
      entityId: userId,
    });
  });
}
