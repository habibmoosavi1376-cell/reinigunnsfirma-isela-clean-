import { recordAudit } from "@isela/audit";
import { auditActorOf, authorize, requireActor, type ServiceContext } from "@isela/auth";
import { and, eq, inArray, isNull, ne, schema, sql, type Transaction } from "@isela/database";
import type { Actor } from "@isela/auth";
import { DomainError } from "@isela/shared";
import { emailSchema, parseInput, phoneSchema, trimmedText, z } from "@isela/validation";
import {
  UNIQUE_IDENTITY_KINDS,
  identityHashesFor,
  type CrmConfig,
  type IdentityHash,
  type IdentityKind,
} from "./identity.ts";

export const registerCustomerInput = z
  .strictObject({
    kind: z.enum(["PRIVATE", "BUSINESS", "PROPERTY_MANAGEMENT"]),
    displayName: trimmedText(200),
    companyName: trimmedText(200).nullable().default(null),
    email: emailSchema.nullable().default(null),
    phone: phoneSchema.nullable().default(null),
    taxId: trimmedText(40).nullable().default(null),
    paymentReference: trimmedText(64).nullable().default(null),
  })
  .refine((c) => c.kind === "PRIVATE" || c.companyName !== null, {
    message: "companyName is required for business customers",
    path: ["companyName"],
  });

export type RegisterCustomerResult =
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

/**
 * Registers a customer. A returning customer (same e-mail, tax id or payment reference) is
 * resolved to the EXISTING record – a new account can never reset an existing payment
 * history. Signal matches (phone, billing address) mark the customer for duplicate review;
 * while the review is pending, prepayment is enforced by the payment policy.
 */
export async function registerCustomer(
  ctx: ServiceContext,
  input: unknown,
  config: CrmConfig,
): Promise<RegisterCustomerResult> {
  const actor = requireActor(ctx.actor);
  authorize(actor, "customer:create");
  const data = parseInput(registerCustomerInput, input);
  return ctx.db.transaction((tx) =>
    registerCustomerInTransaction(tx, actor, data, config, ctx.correlationId),
  );
}

/**
 * Transaction-scoped core of `registerCustomer` (callers must have authorized
 * `customer:create`). Used by lead → customer linking so that matching/creating the customer
 * and linking the request happen atomically.
 */
export async function registerCustomerInTransaction(
  tx: Transaction,
  actor: Actor,
  data: z.output<typeof registerCustomerInput>,
  config: CrmConfig,
  correlationId: string | undefined,
): Promise<RegisterCustomerResult> {
  const hashes = identityHashesFor(config, data);
  const uniqueHashes = hashes.filter((h) => UNIQUE_IDENTITY_KINDS.has(h.kind));
  // Serialise concurrent registrations of the same identity: the second transaction waits,
  // then finds the first one's customer instead of creating a duplicate (the unique identity
  // index stays the last line of defence). Sorted to avoid lock-order deadlocks.
  for (const valueHash of uniqueHashes.map((h) => h.valueHash).sort()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-identity:${valueHash}`}, 0))`,
    );
  }
  if (uniqueHashes.length > 0) {
    const matches = await tx
      .select({
        customerId: schema.customerIdentity.customerId,
        kind: schema.customerIdentity.kind,
      })
      .from(schema.customerIdentity)
      .where(
        and(
          inArray(
            schema.customerIdentity.kind,
            uniqueHashes.map((h) => h.kind),
          ),
          inArray(
            schema.customerIdentity.valueHash,
            uniqueHashes.map((h) => h.valueHash),
          ),
        ),
      );
    // Hashes are keyed by kind (HMAC over "KIND:value"), so cross-kind matches cannot occur.
    const matched = matches;
    const distinctCustomers = new Set(matched.map((m) => m.customerId));
    if (distinctCustomers.size > 1) {
      throw new DomainError(
        "CONFLICT",
        "Identity attributes belong to different customers; manual review required",
      );
    }
    const first = matched[0];
    if (first !== undefined) {
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: "customer.registration_matched_existing",
        entityType: "customer",
        entityId: first.customerId,
        after: { matchedBy: first.kind },
        correlationId,
      });
      return {
        outcome: "EXISTING_CUSTOMER",
        customerId: first.customerId,
        matchedBy: first.kind,
      };
    }
  }

  const [created] = await tx
    .insert(schema.customer)
    .values({
      kind: data.kind,
      displayName: data.displayName,
      companyName: data.companyName,
      createdByUserId: actor.userId,
    })
    .returning({ id: schema.customer.id });
  if (created === undefined) {
    throw new DomainError("CONFLICT", "Customer could not be created");
  }
  const duplicateReviewRequired = await attachIdentities(tx, created.id, hashes);

  await recordAudit(tx, {
    actor: auditActorOf(actor),
    action: "customer.created",
    entityType: "customer",
    entityId: created.id,
    after: {
      kind: data.kind,
      identityKinds: hashes.map((h) => h.kind),
      duplicateReviewRequired,
    },
    correlationId,
  });
  return { outcome: "CREATED", customerId: created.id, duplicateReviewRequired };
}

/**
 * Stores identity hashes for a customer and records duplicate candidates for signal kinds.
 * Returns whether a duplicate review is now pending.
 */
export async function attachIdentities(
  tx: Transaction,
  customerId: string,
  hashes: readonly IdentityHash[],
): Promise<boolean> {
  let reviewRequired = false;
  for (const hash of hashes) {
    if (!UNIQUE_IDENTITY_KINDS.has(hash.kind)) {
      const others = await tx
        .select({ customerId: schema.customerIdentity.customerId })
        .from(schema.customerIdentity)
        .where(
          and(
            eq(schema.customerIdentity.kind, hash.kind),
            eq(schema.customerIdentity.valueHash, hash.valueHash),
            ne(schema.customerIdentity.customerId, customerId),
          ),
        );
      for (const other of others) {
        await tx
          .insert(schema.customerDuplicateCandidate)
          .values({ customerId, candidateCustomerId: other.customerId, matchedBy: hash.kind })
          .onConflictDoNothing();
        reviewRequired = true;
      }
    }
    await tx
      .insert(schema.customerIdentity)
      .values({ customerId, kind: hash.kind, valueHash: hash.valueHash })
      .onConflictDoNothing({
        target: [
          schema.customerIdentity.customerId,
          schema.customerIdentity.kind,
          schema.customerIdentity.valueHash,
        ],
      });
  }
  if (reviewRequired) {
    await tx
      .update(schema.customer)
      .set({ duplicateReviewStatus: "PENDING" })
      .where(eq(schema.customer.id, customerId));
  }
  return reviewRequired;
}

export interface CustomerView {
  readonly id: string;
  readonly kind: "PRIVATE" | "BUSINESS" | "PROPERTY_MANAGEMENT";
  readonly displayName: string;
  readonly companyName: string | null;
  readonly status: "ACTIVE" | "INACTIVE" | "BLOCKED";
  readonly duplicateReviewStatus: "NONE" | "PENDING";
}

const customerIdInput = z.strictObject({ customerId: z.uuid() });

export async function getCustomer(ctx: ServiceContext, input: unknown): Promise<CustomerView> {
  const { customerId } = parseInput(customerIdInput, input);
  authorize(ctx.actor, "customer:read", { customerId });
  const c = schema.customer;
  const [row] = await ctx.db
    .select({
      id: c.id,
      kind: c.kind,
      displayName: c.displayName,
      companyName: c.companyName,
      status: c.status,
      duplicateReviewStatus: c.duplicateReviewStatus,
    })
    .from(c)
    .where(and(eq(c.id, customerId), isNull(c.archivedAt)))
    .limit(1);
  if (row === undefined) {
    throw new DomainError("NOT_FOUND", "Customer not found");
  }
  return row;
}

/** Only these fields can be changed here; status and review flags have dedicated flows. */
const updateCustomerInput = z.strictObject({
  customerId: z.uuid(),
  displayName: trimmedText(200).optional(),
  companyName: trimmedText(200).optional(),
});

export async function updateCustomer(ctx: ServiceContext, input: unknown): Promise<void> {
  const data = parseInput(updateCustomerInput, input);
  const actor = requireActor(ctx.actor);
  authorize(actor, "customer:update", { customerId: data.customerId });

  const patch: { displayName?: string; companyName?: string } = {};
  if (data.displayName !== undefined) patch.displayName = data.displayName;
  if (data.companyName !== undefined) patch.companyName = data.companyName;
  if (Object.keys(patch).length === 0) {
    throw new DomainError("VALIDATION_FAILED", "Nothing to update");
  }

  await ctx.db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        displayName: schema.customer.displayName,
        companyName: schema.customer.companyName,
      })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, data.customerId), isNull(schema.customer.archivedAt)))
      .for("update")
      .limit(1);
    if (before === undefined) {
      throw new DomainError("NOT_FOUND", "Customer not found");
    }
    await tx
      .update(schema.customer)
      .set({ ...patch, updatedAt: ctx.clock.now() })
      .where(eq(schema.customer.id, data.customerId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "customer.updated",
      entityType: "customer",
      entityId: data.customerId,
      before,
      after: patch,
      correlationId: ctx.correlationId,
    });
  });
}
