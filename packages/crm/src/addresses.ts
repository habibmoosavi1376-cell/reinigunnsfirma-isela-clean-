import { recordAudit } from "@isela/audit";
import {
  auditActorOf,
  authorize,
  hasGlobalPermission,
  requireActor,
  type ServiceContext,
} from "@isela/auth";
import { isAddressInServiceArea, type ServiceAreaMembership } from "@isela/catalog";
import { and, eq, isNull, schema, sql } from "@isela/database";
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

const baseAddressFields = {
  customerId: z.uuid(),
  addressType: z.enum(["BILLING", "SERVICE", "OTHER"]),
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

export async function addCustomerAddress(
  ctx: ServiceContext,
  input: unknown,
  config: CrmConfig,
): Promise<{ addressId: string; duplicateReviewRequired: boolean }> {
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

    const [postal] = await tx
      .select({ id: schema.postalCode.id })
      .from(schema.postalCode)
      .where(
        and(
          eq(schema.postalCode.code, data.postalCode),
          eq(schema.postalCode.country, data.country),
        ),
      )
      .limit(1);
    const [cityRef] =
      postal === undefined
        ? []
        : await tx
            .select({ id: schema.city.id })
            .from(schema.city)
            .innerJoin(schema.postalCodeCity, eq(schema.postalCodeCity.cityId, schema.city.id))
            .where(
              and(
                eq(schema.postalCodeCity.postalCodeId, postal.id),
                sql`lower(${schema.city.name}) = lower(${data.city})`,
              ),
            )
            .limit(1);

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
        postalCodeId: postal?.id ?? null,
        cityId: cityRef?.id ?? null,
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
      },
      correlationId: ctx.correlationId,
    });
    return { addressId: row.id, duplicateReviewRequired };
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
