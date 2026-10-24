"use server";

import {
  addContractPause,
  endContractPause,
  generateContractBookings,
  updateContractPause,
  updateContractStatus,
} from "@isela/operations";
import { DomainError } from "@isela/shared";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";
import {
  loadOperationsConfig,
  loadPaymentPolicy,
  loadRecurringConfig,
} from "@/lib/server/operations-config";

/*
 * Contract actions. Only ids, dates, the target status, the version the user saw and a
 * reason come from the form; rules, prices and payment terms are derived on the server.
 */

function pathOf(contractId: string): string {
  return `/admin/contracts/${contractId}`;
}

export async function updateContractStatusAction(form: FormData): Promise<void> {
  const contractId = formId(form, "contractId");
  await runAdminAction(
    pathOf(contractId),
    "contract_status_changed",
    (ctx) =>
      updateContractStatus(ctx, {
        contractId,
        to: formField(form, "to") ?? "",
        expectedVersion: Number(formField(form, "expectedVersion") ?? Number.NaN),
        reason: formField(form, "reason") ?? "",
      }),
    { revalidate: ["/admin/contracts"] },
  );
}

/** Generates the appointments of the configured horizon (idempotent). */
export async function generateContractAction(form: FormData): Promise<void> {
  const contractId = formId(form, "contractId");
  await runAdminAction(
    pathOf(contractId),
    "contract_generated",
    async (ctx) => {
      const [config, recurring, paymentPolicy] = await Promise.all([
        loadOperationsConfig(ctx.db, ctx.clock),
        loadRecurringConfig(ctx.db, ctx.clock),
        loadPaymentPolicy(ctx.db, ctx.clock),
      ]);
      if (recurring.holidayRegion === null) {
        throw new DomainError("CONFIG_REQUIRED", "No holiday region configured");
      }
      const from = new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone }).format(
        ctx.clock.now(),
      );
      const to = new Date(
        Date.parse(`${from}T00:00:00Z`) + (recurring.generationHorizonDays - 1) * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      return generateContractBookings(
        ctx,
        { contractId, from, to },
        { paymentPolicy, config, holidayRegion: recurring.holidayRegion },
      );
    },
    { revalidate: ["/admin/contracts", "/admin/bookings"] },
  );
}

export async function addPauseAction(form: FormData): Promise<void> {
  const contractId = formId(form, "contractId");
  await runAdminAction(
    pathOf(contractId),
    (result) =>
      (result as { conflictingBookingIds: string[] }).conflictingBookingIds.length > 0
        ? "pause_added_conflicts"
        : "pause_added",
    (ctx) =>
      addContractPause(ctx, {
        contractId,
        fromDate: formField(form, "fromDate") ?? "",
        toDate: formField(form, "toDate") ?? "",
        reason: formField(form, "reason") ?? "",
      }),
  );
}

export async function updatePauseAction(form: FormData): Promise<void> {
  const contractId = formId(form, "contractId");
  await runAdminAction(
    pathOf(contractId),
    (result) =>
      (result as { conflictingBookingIds: string[] }).conflictingBookingIds.length > 0
        ? "pause_added_conflicts"
        : "pause_updated",
    async (ctx) => {
      const config = await loadOperationsConfig(ctx.db, ctx.clock);
      return updateContractPause(
        ctx,
        {
          pauseId: formId(form, "pauseId"),
          fromDate: formField(form, "fromDate") ?? "",
          toDate: formField(form, "toDate") ?? "",
          reason: formField(form, "reason") ?? "",
        },
        { timeZone: config.timeZone },
      );
    },
  );
}

export async function endPauseAction(form: FormData): Promise<void> {
  const contractId = formId(form, "contractId");
  await runAdminAction(pathOf(contractId), "pause_ended", (ctx) =>
    endContractPause(ctx, {
      pauseId: formId(form, "pauseId"),
      lastDay: formField(form, "lastDay") ?? "",
    }),
  );
}
