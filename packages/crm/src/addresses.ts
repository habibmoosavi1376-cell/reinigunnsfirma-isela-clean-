import { recordAudit } from "@isela/audit";
import {
  auditActorOf,
  authorize,
  hasGlobalPermission,
  requireActor,
  type ServiceContext,
} from "@isela/auth";
import { isAddressInServiceArea, type ServiceAreaMembership } from "@isela/catalog";
import {
  and,
  eq,
  isNull,
  ne,
  schema,
  sql,
  type DbExecutor,
  type Transaction,
} from "@isela/database";
import { DomainError } from "@isela/shared";
import {
  countryCodeSchema,
  isValidPostalCode,
  latitudeSchema,
  longitudeSchema,
  parseInput,
  trimmedText,
  z,
} from "@isela/validation";
import { attachIdentities } from "./customers.ts";
import { hashIdentity, normalizeAddress, type CrmConfig } from "./identity.ts";

export const ADDRESS_TYPES = ["BILLING", "SERVICE", "OTHER"] as const;

const baseAddressFields = {
  customerId: z.uuid(),
  addressType: z.enum(ADDRESS_TYPES),
  /** Main address of the customer (at most one; the previous one is unset). */
  isPrimary: z.boolean().default(false),
  street: trimmedText(200),
  houseNumber: trimmedText(20),
  postalCode: trimmedText(10),
  city: trimmedText(120),
  country: countryCodeSchema.default("DE"),
};

const postalCodeRefinement = {
  check: (a: { postalCode: string; country: string }) => isValidPostalCode(a.postalCode, a.country),
  message: { message: "Invalid postal code for country", path: ["postalCode"] },
};

/** Customers cannot submit coordinates: the geocoded point decides the service area. */
const customerAddressInput = z
  .strictObject(baseAddressFields)
  .refine(postalCodeRefinement.check, postalCodeRefinement.message);

/** Staff may record manually verified coordinates (geocoding status MANUAL). */
const staffAddressInput = z
  .strictObject({
    ...baseAddressFields,
    latitude: latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
  })
  .refine(postalCodeRefinement.check, postalCodeRefinement.message)
  .refine((a) => (a.latitude === undefined) === (a.longitude === undefined), {
    message: "latitude and longitude must be provided together",
    path: ["latitude"],
  });

/** Postal-code and city reference data for an address (optional, never required). */
async function resolvePlaceRefs(
  tx: DbExecutor,
  address: { postalCode: string; country: string; city: string },
): Promise<{ postalCodeId: string | null; cityId: string | null }> {
  const [postal] = await tx
    .select({ id: schema.postalCode.id })
    .from(schema.postalCode)
    .where(
      and(
        eq(schema.postalCode.code, address.postalCode),
        eq(schema.postalCode.country, address.country),
      ),
    )
    .limit(1);
  if (postal === undefined) return { postalCodeId: null, cityId: null };
  const [cityRef] = await tx
    .select({ id: schema.city.id })
    .from(schema.city)
    .innerJoin(schema.postalCodeCity, eq(schema.postalCodeCity.cityId, schema.city.id))
    .where(
      and(
        eq(schema.postalCodeCity.postalCodeId, postal.id),
        sql`lower(${schema.city.name}) = lower(${address.city})`,
      ),
    )
    .limit(1);
  return { postalCodeId: postal.id, cityId: cityRef?.id ?? null };
}

export interface AddressFields {
  readonly street: string;
  readonly houseNumber: string;
  readonly postalCode: string;
  readonly country: string;
}

/**
 * Active address of the customer with the same type and normalised street/number/postcode.
 * Works for addresses without a stored key (created before day 4) as well.
 */
export async function findEquivalentAddress(
  tx: DbExecutor,
  customerId: string,
  addressType: (typeof ADDRESS_TYPES)[number],
  address: AddressFields,
): Promise<string | null> {
  const key = normalizeAddress(address);
  const rows = await tx
    .select({
      id: schema.customerAddress.id,
      street: schema.customerAddress.street,
      houseNumber: schema.customerAddress.houseNumber,
      postalCode: schema.customerAddress.postalCode,
      country: schema.customerAddress.country,
    })
    .from(schema.customerAddress)
    .where(
      and(
        eq(schema.customerAddress.customerId, customerId),
        eq(schema.customerAddress.addressType, addressType),
        isNull(schema.customerAddress.archivedAt),
      ),
    );
  return rows.find((row) => normalizeAddress(row) === key)?.id ?? null;
}

async function unsetPrimary(tx: Transaction, customerId: string, exceptId: string | null) {
  await tx
    .update(schema.customerAddress)
    .set({ isPrimary: false })
    .where(
      and(
        eq(schema.customerAddress.customerId, customerId),
        eq(schema.customerAddress.isPrimary, true),
        exceptId === null ? sql`true` : ne(schema.customerAddress.id, exceptId),
      ),
    );
}

export async function addCustomerAddress(
  ctx: ServiceContext,
  input: unknown,
  config: CrmConfig,
): Promise<{
  addressId: string;
  duplicateReviewRequired: boolean;
  /** An equivalent active address already existed (the UI warns; creation is explicit). */
  duplicateOfAddressId: string | null;
}> {
  const actor = requireActor(ctx.actor);
  const isStaff = hasGlobalPermission(actor, "customer_address:write");
  const data = isStaff
    ? parseInput(staffAddressInput, input)
    : { ...parseInput(customerAddressInput, input), latitude: undefined, longitude: undefined };
  authorize(actor, "customer_address:write", { customerId: data.customerId });
  const now = ctx.clock.now();
  const hasCoordinates = data.latitude !== undefined && data.longitude !== undefined;

  return ctx.db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: schema.customer.id })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, data.customerId), isNull(schema.customer.archivedAt)))
      .limit(1);
    if (owner === undefined) {
      throw new DomainError("NOT_FOUND", "Customer not found");
    }

    const refs = await resolvePlaceRefs(tx, data);
    const duplicateOfAddressId = await findEquivalentAddress(
      tx,
      data.customerId,
      data.addressType,
      data,
    );
    if (data.isPrimary) await unsetPrimary(tx, data.customerId, null);

    const [row] = await tx
      .insert(schema.customerAddress)
      .values({
        customerId: data.customerId,
        addressType: data.addressType,
        street: data.street,
        houseNumber: data.houseNumber,
        postalCode: data.postalCode,
        city: data.city,
        country: data.country,
        postalCodeId: refs.postalCodeId,
        cityId: refs.cityId,
        isPrimary: data.isPrimary,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        geocodingStatus: hasCoordinates ? "MANUAL" : "PENDING",
        geocodedAt: hasCoordinates ? now : null,
        source: isStaff ? "STAFF_INPUT" : "CUSTOMER_INPUT",
      })
      .returning({ id: schema.customerAddress.id });
    if (row === undefined) {
      throw new DomainError("CONFLICT", "Address could not be created");
    }

    let duplicateReviewRequired = false;
    if (data.addressType === "BILLING") {
      duplicateReviewRequired = await attachIdentities(tx, data.customerId, [
        { kind: "ADDRESS", valueHash: hashIdentity(config, "ADDRESS", normalizeAddress(data)) },
      ]);
    }

    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "customer_address.created",
      entityType: "customer_address",
      entityId: row.id,
      after: {
        customerId: data.customerId,
        addressType: data.addressType,
        source: isStaff ? "STAFF_INPUT" : "CUSTOMER_INPUT",
        geocodingStatus: hasCoordinates ? "MANUAL" : "PENDING",
        isPrimary: data.isPrimary,
        duplicateOfAddressId,
      },
      correlationId: ctx.correlationId,
    });
    return { addressId: row.id, duplicateReviewRequired, duplicateOfAddressId };
  });
}

const addressIdInput = z.strictObject({ addressId: z.uuid() });

/** Service-area membership of a customer's address (object-level authorization). */
export async function checkAddressServiceArea(
  ctx: ServiceContext,
  input: unknown,
): Promise<ServiceAreaMembership> {
  const { addressId } = parseInput(addressIdInput, input);
  requireActor(ctx.actor);
  const [address] = await ctx.db
    .select({ customerId: schema.customerAddress.customerId })
    .from(schema.customerAddress)
    .where(and(eq(schema.customerAddress.id, addressId), isNull(schema.customerAddress.archivedAt)))
    .limit(1);
  if (address === undefined) {
    throw new DomainError("NOT_FOUND", "Address not found");
  }
  authorize(ctx.actor, "customer:read", { customerId: address.customerId });
  return isAddressInServiceArea(ctx.db, addressId);
}

const primaryInput = z.strictObject({ addressId: z.uuid() });

/** Makes an address the customer's main address (ownership derived from the address). */
export async function setPrimaryAddress(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  const { addressId } = parseInput(primaryInput, input);
  await ctx.db.transaction(async (tx) => {
    const [address] = await tx
      .select({ customerId: schema.customerAddress.customerId })
      .from(schema.customerAddress)
      .where(
        and(eq(schema.customerAddress.id, addressId), isNull(schema.customerAddress.archivedAt)),
      )
      .for("update")
      .limit(1);
    if (address === undefined) {
      throw new DomainError("NOT_FOUND", "Address not found");
    }
    authorize(actor, "customer_address:write", { customerId: address.customerId });
    await unsetPrimary(tx, address.customerId, addressId);
    await tx
      .update(schema.customerAddress)
      .set({ isPrimary: true, updatedAt: ctx.clock.now() })
      .where(eq(schema.customerAddress.id, addressId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "customer_address.primary_changed",
      entityType: "customer_address",
      entityId: addressId,
      after: { customerId: address.customerId, isPrimary: true },
      correlationId: ctx.correlationId,
    });
  });
}

const updateAddressInput = z.strictObject({
  addressId: z.uuid(),
  addressType: z.enum(ADDRESS_TYPES).optional(),
  street: trimmedText(200).optional(),
  houseNumber: trimmedText(20).optional(),
  postalCode: trimmedText(10).optional(),
  city: trimmedText(120).optional(),
});

/**
 * Updates an address. Changing the location resets its coordinates to PENDING – coordinates
 * are never taken from the browser and never kept for a different address.
 */
export async function updateCustomerAddress(ctx: ServiceContext, input: unknown): Promise<void> {
  const actor = requireActor(ctx.actor);
  const data = parseInput(updateAddressInput, input);
  await ctx.db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(schema.customerAddress)
      .where(
        and(
          eq(schema.customerAddress.id, data.addressId),
          isNull(schema.customerAddress.archivedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (before === undefined) {
      throw new DomainError("NOT_FOUND", "Address not found");
    }
    authorize(actor, "customer_address:write", { customerId: before.customerId });
    // The postal code format depends on the stored country (the country is not editable here).
    if (data.postalCode !== undefined && !isValidPostalCode(data.postalCode, before.country)) {
      throw new DomainError("VALIDATION_FAILED", "Invalid postal code for country");
    }
    const locationFields = ["street", "houseNumber", "postalCode", "city"] as const;
    const changed = ([...locationFields, "addressType"] as const).filter(
      (field) => data[field] !== undefined && data[field] !== before[field],
    );
    if (changed.length === 0) {
      throw new DomainError("VALIDATION_FAILED", "Nothing to update");
    }
    const locationChanged = changed.some((field) => field !== "addressType");
    const next = {
      street: data.street ?? before.street,
      houseNumber: data.houseNumber ?? before.houseNumber,
      postalCode: data.postalCode ?? before.postalCode,
      city: data.city ?? before.city,
    };
    const refs = locationChanged
      ? await resolvePlaceRefs(tx, { ...next, country: before.country })
      : { postalCodeId: before.postalCodeId, cityId: before.cityId };
    await tx
      .update(schema.customerAddress)
      .set({
        ...next,
        addressType: data.addressType ?? before.addressType,
        postalCodeId: refs.postalCodeId,
        cityId: refs.cityId,
        normalizedKey:
          before.normalizedKey === null
            ? null
            : normalizeAddress({ ...next, country: before.country }),
        ...(locationChanged
          ? {
              latitude: null,
              longitude: null,
              geocodingStatus: "PENDING" as const,
              geocodedAt: null,
            }
          : {}),
        updatedAt: ctx.clock.now(),
      })
      .where(eq(schema.customerAddress.id, data.addressId));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "customer_address.updated",
      entityType: "customer_address",
      entityId: data.addressId,
      // Field names only – no address values in the audit log.
      after: { changedFields: changed, geocodingReset: locationChanged },
      correlationId: ctx.correlationId,
    });
  });
}

/**
 * Lead flow (called inside the linking transaction, caller authorised): reuses an equivalent
 * active SERVICE address of the customer or creates one from the request. Coordinates are
 * only copied when the request was geocoded by the server (SUCCEEDED) or confirmed by staff
 * (MANUAL). Race-safe through the unique (customer, type, normalized_key) index.
 */
export async function ensureAddressFromRequest(
  tx: Transaction,
  customerId: string,
  request: {
    readonly id: string;
    readonly street: string;
    readonly houseNumber: string;
    readonly postalCode: string;
    readonly city: string;
    readonly country: string;
    readonly latitude: number | null;
    readonly longitude: number | null;
    readonly geocodingStatus: string;
    readonly serviceAreaCheckedAt: Date | null;
  },
  now: Date,
): Promise<{ addressId: string; created: boolean }> {
  const existing = await findEquivalentAddress(tx, customerId, "SERVICE", request);
  if (existing !== null) return { addressId: existing, created: false };

  const trusted =
    (request.geocodingStatus === "SUCCEEDED" || request.geocodingStatus === "MANUAL") &&
    request.latitude !== null &&
    request.longitude !== null;
  const [hasPrimary] = await tx
    .select({ id: schema.customerAddress.id })
    .from(schema.customerAddress)
    .where(
      and(
        eq(schema.customerAddress.customerId, customerId),
        eq(schema.customerAddress.isPrimary, true),
        isNull(schema.customerAddress.archivedAt),
      ),
    )
    .limit(1);
  const refs = await resolvePlaceRefs(tx, request);
  const [row] = await tx
    .insert(schema.customerAddress)
    .values({
      customerId,
      addressType: "SERVICE",
      street: request.street,
      houseNumber: request.houseNumber,
      postalCode: request.postalCode,
      city: request.city,
      country: request.country,
      postalCodeId: refs.postalCodeId,
      cityId: refs.cityId,
      latitude: trusted ? request.latitude : null,
      longitude: trusted ? request.longitude : null,
      geocodingStatus: trusted ? request.geocodingStatus : "PENDING",
      geocodedAt: trusted ? (request.serviceAreaCheckedAt ?? now) : null,
      source: "CUSTOMER_INPUT",
      isPrimary: hasPrimary === undefined,
      normalizedKey: normalizeAddress(request),
    })
    .onConflictDoNothing()
    .returning({ id: schema.customerAddress.id });
  if (row !== undefined) return { addressId: row.id, created: true };
  // A concurrent transaction created the same address: reuse it.
  const raced = await findEquivalentAddress(tx, customerId, "SERVICE", request);
  if (raced === null) {
    throw new DomainError("CONFLICT", "Address could not be created");
  }
  return { addressId: raced, created: false };
}
