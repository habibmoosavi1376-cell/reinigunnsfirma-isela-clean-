import { and, eq, schema, type Database } from "@isela/database";
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Permission, type Role } from "./permissions.ts";

/**
 * Synchronises the code-defined RBAC catalogue into the database (idempotent).
 * Role/permission rows are upserted; role→permission mappings that no longer exist in
 * code are removed so that the database mirrors the reviewed matrix exactly.
 */
export async function syncRbacCatalog(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [key, description] of Object.entries(ROLES)) {
      await tx
        .insert(schema.role)
        .values({ key, description })
        .onConflictDoUpdate({ target: schema.role.key, set: { description } });
    }
    for (const [key, description] of Object.entries(PERMISSIONS)) {
      await tx
        .insert(schema.permission)
        .values({ key, description })
        .onConflictDoUpdate({ target: schema.permission.key, set: { description } });
    }

    const desired = new Set<string>();
    for (const [roleKey, grants] of Object.entries(ROLE_PERMISSIONS) as [
      Role,
      Partial<Record<Permission, "GLOBAL" | "OWN">>,
    ][]) {
      for (const [permissionKey, scope] of Object.entries(grants)) {
        desired.add(`${roleKey}|${permissionKey}`);
        await tx
          .insert(schema.rolePermission)
          .values({ roleKey, permissionKey, scope })
          .onConflictDoUpdate({
            target: [schema.rolePermission.roleKey, schema.rolePermission.permissionKey],
            set: { scope },
          });
      }
    }

    const existing = await tx
      .select({
        roleKey: schema.rolePermission.roleKey,
        permissionKey: schema.rolePermission.permissionKey,
      })
      .from(schema.rolePermission);
    for (const row of existing) {
      if (!desired.has(`${row.roleKey}|${row.permissionKey}`)) {
        await tx
          .delete(schema.rolePermission)
          .where(
            and(
              eq(schema.rolePermission.roleKey, row.roleKey),
              eq(schema.rolePermission.permissionKey, row.permissionKey),
            ),
          );
      }
    }
  });
}
