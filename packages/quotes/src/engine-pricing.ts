import { recordAudit } from "@isela/audit";
import { auditActorOf, hasGlobalPermission, requireActor, type ServiceContext } from "@isela/auth";
import { findServiceAreasForPoint, geographyPointSql } from "@isela/catalog";
import { and, count, eq, inArray, isNull, max, schema, sql } from "@isela/database";
import {
  FREQUENCIES,
  PRICING_ENGINE_VERSION,
  URGENCIES,
  calculatePrice,
  getActivePriceRuleSet,
  type EngineInput,
  type PriceResult,
} from "@isela/pricing";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import { quoteConfigSchema, type QuoteConfig } from "./config.ts";
import { calculateLine, calculateTotals, quantitySchema } from "./pricing.ts";

/*
 * Engine pricing for quote items (day 5). The server builds the engine input from the stored
 * quote, property, address and catalogue service; staff only choose whitelisted parameters.
 * Internal cost inputs (labour estimate, direct costs, partner cost) are accepted only from
 * roles with finance:internal_read. Every run is stored append-only (pricing_calculation);
 * a quote item references the calculation and copies its pricing_version, so later rule
 * changes never alter existing quotes. Overriding a calculated price needs pricing:override,
 * a reason and is audited.
 */

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function localWeekdayMinute(at: Date, timeZone: string): { weekday: number; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAY_INDEX[get("weekday")];
  if (weekday === undefined) throw new DomainError("VALIDATION_FAILED", "Invalid date");
  return { weekday, minuteOfDay: Number(get("hour")) * 60 + Number(get("minute")) };
}

const calculateInput = z.strictObject({
  quoteId: z.uuid(),
  serviceId: z.uuid(),
  quantity: quantitySchema.optional(),
  windows: z.number().int().min(0).max(100_000).optional(),
  frequency: z.enum(FREQUENCIES),
  urgency: z.enum(URGENCIES),
  extraIds: z.array(z.uuid()).max(20).default([]),
  discountKeys: z.array(z.string().trim().min(1).max(64)).max(5).default([]),
  plannedStart: z.iso.datetime({ offset: true }).optional(),
  /** Internal cost inputs – finance roles only. */
  estimatedLaborMinutes: z.number().int().min(0).max(100_000).optional(),
  directCostsCents: z.number().int().min(0).max(100_000_000).optional(),
  partnerCostCents: z.number().int().min(0).max(100_000_000).optional(),
});

export interface QuotePriceCalculation {
  readonly calculationId: string;
  readonly result: PriceResult;
  /** Internal costs/margin are only returned to finance roles. */
  readonly internalVisible: boolean;
}

function redactInternal(result: PriceResult, internalVisible: boolean): PriceResult {
  if (internalVisible || result.status !== "CALCULATED") return result;
  return {
    ...result,
    estimatedLaborMinutes: null,
    directCosts: 0,
    internalCost: null,
    contributionMargin: null,
  };
}

export async function calculateQuoteItemPrice(
  ctx: ServiceContext,
  input: unknown,
  quoteConfig: QuoteConfig,
): Promise<QuotePriceCalculation> {
  const actor = requireActor(ctx.actor);
  if (!hasGlobalPermission(actor, "quote:write")) {
    throw new DomainError("FORBIDDEN", "Not allowed", { permission: "quote:write" });
  }
  const data = parseInput(calculateInput, input);
  const config = quoteConfigSchema.parse(quoteConfig);
  const internalVisible = hasGlobalPermission(actor, "finance:internal_read");
  const usesInternalInputs =
    data.estimatedLaborMinutes !== undefined ||
    data.directCostsCents !== undefined ||
    data.partnerCostCents !== undefined;
  if (usesInternalInputs && !internalVisible) {
    throw new DomainError("FORBIDDEN", "Not allowed", { permission: "finance:internal_read" });
  }

  return ctx.db.transaction(async (tx) => {
    const [quote] = await tx
      .select({
        id: schema.quote.id,
        status: schema.quote.status,
        customerId: schema.quote.customerId,
        propertyId: schema.quote.propertyId,
      })
      .from(schema.quote)
      .where(eq(schema.quote.id, data.quoteId))
      .limit(1);
    if (quote === undefined) throw new DomainError("NOT_FOUND", "Quote not found");
    if (quote.status !== "DRAFT") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Only draft quotes can be priced");
    }
    if (quote.propertyId === null) {
      throw new DomainError("VALIDATION_FAILED", "The quote needs a property for engine pricing");
    }
    // Property and address always come from the quote's own customer (never from input).
    const [property] = await tx
      .select({
        propertyType: schema.property.propertyType,
        areaSqm: schema.property.areaSqm,
        rooms: schema.property.rooms,
        bathrooms: schema.property.bathrooms,
        latitude: schema.customerAddress.latitude,
        longitude: schema.customerAddress.longitude,
      })
      .from(schema.property)
      .innerJoin(schema.customerAddress, eq(schema.customerAddress.id, schema.property.addressId))
      .where(
        and(
          eq(schema.property.id, quote.propertyId),
          eq(schema.property.customerId, quote.customerId),
          isNull(schema.property.archivedAt),
        ),
      )
      .limit(1);
    if (property === undefined) throw new DomainError("NOT_FOUND", "Property not found");
    const [service] = await tx
      .select()
      .from(schema.service)
      .where(and(eq(schema.service.id, data.serviceId), eq(schema.service.active, true)))
      .limit(1);
    if (service === undefined) throw new DomainError("NOT_FOUND", "Service not found");
    if (service.pricingStrategy !== "RULE_BASED") {
      throw new DomainError("POLICY_VIOLATION", "This service is priced manually");
    }
    if (
      service.supportedPropertyTypes.length > 0 &&
      !service.supportedPropertyTypes.includes(property.propertyType)
    ) {
      throw new DomainError("VALIDATION_FAILED", "Service not offered for this property type");
    }
    const quantity =
      data.quantity ??
      (service.unit === "FLAT"
        ? 1
        : service.unit === "SQUARE_METER"
          ? (property.areaSqm ?? undefined)
          : undefined);
    if (quantity === undefined) {
      throw new DomainError("VALIDATION_FAILED", "A quantity is required for this service");
    }
    if (service.minQuantity !== null && quantity < service.minQuantity) {
      throw new DomainError("VALIDATION_FAILED", "Quantity below the service minimum");
    }
    const extraIds = [...new Set(data.extraIds)];
    if (extraIds.length > 0) {
      const extras = await tx
        .select({ id: schema.serviceOption.id })
        .from(schema.serviceOption)
        .where(
          and(
            inArray(schema.serviceOption.id, extraIds),
            eq(schema.serviceOption.serviceId, service.id),
            eq(schema.serviceOption.active, true),
          ),
        );
      if (extras.length !== extraIds.length) {
        throw new DomainError("NOT_FOUND", "Extra not found for this service");
      }
    }

    // Region and distance are derived on the server from the trusted coordinates.
    let serviceAreaId: string | null = null;
    let distanceM: number | null = null;
    if (property.latitude !== null && property.longitude !== null) {
      const areas = await findServiceAreasForPoint(tx, {
        latitude: property.latitude,
        longitude: property.longitude,
      });
      serviceAreaId = areas[0]?.id ?? null;
      if (serviceAreaId !== null) {
        const point = geographyPointSql({
          latitude: property.latitude,
          longitude: property.longitude,
        });
        const [distance] = await tx
          .select({
            meters: sql<
              number | null
            >`CASE WHEN ${schema.serviceArea.kind} = 'CIRCLE' THEN ST_Distance(${schema.serviceArea.center}, ${point})::double precision END`,
          })
          .from(schema.serviceArea)
          .where(eq(schema.serviceArea.id, serviceAreaId))
          .limit(1);
        distanceM = distance?.meters == null ? null : Math.round(distance.meters);
      }
    }
    const engineInput: EngineInput = {
      serviceId: service.id,
      serviceUnit: service.unit,
      quantity,
      areaSqm: property.areaSqm,
      rooms: property.rooms,
      bathrooms: property.bathrooms,
      windows: data.windows ?? null,
      frequency: data.frequency,
      urgency: data.urgency,
      extraIds,
      discountKeys: [...new Set(data.discountKeys)],
      distanceM,
      plannedStart:
        data.plannedStart === undefined
          ? null
          : localWeekdayMinute(new Date(data.plannedStart), config.timeZone),
      duration: {
        model: service.durationModel,
        baseMinutes: service.baseDurationMinutes,
        perUnitSeconds: service.durationPerUnitSeconds,
      },
      estimatedLaborMinutes: data.estimatedLaborMinutes ?? null,
      directCostsCents: data.directCostsCents ?? 0,
      partnerCostCents: data.partnerCostCents ?? null,
    };

    const ruleSet = await getActivePriceRuleSet(tx, serviceAreaId);
    const result: PriceResult =
      ruleSet === null
        ? {
            status: "CONFIG_REQUIRED",
            pricingVersion: `${PRICING_ENGINE_VERSION}+none`,
            missing: ["priceRuleSet"],
          }
        : calculatePrice(ruleSet.rules, engineInput, {
            ruleSetVersion: ruleSet.version,
            currency: ruleSet.currency,
            taxRateBasisPoints: config.defaultVatRateBasisPoints,
          });
    const calculated = result.status === "CALCULATED" ? result : null;
    const [row] = await tx
      .insert(schema.pricingCalculation)
      .values({
        status: result.status,
        engineVersion: PRICING_ENGINE_VERSION,
        pricingVersion: ruleSet === null ? null : result.pricingVersion,
        ruleSetId: ruleSet?.id ?? null,
        serviceId: service.id,
        quoteId: quote.id,
        currency: ruleSet?.currency ?? "EUR",
        netCents: calculated?.net ?? null,
        taxRateBasisPoints: calculated?.taxRateBasisPoints ?? null,
        taxCents: calculated?.tax ?? null,
        grossCents: calculated?.gross ?? null,
        estimatedLaborMinutes: calculated?.estimatedLaborMinutes ?? null,
        directCostsCents: calculated?.directCosts ?? null,
        internalCostCents: calculated?.internalCost ?? null,
        contributionMarginCents: calculated?.contributionMargin ?? null,
        input: { ...engineInput, plannedStart: engineInput.plannedStart },
        result:
          calculated === null
            ? { missing: result.status === "CONFIG_REQUIRED" ? [...result.missing] : [] }
            : {
                components: calculated.components.map((c) => ({ ...c })),
                adjustmentsBasisPoints: { ...calculated.adjustmentsBasisPoints },
                notes: [...calculated.notes],
              },
        createdByUserId: actor.userId,
      })
      .returning({ id: schema.pricingCalculation.id });
    if (row === undefined) throw new DomainError("CONFLICT", "Calculation could not be stored");
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "pricing.calculated",
      entityType: "quote",
      entityId: quote.id,
      after: {
        calculationId: row.id,
        status: result.status,
        pricingVersion: result.pricingVersion,
        netCents: calculated?.net ?? null,
      },
      correlationId: ctx.correlationId,
    });
    return {
      calculationId: row.id,
      result: redactInternal(result, internalVisible),
      internalVisible,
    };
  });
}

const addFromCalculationInput = z.strictObject({
  quoteId: z.uuid(),
  calculationId: z.uuid(),
  description: z.string().trim().min(1).max(500).optional(),
  /** Manual net price replacing the engine result (pricing:override + reason). */
  overrideNetCents: z.number().int().min(1).max(100_000_000).optional(),
  overrideReason: z.string().trim().min(3).max(1000).optional(),
});

export async function addQuoteItemFromCalculation(
  ctx: ServiceContext,
  input: unknown,
  quoteConfig: QuoteConfig,
): Promise<string> {
  const actor = requireActor(ctx.actor);
  if (!hasGlobalPermission(actor, "quote:write")) {
    throw new DomainError("FORBIDDEN", "Not allowed", { permission: "quote:write" });
  }
  const data = parseInput(addFromCalculationInput, input);
  const config = quoteConfigSchema.parse(quoteConfig);
  const override = data.overrideNetCents !== undefined;
  if (override && !hasGlobalPermission(actor, "pricing:override")) {
    throw new DomainError("FORBIDDEN", "Not allowed", { permission: "pricing:override" });
  }
  if (override && data.overrideReason === undefined) {
    throw new DomainError("VALIDATION_FAILED", "A reason is required for a price override");
  }

  return ctx.db.transaction(async (tx) => {
    const [quote] = await tx
      .select()
      .from(schema.quote)
      .where(eq(schema.quote.id, data.quoteId))
      .for("update")
      .limit(1);
    if (quote === undefined) throw new DomainError("NOT_FOUND", "Quote not found");
    if (quote.status !== "DRAFT") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Only draft quotes can be edited");
    }
    // The calculation must belong to this quote (no foreign or forged calculations).
    const [calc] = await tx
      .select()
      .from(schema.pricingCalculation)
      .where(
        and(
          eq(schema.pricingCalculation.id, data.calculationId),
          eq(schema.pricingCalculation.quoteId, quote.id),
        ),
      )
      .limit(1);
    if (calc === undefined) throw new DomainError("NOT_FOUND", "Calculation not found");
    if (
      calc.status !== "CALCULATED" ||
      calc.netCents === null ||
      calc.netCents <= 0 ||
      calc.taxRateBasisPoints === null ||
      calc.pricingVersion === null
    ) {
      throw new DomainError("CONFIG_REQUIRED", "The calculation has no usable price");
    }
    if (!config.vatRatesBasisPoints.includes(calc.taxRateBasisPoints)) {
      throw new DomainError("VALIDATION_FAILED", "Tax rate is not allowed");
    }
    const [used] = await tx
      .select({ id: schema.quoteItem.id })
      .from(schema.quoteItem)
      .where(eq(schema.quoteItem.pricingCalculationId, calc.id))
      .limit(1);
    if (used !== undefined) throw new DomainError("CONFLICT", "Calculation already used");
    const [service] = await tx
      .select({ categoryId: schema.service.categoryId, name: schema.service.name })
      .from(schema.service)
      .where(eq(schema.service.id, calc.serviceId))
      .limit(1);
    if (service === undefined) throw new DomainError("NOT_FOUND", "Service not found");
    const [stats] = await tx
      .select({ items: count(), lastPosition: max(schema.quoteItem.position) })
      .from(schema.quoteItem)
      .where(eq(schema.quoteItem.quoteId, quote.id));
    if ((stats?.items ?? 0) >= config.maxItemsPerQuote) {
      throw new DomainError("POLICY_VIOLATION", "Maximum number of quote items reached");
    }
    const unitPriceCents = data.overrideNetCents ?? calc.netCents;
    const amounts = calculateLine({
      quantity: 1,
      unitPriceCents,
      taxRateBasisPoints: calc.taxRateBasisPoints,
    });
    const [item] = await tx
      .insert(schema.quoteItem)
      .values({
        quoteId: quote.id,
        position: (stats?.lastPosition ?? 0) + 1,
        serviceCategoryId: service.categoryId,
        serviceId: calc.serviceId,
        description: data.description ?? service.name,
        quantity: 1,
        unit: "FLAT",
        unitPriceCents,
        taxRateBasisPoints: calc.taxRateBasisPoints,
        ...amounts,
        pricingSource: override ? "ENGINE_OVERRIDDEN" : "ENGINE",
        pricingCalculationId: calc.id,
        pricingVersion: calc.pricingVersion,
      })
      .returning({ id: schema.quoteItem.id });
    if (item === undefined) throw new DomainError("CONFLICT", "Quote item could not be created");
    const items = await tx
      .select({
        netCents: schema.quoteItem.netCents,
        taxRateBasisPoints: schema.quoteItem.taxRateBasisPoints,
      })
      .from(schema.quoteItem)
      .where(eq(schema.quoteItem.quoteId, quote.id));
    const totals = calculateTotals(items);
    await tx
      .update(schema.quote)
      .set({
        netCents: totals.netCents,
        taxCents: totals.taxCents,
        grossCents: totals.grossCents,
        updatedAt: ctx.clock.now(),
      })
      .where(eq(schema.quote.id, quote.id));
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "quote.item_added",
      entityType: "quote",
      entityId: quote.id,
      after: {
        itemId: item.id,
        netCents: amounts.netCents,
        taxRateBasisPoints: calc.taxRateBasisPoints,
        pricingSource: override ? "ENGINE_OVERRIDDEN" : "ENGINE",
        pricingVersion: calc.pricingVersion,
      },
      correlationId: ctx.correlationId,
    });
    if (override) {
      await recordAudit(tx, {
        actor: auditActorOf(actor),
        action: "pricing.override",
        entityType: "quote",
        entityId: quote.id,
        before: { calculationId: calc.id, netCents: calc.netCents },
        after: { itemId: item.id, netCents: unitPriceCents, reason: data.overrideReason ?? null },
        correlationId: ctx.correlationId,
      });
    }
    return item.id;
  });
}
