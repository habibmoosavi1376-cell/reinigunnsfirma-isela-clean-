"use server";

import { submitCallbackRequest } from "@isela/crm";
import { isDomainError } from "@isela/shared";
import {
  callbackFieldErrors,
  echoCallbackFormValues,
  mapCallbackForm,
  type CallbackFormState,
} from "@/lib/forms/callback-form";
import { trackServerEvent } from "@/lib/server/analytics";
import { getClientKey } from "@/lib/server/client-key";
import { logServerError } from "@/lib/server/logger";
import { getServices } from "@/lib/server/services";
import { getCurrentActor } from "@/lib/server/session";

/**
 * Public server action "Rückruf anfordern". Origin-checked by Next.js (CSRF), whitelisted and
 * strictly validated input, rate-limited, idempotent per form. No appointment, no price.
 */
export async function submitCallbackAction(
  _previous: CallbackFormState,
  formData: FormData,
): Promise<CallbackFormState> {
  const { input, isBot } = mapCallbackForm(formData);
  if (isBot) return { status: "success" };
  const values = echoCallbackFormValues(formData);
  const services = getServices();
  const correlationId = crypto.randomUUID();
  try {
    const result = await submitCallbackRequest(input, {
      db: services.database.db,
      clock: services.clock,
      config: services.crmConfig,
      requester: await getCurrentActor(),
      clientKey: await getClientKey(),
      rateLimitPerHour: services.env.PUBLIC_REQUEST_RATE_LIMIT_PER_HOUR,
      correlationId,
    });
    if (!result.duplicate) {
      await trackServerEvent({
        name: "callback_requested",
        path: "/rueckruf",
        customerType: input["customerType"],
      });
    }
    return { status: "success" };
  } catch (error) {
    if (isDomainError(error, "VALIDATION_FAILED")) {
      const issues = (error.details?.["issues"] ?? []) as { path: string }[];
      return {
        status: "error",
        message: "Bitte prüfen Sie die markierten Angaben.",
        fieldErrors: callbackFieldErrors(issues),
        values,
      };
    }
    if (isDomainError(error, "RATE_LIMITED")) {
      return {
        status: "error",
        message: "Zu viele Anfragen in kurzer Zeit. Bitte versuchen Sie es später erneut.",
        fieldErrors: {},
        values,
      };
    }
    logServerError("callback_request.submit_failed", error, correlationId);
    return {
      status: "error",
      message: `Ihr Rückrufwunsch konnte gerade nicht gespeichert werden. Bitte versuchen Sie es später erneut. (Referenz: ${correlationId})`,
      fieldErrors: {},
      values,
    };
  }
}
