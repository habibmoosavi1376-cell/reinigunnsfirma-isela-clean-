"use server";

import { createBookingFromQuote } from "@isela/operations";
import {
  addQuoteItem,
  addQuoteItemFromCalculation,
  calculateQuoteItemPrice,
  removeQuoteItem,
  transitionQuote,
  updateQuoteDetails,
} from "@isela/quotes";
import { parseDecimal, parseMoneyToCents } from "@/lib/admin/format";
import { zonedDateTimeToIso } from "@/lib/admin/time";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";
import { loadOperationsConfig, loadPaymentPolicy } from "@/lib/server/operations-config";
import { loadQuoteConfig } from "@/lib/server/quote-config";

/*
 * Quote editor actions. The browser supplies only the item inputs (description, quantity,
 * unit, unit price, tax rate from the configured list) – totals, owner, creator and status
 * are computed/derived on the server. Status changes go through the quote state machine.
 */

function pathOf(quoteId: string): string {
  return `/admin/quotes/${quoteId}`;
}

export async function addQuoteItemAction(form: FormData): Promise<void> {
  const quoteId = formId(form, "quoteId");
  const quantity = parseDecimal(formField(form, "quantity") ?? "");
  const unitPriceCents = parseMoneyToCents(formField(form, "unitPrice") ?? "");
  const taxRate = formField(form, "taxRateBasisPoints");
  const serviceId = formField(form, "serviceId");
  await runAdminAction(pathOf(quoteId), "quote_item_added", async (ctx) =>
    addQuoteItem(
      ctx,
      {
        quoteId,
        serviceCategoryId: formField(form, "serviceCategoryId"),
        ...(serviceId === undefined ? {} : { serviceId }),
        description: formField(form, "description"),
        quantity: quantity ?? Number.NaN,
        unit: formField(form, "unit"),
        unitPriceCents: unitPriceCents ?? Number.NaN,
        ...(taxRate === undefined ? {} : { taxRateBasisPoints: Number(taxRate) }),
      },
      await loadQuoteConfig(ctx.db, ctx.clock),
    ),
  );
}

export async function removeQuoteItemAction(form: FormData): Promise<void> {
  const quoteId = formId(form, "quoteId");
  const itemId = formId(form, "itemId");
  await runAdminAction(pathOf(quoteId), "quote_item_removed", (ctx) =>
    removeQuoteItem(ctx, { quoteId, itemId }),
  );
}

export async function updateQuoteDetailsAction(form: FormData): Promise<void> {
  const quoteId = formId(form, "quoteId");
  const propertyId = formField(form, "propertyId");
  const validUntil = formField(form, "validUntil");
  await runAdminAction(pathOf(quoteId), "quote_updated", async (ctx) =>
    updateQuoteDetails(
      ctx,
      {
        quoteId,
        propertyId: propertyId ?? null,
        validUntil: validUntil ?? null,
        notes: formField(form, "notes") ?? "",
      },
      await loadQuoteConfig(ctx.db, ctx.clock),
    ),
  );
}

export async function transitionQuoteAction(form: FormData): Promise<void> {
  const quoteId = formId(form, "quoteId");
  const reason = formField(form, "reason");
  await runAdminAction(
    pathOf(quoteId),
    "quote_transitioned",
    async (ctx) =>
      transitionQuote(
        ctx,
        { quoteId, to: formField(form, "to"), ...(reason === undefined ? {} : { reason }) },
        await loadQuoteConfig(ctx.db, ctx.clock),
      ),
    { revalidate: ["/admin/quotes"] },
  );
}

/** Engine pricing: the browser chooses whitelisted parameters; amounts come from the server. */
export async function calculatePriceAction(form: FormData): Promise<void> {
  const quoteId = formId(form, "quoteId");
  const quantity = formField(form, "quantity");
  const windows = formField(form, "windows");
  const extraIds = form.getAll("extraIds").filter((v): v is string => typeof v === "string");
  await runAdminAction(
    pathOf(quoteId),
    "price_calculated",
    async (ctx) =>
      calculateQuoteItemPrice(
        ctx,
        {
          quoteId,
          serviceId: formField(form, "serviceId"),
          ...(quantity === undefined ? {} : { quantity: parseDecimal(quantity) ?? Number.NaN }),
          ...(windows === undefined ? {} : { windows: Number(windows) }),
          frequency: formField(form, "frequency"),
          urgency: formField(form, "urgency"),
          extraIds,
        },
        await loadQuoteConfig(ctx.db, ctx.clock),
      ),
    {
      redirectTo: (result) =>
        `${pathOf(quoteId)}/calculation/${(result as { calculationId: string }).calculationId}`,
    },
  );
}

export async function addItemFromCalculationAction(form: FormData): Promise<void> {
  const quoteId = formId(form, "quoteId");
  const calculationId = formId(form, "calculationId");
  const override = formField(form, "overrideNet");
  const overrideReason = formField(form, "overrideReason");
  await runAdminAction(
    pathOf(quoteId),
    "quote_item_added",
    async (ctx) =>
      addQuoteItemFromCalculation(
        ctx,
        {
          quoteId,
          calculationId,
          ...(override === undefined
            ? {}
            : { overrideNetCents: parseMoneyToCents(override) ?? Number.NaN }),
          ...(overrideReason === undefined ? {} : { overrideReason }),
        },
        await loadQuoteConfig(ctx.db, ctx.clock),
      ),
    { redirectTo: () => pathOf(quoteId) },
  );
}

/** Booking from an ACCEPTED quote. Date/times are business-local; the server converts them. */
export async function createBookingAction(form: FormData): Promise<void> {
  const quoteId = formId(form, "quoteId");
  const date = formField(form, "date") ?? "";
  await runAdminAction(
    pathOf(quoteId),
    "booking_created",
    async (ctx) => {
      const config = await loadOperationsConfig(ctx.db, ctx.clock);
      const windowStart = zonedDateTimeToIso(date, formField(form, "from") ?? "", config.timeZone);
      const windowEnd = zonedDateTimeToIso(date, formField(form, "to") ?? "", config.timeZone);
      return createBookingFromQuote(
        ctx,
        {
          quoteId,
          windowStart: windowStart ?? "",
          windowEnd: windowEnd ?? "",
          durationMinutes: Number(formField(form, "durationMinutes") ?? Number.NaN),
          operationalNotes: formField(form, "operationalNotes") ?? "",
        },
        { paymentPolicy: await loadPaymentPolicy(ctx.db, ctx.clock), config },
      );
    },
    {
      revalidate: ["/admin/bookings"],
      redirectTo: (result) => `/admin/bookings/${(result as { bookingId: string }).bookingId}`,
    },
  );
}
