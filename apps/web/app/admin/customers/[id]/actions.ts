"use server";

import {
  addCustomerAddress,
  createProperty,
  setPrimaryAddress,
  updateCustomer,
  updateCustomerAddress,
  updateProperty,
} from "@isela/crm";
import { createQuoteDraft } from "@isela/quotes";
import { parseDecimal } from "@/lib/admin/format";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";
import { getServices } from "@/lib/server/services";

/*
 * Customer detail actions. Only whitelisted fields are read; ids from the form only select
 * the target record – ownership is always derived and checked by the domain services (a
 * property/address of another customer is rejected there, and by database triggers).
 * Coordinates, statuses, creators and amounts are never accepted from the browser.
 */

function pathOf(customerId: string): string {
  return `/admin/customers/${customerId}`;
}

/** Optional numeric field: empty → undefined, invalid → NaN (rejected by the domain schema). */
function numberField(form: FormData, name: string, integer: boolean): number | undefined {
  const value = formField(form, name);
  if (value === undefined) return undefined;
  const parsed = parseDecimal(value);
  if (parsed === null || (integer && !Number.isInteger(parsed))) return Number.NaN;
  return parsed;
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

export async function updateCustomerAction(form: FormData): Promise<void> {
  const customerId = formId(form, "customerId");
  await runAdminAction(pathOf(customerId), "customer_updated", (ctx) =>
    updateCustomer(ctx, {
      customerId,
      ...optional("displayName", formField(form, "displayName")),
      ...optional("companyName", formField(form, "companyName")),
    }),
  );
}

export async function addAddressAction(form: FormData): Promise<void> {
  const customerId = formId(form, "customerId");
  await runAdminAction(
    pathOf(customerId),
    (result) =>
      (result as { duplicateOfAddressId: string | null }).duplicateOfAddressId === null
        ? "address_added"
        : "address_added_duplicate",
    (ctx) =>
      addCustomerAddress(
        ctx,
        {
          customerId,
          addressType: formField(form, "addressType"),
          isPrimary: form.get("isPrimary") === "on",
          street: formField(form, "street"),
          houseNumber: formField(form, "houseNumber"),
          postalCode: formField(form, "postalCode"),
          city: formField(form, "city"),
        },
        getServices().crmConfig,
      ),
  );
}

export async function updateAddressAction(form: FormData): Promise<void> {
  const customerId = formId(form, "customerId");
  const addressId = formId(form, "addressId");
  await runAdminAction(pathOf(customerId), "address_updated", (ctx) =>
    updateCustomerAddress(ctx, {
      addressId,
      ...optional("addressType", formField(form, "addressType")),
      ...optional("street", formField(form, "street")),
      ...optional("houseNumber", formField(form, "houseNumber")),
      ...optional("postalCode", formField(form, "postalCode")),
      ...optional("city", formField(form, "city")),
    }),
  );
}

export async function setPrimaryAddressAction(form: FormData): Promise<void> {
  const customerId = formId(form, "customerId");
  const addressId = formId(form, "addressId");
  await runAdminAction(pathOf(customerId), "primary_changed", (ctx) =>
    setPrimaryAddress(ctx, { addressId }),
  );
}

function propertyFields(form: FormData) {
  return {
    ...optional("name", formField(form, "name")),
    ...optional("propertyType", formField(form, "propertyType")),
    ...optional("areaSqm", numberField(form, "areaSqm", false)),
    ...optional("rooms", numberField(form, "rooms", true)),
    ...optional("bathrooms", numberField(form, "bathrooms", true)),
    ...optional("serviceFrequency", formField(form, "serviceFrequency")),
  };
}

export async function createPropertyAction(form: FormData): Promise<void> {
  const customerId = formId(form, "customerId");
  await runAdminAction(pathOf(customerId), "property_created", (ctx) =>
    createProperty(ctx, {
      customerId,
      addressId: formField(form, "addressId"),
      ...propertyFields(form),
      ...optional("serviceRequirements", formField(form, "serviceRequirements")),
      ...optional("notes", formField(form, "notes")),
    }),
  );
}

export async function updatePropertyAction(form: FormData): Promise<void> {
  const customerId = formId(form, "customerId");
  const propertyId = formId(form, "propertyId");
  await runAdminAction(pathOf(customerId), "property_updated", (ctx) =>
    updateProperty(ctx, {
      propertyId,
      ...optional("addressId", formField(form, "addressId")),
      ...propertyFields(form),
      // Text areas may be cleared deliberately: an empty value removes the text.
      serviceRequirements: formField(form, "serviceRequirements") ?? "",
      notes: formField(form, "notes") ?? "",
    }),
  );
}

export async function setPropertyActiveAction(form: FormData): Promise<void> {
  const customerId = formId(form, "customerId");
  const propertyId = formId(form, "propertyId");
  const active = formField(form, "active");
  await runAdminAction(pathOf(customerId), "property_updated", (ctx) =>
    updateProperty(ctx, {
      propertyId,
      active: active === "true" ? true : active === "false" ? false : active,
    }),
  );
}

export async function createQuoteAction(form: FormData): Promise<void> {
  const customerId = formId(form, "customerId");
  await runAdminAction(
    pathOf(customerId),
    "quote_created",
    (ctx) =>
      createQuoteDraft(ctx, {
        customerId,
        ...optional("propertyId", formField(form, "propertyId")),
      }),
    { redirectTo: (quoteId) => `/admin/quotes/${String(quoteId)}`, revalidate: ["/admin/quotes"] },
  );
}
