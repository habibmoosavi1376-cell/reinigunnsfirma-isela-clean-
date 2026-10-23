import "server-only";
import type { ServiceContext } from "@isela/auth";
import { isDomainError } from "@isela/shared";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { CRM_ACTION_ERRORS, type CrmActionNotice } from "@/lib/admin/crm-actions";
import { logServerError } from "./logger";
import { getServiceContext } from "./session";

/*
 * Runner for back-office server actions. Inputs are whitelisted form fields; the domain
 * services authorise (RBAC + MFA) and validate everything again. The outcome is reported via
 * a whitelisted code in the redirect URL (no raw error messages, no stack traces).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formField(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** A uuid form field; anything else is treated as a missing resource. */
export function formId(form: FormData, name: string): string {
  const value = formField(form, name);
  if (value === undefined || !UUID.test(value)) notFound();
  return value;
}

export async function runAdminAction(
  target: string,
  notice: CrmActionNotice | ((result: unknown) => CrmActionNotice),
  operation: (ctx: ServiceContext) => Promise<unknown>,
  options: {
    readonly revalidate?: readonly string[];
    readonly redirectTo?: (result: unknown) => string;
  } = {},
): Promise<never> {
  let location: string;
  try {
    const result = await operation(await getServiceContext());
    const code = typeof notice === "function" ? notice(result) : notice;
    const path = options.redirectTo?.(result) ?? target;
    location = `${path}?notice=${code}`;
  } catch (error) {
    const code = isDomainError(error) ? error.code : "UNEXPECTED";
    if (!(code in CRM_ACTION_ERRORS) || code === "UNEXPECTED") {
      logServerError("admin.crm_action_failed", error);
    }
    location = `${target}?error=${code in CRM_ACTION_ERRORS ? code : "UNEXPECTED"}`;
  }
  revalidatePath(target);
  for (const path of options.revalidate ?? []) revalidatePath(path);
  redirect(location);
}
