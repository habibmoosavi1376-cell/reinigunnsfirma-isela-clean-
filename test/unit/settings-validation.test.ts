import { describe, expect, it } from "vitest";
import { DEFAULT_LOCKOUT_POLICY, lockoutPolicySchema } from "@isela/auth";
import { DEFAULT_LEAD_SCORING, leadScoringSchema } from "@isela/lead-finder";
import { SETTING_DEFINITIONS, SETTING_KEYS } from "@isela/settings";

describe("settings registry", () => {
  it("registers only typed keys whose defaults satisfy their schema", () => {
    expect(SETTING_KEYS.sort()).toEqual([
      "lead.scoring",
      "operations.assignment",
      "payment.policy",
      "quote.defaults",
    ]);
    for (const key of SETTING_KEYS) {
      const definition = SETTING_DEFINITIONS[key];
      expect(definition.schema.safeParse(definition.defaultValue).success, key).toBe(true);
    }
  });

  it("protects the payment policy with a dedicated permission", () => {
    expect(SETTING_DEFINITIONS["payment.policy"].permission).toBe("payment_policy:manage");
    expect(SETTING_DEFINITIONS["payment.policy"].scopes).toEqual(["GLOBAL"]);
  });

  it("rejects an invalid payment policy value", () => {
    const invalid = {
      ...SETTING_DEFINITIONS["payment.policy"].defaultValue,
      minSuccessfulPaidOrders: 2,
    };
    expect(SETTING_DEFINITIONS["payment.policy"].schema.safeParse(invalid).success).toBe(false);
  });
});

describe("lead scoring configuration", () => {
  it("accepts weights adding up to 100", () => {
    expect(leadScoringSchema.safeParse(DEFAULT_LEAD_SCORING).success).toBe(true);
  });

  it("rejects weights not adding up to 100", () => {
    const weights = { ...DEFAULT_LEAD_SCORING.weights, areaFit: 26 };
    expect(leadScoringSchema.safeParse({ weights }).success).toBe(false);
  });

  it("rejects unknown factors", () => {
    const weights = { ...DEFAULT_LEAD_SCORING.weights, cityBonus: 0 };
    expect(leadScoringSchema.safeParse({ weights }).success).toBe(false);
  });
});

describe("account lockout policy", () => {
  it("accepts the default", () => {
    expect(lockoutPolicySchema.safeParse(DEFAULT_LOCKOUT_POLICY).success).toBe(true);
  });

  it.each([
    { maxFailedAttempts: 50 },
    { maxFailedAttempts: 2 },
    { lockMinutes: 1 },
    { windowMinutes: 1 },
  ])("rejects unsafe values %o", (override) => {
    expect(lockoutPolicySchema.safeParse({ ...DEFAULT_LOCKOUT_POLICY, ...override }).success).toBe(
      false,
    );
  });
});
