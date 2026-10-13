import { authorize, type ServiceContext } from "@isela/auth";
import { asc, eq, schema } from "@isela/database";

export interface ServiceCategorySummary {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/** Active service categories in display order (data-driven, no hard-coded names). */
export async function listServiceCategories(
  ctx: ServiceContext,
): Promise<ServiceCategorySummary[]> {
  authorize(ctx.actor, "catalog:read");
  const c = schema.serviceCategory;
  return ctx.db
    .select({ id: c.id, key: c.key, name: c.name })
    .from(c)
    .where(eq(c.active, true))
    .orderBy(asc(c.sortOrder), asc(c.key));
}
