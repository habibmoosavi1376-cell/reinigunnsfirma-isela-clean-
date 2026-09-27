"use server";

import type { ServiceContext } from "@isela/auth";
import {
  correctRequestAddress,
  getLeadDetail,
  linkAccountToCustomer,
  linkLeadToCustomer,
  rerunRequestGeocoding,
  reviewGeocodingCandidate,
  transitionLead,
  withdrawLeadContactConsent,
} from "@isela/crm";
import { DomainError, isDomainError } from "@isela/shared";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { LEAD_ACTION_ERRORS, type LeadActionNotice } from "@/lib/admin/lead-actions";
import { logServerError } from "@/lib/server/logger";
import { getServices } from "@/lib/server/services";
import { getServiceContext } from "@/lib/server/session";

/*
 * Back-office actions for one lead. Each action reads only its whitelisted form fields, the
 * domain services authorise (RBAC + MFA) and validate everything again, and the browser never
 * supplies coordinates, service areas, customer or user ids. Results are reported via a
 * whitelisted code in the redirect URL (no raw error messages).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function leadIdOf(form: FormData): string {
  const leadId = field(form, "leadId");
  if (leadId === undefined || !UUID.test(leadId)) notFound();
  return leadId;
}

async function requestIdOf(ctx: ServiceContext, leadId: string): Promise<string> {
  const detail = await getLeadDetail(ctx, { leadId });
  if (detail.request === null) {
    throw new DomainError("NOT_FOUND", "Lead has no service request");
  }
  return detail.request.id;
}

async function run(
  leadId: string,
  notice: LeadActionNotice,
  operation: (ctx: ServiceContext) => Promise<unknown>,
): Promise<never> {
  let outcome: string;
  try {
    await operation(await getServiceContext());
    outcome = `notice=${notice}`;
  } catch (error) {
    const code = isDomainError(error) ? error.code : "UNEXPECTED";
    if (!(code in LEAD_ACTION_ERRORS) || code === "UNEXPECTED") {
      logServerError("admin.lead_action_failed", error);
    }
    outcome = `error=${code in LEAD_ACTION_ERRORS ? code : "UNEXPECTED"}`;
  }
  revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  redirect(`/admin/leads/${leadId}?${outcome}`);
}

export async function transitionLeadAction(form: FormData): Promise<void> {
  const leadId = leadIdOf(form);
  const reason = field(form, "reason");
  await run(leadId, "status_changed", (ctx) =>
    transitionLead(ctx, {
      leadId,
      to: field(form, "to"),
      ...(reason === undefined ? {} : { reason }),
    }),
  );
}

export async function rerunGeocodingAction(form: FormData): Promise<void> {
  const leadId = leadIdOf(form);
  await run(leadId, "geocoding_done", async (ctx) =>
    rerunRequestGeocoding(
      ctx,
      { serviceRequestId: await requestIdOf(ctx, leadId) },
      getServices().geocoding,
    ),
  );
}

export async function reviewGeocodingAction(form: FormData): Promise<void> {
  const leadId = leadIdOf(form);
  await run(leadId, "geocoding_reviewed", async (ctx) =>
    reviewGeocodingCandidate(ctx, {
      serviceRequestId: await requestIdOf(ctx, leadId),
      attemptId: field(form, "attemptId"),
      decision: field(form, "decision"),
    }),
  );
}

export async function correctAddressAction(form: FormData): Promise<void> {
  const leadId = leadIdOf(form);
  await run(leadId, "address_changed", async (ctx) =>
    correctRequestAddress(
      ctx,
      {
        serviceRequestId: await requestIdOf(ctx, leadId),
        street: field(form, "street"),
        houseNumber: field(form, "houseNumber"),
        postalCode: field(form, "postalCode"),
        city: field(form, "city"),
      },
      getServices().geocoding,
    ),
  );
}

export async function linkCustomerAction(form: FormData): Promise<void> {
  const leadId = leadIdOf(form);
  const taxId = field(form, "taxId");
  const paymentReference = field(form, "paymentReference");
  await run(leadId, "customer_linked", (ctx) =>
    linkLeadToCustomer(
      ctx,
      {
        leadId,
        ...(taxId === undefined ? {} : { taxId }),
        ...(paymentReference === undefined ? {} : { paymentReference }),
      },
      getServices().crmConfig,
    ),
  );
}

export async function linkAccountAction(form: FormData): Promise<void> {
  const leadId = leadIdOf(form);
  await run(leadId, "account_linked", (ctx) =>
    linkAccountToCustomer(ctx, { leadId }, getServices().crmConfig),
  );
}

export async function withdrawConsentAction(form: FormData): Promise<void> {
  const leadId = leadIdOf(form);
  const contactId = field(form, "contactId");
  await run(leadId, "consent_withdrawn", async (ctx) => {
    // The contact must belong to this lead (no cross-lead ids from the browser).
    const detail = await getLeadDetail(ctx, { leadId });
    if (!(detail.contacts ?? []).some((contact) => contact.id === contactId)) {
      throw new DomainError("NOT_FOUND", "Contact does not belong to this lead");
    }
    return withdrawLeadContactConsent(ctx, { contactId, purpose: field(form, "purpose") });
  });
}
