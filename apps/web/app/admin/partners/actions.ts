"use server";

import { localTime } from "@isela/operations";
import {
  addPartnerDocument,
  createPartner,
  reviewPartnerDocument,
  setPartnerCapacity,
  setPartnerServices,
  suspendPartner,
  verifyAndActivatePartner,
} from "@isela/partners";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";
import { loadOperationsConfig } from "@/lib/server/operations-config";

/*
 * Partner administration (partner:manage). Verification requires the configured document
 * kinds to be VERIFIED and valid on the business date; the database also refuses ACTIVE
 * partners without verification.
 */

function pathOf(partnerId: string): string {
  return `/admin/partners/${partnerId}`;
}

function decimal(value: string | undefined): number {
  return value === undefined ? Number.NaN : Number(value.replace(",", "."));
}

export async function createPartnerAction(form: FormData): Promise<void> {
  const capacity = formField(form, "maxConcurrentJobs");
  await runAdminAction(
    "/admin/partners",
    "partner_saved",
    (ctx) =>
      createPartner(ctx, {
        legalName: formField(form, "legalName") ?? "",
        baseLatitude: decimal(formField(form, "baseLatitude")),
        baseLongitude: decimal(formField(form, "baseLongitude")),
        serviceRadiusM: Number(formField(form, "serviceRadiusKm") ?? Number.NaN) * 1000,
        maxConcurrentJobs: capacity === undefined ? null : Number(capacity),
      }),
    { redirectTo: (id) => pathOf(String(id)) },
  );
}

export async function addDocumentAction(form: FormData): Promise<void> {
  const partnerId = formId(form, "partnerId");
  const validUntil = formField(form, "validUntil");
  await runAdminAction(pathOf(partnerId), "partner_saved", (ctx) =>
    addPartnerDocument(ctx, {
      partnerId,
      kind: formField(form, "kind"),
      reference: formField(form, "reference") ?? "",
      ...(validUntil === undefined ? {} : { validUntil }),
    }),
  );
}

export async function reviewDocumentAction(form: FormData): Promise<void> {
  const partnerId = formId(form, "partnerId");
  const documentId = formId(form, "documentId");
  await runAdminAction(pathOf(partnerId), "partner_saved", (ctx) =>
    reviewPartnerDocument(ctx, { partnerId, documentId, decision: formField(form, "decision") }),
  );
}

export async function setServicesAction(form: FormData): Promise<void> {
  const partnerId = formId(form, "partnerId");
  const serviceIds = form.getAll("serviceIds").filter((v): v is string => typeof v === "string");
  await runAdminAction(pathOf(partnerId), "partner_saved", (ctx) =>
    setPartnerServices(ctx, { partnerId, serviceIds }),
  );
}

export async function setCapacityAction(form: FormData): Promise<void> {
  const partnerId = formId(form, "partnerId");
  const capacity = formField(form, "maxConcurrentJobs");
  await runAdminAction(pathOf(partnerId), "partner_saved", (ctx) =>
    setPartnerCapacity(ctx, {
      partnerId,
      maxConcurrentJobs: capacity === undefined ? null : Number(capacity),
    }),
  );
}

export async function verifyPartnerAction(form: FormData): Promise<void> {
  const partnerId = formId(form, "partnerId");
  await runAdminAction(pathOf(partnerId), "partner_verified", async (ctx) => {
    const config = await loadOperationsConfig(ctx.db, ctx.clock);
    return verifyAndActivatePartner(
      ctx,
      { partnerId },
      {
        requiredDocumentKinds: config.requiredPartnerDocumentKinds,
        today: localTime(ctx.clock.now(), config.timeZone).date,
      },
    );
  });
}

export async function suspendPartnerAction(form: FormData): Promise<void> {
  const partnerId = formId(form, "partnerId");
  await runAdminAction(pathOf(partnerId), "partner_saved", (ctx) =>
    suspendPartner(ctx, { partnerId, reason: formField(form, "reason") ?? "" }),
  );
}
