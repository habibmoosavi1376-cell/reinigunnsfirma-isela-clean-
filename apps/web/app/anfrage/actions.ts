"use server";

import { submitServiceRequest } from "@isela/crm";
import { isDomainError } from "@isela/shared";
import {
  echoRequestFormValues,
  fieldErrorsFromIssues,
  mapRequestForm,
  type RequestFormState,
} from "@/lib/forms/request-form";
import { getClientKey } from "@/lib/server/client-key";
import { logServerError } from "@/lib/server/logger";
import { getServices } from "@/lib/server/services";
import { getCurrentActor } from "@/lib/server/session";

/**
 * Public server action "Reinigung anfragen". Next.js checks the Origin of server actions
 * (CSRF protection); input is mapped by whitelist and validated by the domain schema.
 * No price, booking, payment or partner assignment happens here.
 */
export async function submitRequestAction(
  _previous: RequestFormState,
  formData: FormData,
): Promise<RequestFormState> {
  const { input, isBot } = mapRequestForm(formData);
  if (isBot) {
    // Silently drop bot submissions (honeypot filled); nothing is stored.
    return { status: "success" };
  }
  const values = echoRequestFormValues(formData);
  const services = getServices();
  const correlationId = crypto.randomUUID();
  try {
    await submitServiceRequest(input, {
      db: services.database.db,
      clock: services.clock,
      config: services.crmConfig,
      requester: await getCurrentActor(),
      clientKey: await getClientKey(),
      rateLimitPerHour: services.env.PUBLIC_REQUEST_RATE_LIMIT_PER_HOUR,
      correlationId,
    });
    return { status: "success" };
  } catch (error) {
    if (isDomainError(error, "VALIDATION_FAILED")) {
      const issues = (error.details?.["issues"] ?? []) as { path: string }[];
      return {
        status: "error",
        message: "Bitte prüfen Sie die markierten Angaben.",
        fieldErrors: fieldErrorsFromIssues(issues),
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
    logServerError("service_request.submit_failed", error, correlationId);
    return {
      status: "error",
      message: `Ihre Anfrage konnte gerade nicht gespeichert werden. Bitte versuchen Sie es später erneut. (Referenz: ${correlationId})`,
      fieldErrors: {},
      values,
    };
  }
}
