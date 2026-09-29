import { eq, schema, type DbExecutor } from "@isela/database";
import { isRole } from "./permissions.ts";
import type { Actor, RoleAssignment } from "./policy.ts";

/**
 * Loads the authorization principal for a user id taken from a verified session.
 * Unknown role keys are ignored (fail closed).
 */
export async function loadActor(db: DbExecutor, userId: string): Promise<Actor | null> {
  const [account] = await db
    .select({ id: schema.user.id, twoFactorEnabled: schema.user.twoFactorEnabled })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  if (account === undefined) {
    return null;
  }
  const rows = await db
    .select({
      roleKey: schema.userRole.roleKey,
      customerId: schema.userRole.customerId,
      partnerId: schema.userRole.partnerId,
      isScopeAdmin: schema.userRole.isScopeAdmin,
    })
    .from(schema.userRole)
    .where(eq(schema.userRole.userId, userId));

  const roles: RoleAssignment[] = [];
  for (const row of rows) {
    if (isRole(row.roleKey)) {
      roles.push({
        role: row.roleKey,
        customerId: row.customerId,
        partnerId: row.partnerId,
        isScopeAdmin: row.isScopeAdmin,
      });
    }
  }
  return { userId: account.id, mfaEnabled: account.twoFactorEnabled, roles };
}
