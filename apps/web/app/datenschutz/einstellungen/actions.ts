"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  CONSENT_COOKIE_NAME,
  CONSENT_MAX_AGE_SECONDS,
  serializeConsentCookie,
} from "@/lib/analytics/consent";
import { getServices } from "@/lib/server/services";

const PATH = "/datenschutz/einstellungen";

async function storeDecision(choice: { statistics: boolean; marketing: boolean }): Promise<void> {
  const { clock, env } = getServices();
  (await cookies()).set(CONSENT_COOKIE_NAME, serializeConsentCookie(choice, clock.now()), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.APP_BASE_URL.startsWith("https://"),
    path: "/",
    maxAge: CONSENT_MAX_AGE_SECONDS,
  });
}

/**
 * Grants statistics consent – only possible while an analytics provider is actually active
 * (no consent is collected for processing that does not exist).
 */
export async function grantStatisticsConsentAction(): Promise<void> {
  if (getServices().analytics.enabled) {
    await storeDecision({ statistics: true, marketing: false });
    redirect(`${PATH}?status=saved`);
  }
  redirect(`${PATH}?status=unavailable`);
}

/** Withdraws every optional consent. Always possible, takes effect immediately. */
export async function withdrawConsentAction(): Promise<void> {
  await storeDecision({ statistics: false, marketing: false });
  redirect(`${PATH}?status=withdrawn`);
}
