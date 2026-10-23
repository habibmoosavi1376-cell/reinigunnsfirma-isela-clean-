"use server";

import {
  activatePriceRuleSet,
  createPriceRuleSetDraft,
  getActivePriceRuleSet,
  updatePriceRuleSetDraft,
} from "@isela/pricing";
import { DomainError } from "@isela/shared";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";

/*
 * Price rule actions. Drafts are edited as a JSON rule document that the domain validates
 * strictly (unknown fields, floats and negative amounts are rejected); open values stay
 * "CONFIG_REQUIRED". Activation (pricing:approve) freezes the version.
 */

const PATH = "/admin/pricing";

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? "");
  } catch {
    throw new DomainError("VALIDATION_FAILED", "Rules are not valid JSON");
  }
}

export async function createDraftAction(form: FormData): Promise<void> {
  const copyActive = formField(form, "source") === "active";
  await runAdminAction(
    PATH,
    "rule_set_saved",
    async (ctx) => {
      const active = copyActive ? await getActivePriceRuleSet(ctx.db, null) : null;
      return createPriceRuleSetDraft(ctx, {
        changeReason: formField(form, "changeReason") ?? "",
        ...(active === null ? {} : { rules: active.rules }),
      });
    },
    { redirectTo: (result) => `${PATH}?ruleSet=${(result as { id: string }).id}` },
  );
}

export async function updateDraftAction(form: FormData): Promise<void> {
  const ruleSetId = formId(form, "ruleSetId");
  await runAdminAction(
    PATH,
    "rule_set_saved",
    (ctx) =>
      updatePriceRuleSetDraft(ctx, {
        ruleSetId,
        rules: parseJson(formField(form, "rules")),
        changeReason: formField(form, "changeReason") ?? "",
      }),
    { redirectTo: () => `${PATH}?ruleSet=${ruleSetId}` },
  );
}

export async function activateAction(form: FormData): Promise<void> {
  const ruleSetId = formId(form, "ruleSetId");
  await runAdminAction(
    PATH,
    "rule_set_activated",
    (ctx) => activatePriceRuleSet(ctx, { ruleSetId }),
    {
      redirectTo: () => `${PATH}?ruleSet=${ruleSetId}`,
    },
  );
}
