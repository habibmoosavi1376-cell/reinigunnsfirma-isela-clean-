import type { Permission } from "@isela/auth";
import { DEFAULT_BILLING_CONFIG, billingConfigSchema } from "@isela/billing";
import { DEFAULT_LEAD_SCORING, leadScoringSchema } from "@isela/lead-finder";
import { DEFAULT_OPERATIONS_CONFIG, operationsConfigSchema } from "@isela/operations";
import { DEFAULT_PAYMENT_POLICY, paymentPolicySchema } from "@isela/payment-risk";
import { DEFAULT_QUOTE_CONFIG, quoteConfigSchema } from "@isela/quotes";
import type { z } from "@isela/validation";

export type SettingScopeType = "GLOBAL" | "SERVICE_AREA" | "CUSTOMER";

export interface SettingDefinition<S extends z.ZodType> {
  readonly schema: S;
  readonly scopes: readonly SettingScopeType[];
  /** Permission required to change the setting. */
  readonly permission: Permission;
  readonly defaultValue: z.output<S>;
  readonly description: string;
}

function define<S extends z.ZodType>(definition: SettingDefinition<S>): SettingDefinition<S> {
  return definition;
}

/**
 * Registry of all configurable settings. A key that is not registered here cannot be stored.
 * Every value is validated against its schema before it is written (and again when read).
 */
export const SETTING_DEFINITIONS = {
  "payment.policy": define({
    schema: paymentPolicySchema,
    scopes: ["GLOBAL"],
    permission: "payment_policy:manage",
    defaultValue: DEFAULT_PAYMENT_POLICY,
    description: "Zahlungsrichtlinie (Vorkasse/Rechnung), docs/DOMAIN_MODEL.md §11",
  }),
  "billing.config": define({
    schema: billingConfigSchema,
    scopes: ["GLOBAL"],
    permission: "payment_policy:manage",
    defaultValue: DEFAULT_BILLING_CONFIG,
    description:
      "Rechnungen: Nummernkreis-Präfix, Zahlungsziel, Vorkasse-Frist (Owner-Werte, Standard CONFIG_REQUIRED)",
  }),
  "lead.scoring": define({
    schema: leadScoringSchema,
    scopes: ["GLOBAL"],
    permission: "settings:manage",
    defaultValue: DEFAULT_LEAD_SCORING,
    description: "Gewichte des erklärbaren Lead-Scores",
  }),
  "quote.defaults": define({
    schema: quoteConfigSchema,
    scopes: ["GLOBAL"],
    permission: "settings:manage",
    defaultValue: DEFAULT_QUOTE_CONFIG,
    description: "Angebote: zulässige USt-Sätze, Gültigkeit, Positionslimit, Vier-Augen-Freigabe",
  }),
  "operations.assignment": define({
    schema: operationsConfigSchema,
    scopes: ["GLOBAL"],
    permission: "settings:manage",
    defaultValue: DEFAULT_OPERATIONS_CONFIG,
    description:
      "Disposition: Partnerzuweisung (Owner-Regel, Standard aus), Pflichtnachweise, Score-Gewichte, Zeitzone",
  }),
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export type SettingValue<K extends SettingKey> = z.output<
  (typeof SETTING_DEFINITIONS)[K]["schema"]
>;

export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as [SettingKey, ...SettingKey[]];
