import { authorize, type ServiceContext } from "@isela/auth";
import { and, eq, isNull, schema } from "@isela/database";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";

/*
 * Partner module (placeholder boundary for day 5). Only read access exists so far;
 * partner verification, assignment and settlement follow with their specifications.
 */

export interface PartnerView {
  readonly id: string;
  readonly legalName: string;
  readonly status: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED";
  readonly serviceRadiusM: number;
}

const partnerIdInput = z.strictObject({ partnerId: z.uuid() });

/** A partner user may only read its own partner record (OWN scope); staff read all. */
export async function getPartner(ctx: ServiceContext, input: unknown): Promise<PartnerView> {
  const { partnerId } = parseInput(partnerIdInput, input);
  authorize(ctx.actor, "partner:read", { partnerId });
  const p = schema.partner;
  const [row] = await ctx.db
    .select({
      id: p.id,
      legalName: p.legalName,
      status: p.status,
      serviceRadiusM: p.serviceRadiusM,
    })
    .from(p)
    .where(and(eq(p.id, partnerId), isNull(p.archivedAt)))
    .limit(1);
  if (row === undefined) {
    throw new DomainError("NOT_FOUND", "Partner not found");
  }
  return row;
}
