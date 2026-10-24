import { z } from "@isela/validation";

/*
 * Operations configuration (setting key `operations.assignment`). Business rules for
 * assignment are data. Partner assignment stays DISABLED until the owner enables it: the
 * partner model (commission, contract, legal review – PRODUCT_SPEC §10) is not decided yet,
 * so the system must not hand jobs to partners on its own. The scoring weights only rank
 * candidates that already passed every hard rule; they are defaults to be confirmed.
 */

export const PARTNER_DOCUMENT_KINDS = [
  "TRADE_REGISTRATION",
  "LIABILITY_INSURANCE",
  "OTHER",
] as const;
export type PartnerDocumentKind = (typeof PARTNER_DOCUMENT_KINDS)[number];

const weight = z.number().int().min(0).max(100);

export const operationsConfigSchema = z
  .strictObject({
    /** IANA time zone of working windows and business dates. */
    timeZone: z.string().refine(isTimeZone, { message: "Unknown time zone" }),
    /** Owner rule: partners may be proposed and assigned only when enabled. */
    partnerAssignmentEnabled: z.boolean(),
    /** Verified, unexpired documents a partner needs before activation and assignment. */
    requiredPartnerDocumentKinds: z
      .array(z.enum(PARTNER_DOCUMENT_KINDS))
      .min(1)
      .max(3)
      .refine((k) => new Set(k).size === k.length, { message: "Kinds must be unique" }),
    scoringWeights: z.strictObject({
      distance: weight,
      qualification: weight,
      availability: weight,
      serviceMatch: weight,
      capacity: weight,
      reliability: weight,
    }),
    /** Distance at which the distance factor reaches 0 (metres). */
    distanceReferenceM: z.number().int().min(1000).max(300_000),
    /** Longest allowed booking time window (hours). */
    maxBookingWindowHours: z.number().int().min(1).max(24),
  })
  .refine((c) => Object.values(c.scoringWeights).reduce((a, b) => a + b, 0) === 100, {
    message: "Scoring weights must add up to 100",
    path: ["scoringWeights"],
  });

export type OperationsConfig = z.infer<typeof operationsConfigSchema>;

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Defaults – to be confirmed by the owner (see docs/PHASE_1_DAY_5_REPORT.md). */
export const DEFAULT_OPERATIONS_CONFIG: OperationsConfig = {
  timeZone: "Europe/Berlin",
  partnerAssignmentEnabled: false,
  requiredPartnerDocumentKinds: ["TRADE_REGISTRATION", "LIABILITY_INSURANCE"],
  scoringWeights: {
    distance: 30,
    qualification: 20,
    availability: 20,
    serviceMatch: 10,
    capacity: 10,
    reliability: 10,
  },
  distanceReferenceM: 30_000,
  maxBookingWindowHours: 12,
};

/*
 * Recurring jobs and reminders (setting key `operations.recurring`, day 8). The holiday
 * region has NO default: until the owner sets it (and approves the holiday data of each
 * year), no appointments are generated automatically. Horizon and lead time are operational
 * defaults to be confirmed by the owner.
 */
export const recurringConfigSchema = z.strictObject({
  /** ISO 3166-2 region of the holiday calendar, e.g. "DE-NW"; null = not configured. */
  holidayRegion: z
    .string()
    .regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/)
    .nullable(),
  /** Days ahead for which appointments are generated in one run (max. 120). */
  generationHorizonDays: z.number().int().min(1).max(120),
  /** Hours before an appointment at which the reminder is due (1–168). */
  reminderLeadHours: z.number().int().min(1).max(168),
});

export type RecurringConfig = z.infer<typeof recurringConfigSchema>;

export const DEFAULT_RECURRING_CONFIG: RecurringConfig = {
  holidayRegion: null,
  generationHorizonDays: 28,
  reminderLeadHours: 24,
};
