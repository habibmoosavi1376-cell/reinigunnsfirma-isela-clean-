import { z } from "@isela/validation";
import { MAX_CENTS } from "./money.ts";

/*
 * Price rule document (stored versioned in price_rule_set.rules). Every business value can be
 * the literal "CONFIG_REQUIRED": it marks a value the owner has not decided yet. The engine
 * never substitutes a default for it – a calculation that needs such a value returns status
 * CONFIG_REQUIRED instead of a price. There are no prices in code or UI files.
 */

export const CONFIG_REQUIRED = "CONFIG_REQUIRED" as const;
export type ConfigRequired = typeof CONFIG_REQUIRED;

function configurable<S extends z.ZodType>(schema: S) {
  return z.union([schema, z.literal(CONFIG_REQUIRED)]);
}

const cents = z.number().int().min(0).max(MAX_CENTS);
/** Relative adjustment in basis points (−50 % … +100 %). */
const adjustmentBp = z.number().int().min(-5000).max(10_000);
const surchargeBp = z.number().int().min(0).max(10_000);
const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(64);

export const FREQUENCIES = ["ONCE", "WEEKLY", "BIWEEKLY", "MONTHLY", "CUSTOM"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const URGENCIES = ["STANDARD", "EXPRESS"] as const;
export type Urgency = (typeof URGENCIES)[number];

const serviceRuleSchema = z.strictObject({
  /** Grundpreis (net cents). */
  basePriceCents: configurable(cents),
  /** Per unit of the service's catalogue unit (hour, m², unit). */
  perUnitCents: configurable(cents).optional(),
  perSqmCents: configurable(cents).optional(),
  perRoomCents: configurable(cents).optional(),
  perBathroomCents: configurable(cents).optional(),
  perWindowCents: configurable(cents).optional(),
  /** Minimum net price – only when the owner defined one (never invented). */
  minimumNetCents: configurable(cents).optional(),
});

const extraRuleSchema = z.strictObject({
  priceCents: configurable(cents),
  /** Additional working time for the labour estimate. */
  laborMinutes: z.number().int().min(0).max(1440),
});

function limitedRecord<S extends z.ZodType>(value: S, max: number) {
  return z
    .record(z.uuid(), value)
    .refine((r) => Object.keys(r).length <= max, { message: `At most ${String(max)} entries` });
}

export const priceRulesSchema = z.strictObject({
  costs: z.strictObject({
    /** Internal employee cost per hour (for the contribution margin only). */
    laborCostCentsPerHour: configurable(z.number().int().min(0).max(100_000)),
  }),
  /** Rules per catalogue service id. A service without an entry cannot be priced. */
  services: limitedRecord(serviceRuleSchema, 500),
  /** Rules per service option (extra) id. */
  extras: limitedRecord(extraRuleSchema, 2000),
  frequencyAdjustmentBasisPoints: z.strictObject({
    ONCE: configurable(adjustmentBp),
    WEEKLY: configurable(adjustmentBp),
    BIWEEKLY: configurable(adjustmentBp),
    MONTHLY: configurable(adjustmentBp),
    CUSTOM: configurable(adjustmentBp),
  }),
  urgencySurchargeBasisPoints: z.strictObject({
    STANDARD: configurable(surchargeBp),
    EXPRESS: configurable(surchargeBp),
  }),
  /** Travel: kilometres included, then a price per km. NULL = no distance component. */
  distance: z
    .strictObject({
      includedKm: configurable(z.number().int().min(0).max(1000)),
      perKmCents: configurable(cents),
    })
    .nullable(),
  /** Weekday/time surcharges (business-local time, ISO weekday 1 = Monday). */
  timeSurcharges: z
    .array(
      z
        .strictObject({
          key: slug,
          weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
          fromMinute: z.number().int().min(0).max(1439),
          toMinute: z.number().int().min(1).max(1440),
          basisPoints: z.number().int().min(1).max(10_000),
        })
        .refine((s) => s.toMinute > s.fromMinute, { message: "Empty time range" }),
    )
    .max(20),
  /** Discounts that authorised staff may select explicitly (never applied automatically). */
  discounts: z
    .array(
      z.strictObject({
        key: slug,
        label: z.string().trim().min(1).max(100),
        basisPoints: z.number().int().min(1).max(5000),
      }),
    )
    .max(20)
    .refine((d) => new Set(d.map((x) => x.key)).size === d.length, {
      message: "Discount keys must be unique",
    }),
});

export type PriceRules = z.infer<typeof priceRulesSchema>;
export type ServiceRule = z.infer<typeof serviceRuleSchema>;

/**
 * Starting point for a new rule set: every business value is CONFIG_REQUIRED. Nothing in
 * here is a price – the owner fills in the values before the rule set is activated.
 */
export function emptyPriceRules(): PriceRules {
  return {
    costs: { laborCostCentsPerHour: CONFIG_REQUIRED },
    services: {},
    extras: {},
    frequencyAdjustmentBasisPoints: {
      ONCE: CONFIG_REQUIRED,
      WEEKLY: CONFIG_REQUIRED,
      BIWEEKLY: CONFIG_REQUIRED,
      MONTHLY: CONFIG_REQUIRED,
      CUSTOM: CONFIG_REQUIRED,
    },
    urgencySurchargeBasisPoints: { STANDARD: CONFIG_REQUIRED, EXPRESS: CONFIG_REQUIRED },
    distance: null,
    timeSurcharges: [],
    discounts: [],
  };
}

/** Paths of all values still marked CONFIG_REQUIRED (for review before activation). */
export function listConfigRequired(rules: PriceRules): string[] {
  const missing: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (value === CONFIG_REQUIRED) {
      missing.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}[${String(i)}]`);
      });
    } else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) walk(v, path === "" ? k : `${path}.${k}`);
    }
  };
  walk(rules, "");
  return missing;
}
