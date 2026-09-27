"use server";

import { acceptInvitation } from "@isela/auth";
import { isDomainError } from "@isela/shared";
import { redirect } from "next/navigation";
import { logServerError } from "@/lib/server/logger";
import { requireSignedIn } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * Accepts an invitation for the signed-in account (explicit POST – a GET never accepts).
 * The domain service checks token hash, expiry, single use and the verified e-mail address;
 * all failure reasons are reported identically so that nothing can be enumerated.
 */
export async function acceptInvitationAction(form: FormData): Promise<void> {
  await requireSignedIn();
  const token = form.get("token");
  let outcome: "accepted" | "invalid" | "conflict" | "failed";
  if (typeof token !== "string" || !TOKEN.test(token)) {
    outcome = "invalid";
  } else {
    try {
      await acceptInvitation(await getServiceContext(), { token });
      outcome = "accepted";
    } catch (error) {
      if (isDomainError(error, "NOT_FOUND") || isDomainError(error, "VALIDATION_FAILED")) {
        outcome = "invalid";
      } else if (isDomainError(error, "CONFLICT")) {
        outcome = "conflict";
      } else {
        logServerError("account.invitation_accept_failed", error);
        outcome = "failed";
      }
    }
  }
  // The token is never put back into a URL.
  redirect(`/account/invitation?result=${outcome}`);
}
