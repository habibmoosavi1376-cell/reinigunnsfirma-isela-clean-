"use server";

import { addQuoteItem, removeQuoteItem, transitionQuote, updateQuoteDetails } from "@isela/quotes";
import { parseDecimal, parseMoneyToCents } from "@/lib/admin/format";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";
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
