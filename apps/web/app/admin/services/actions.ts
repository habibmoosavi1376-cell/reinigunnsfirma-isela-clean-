"use server";

import {
  createCatalogService,
  createServiceCategory,
  createServiceOption,
  setServiceOptionActive,
  updateCatalogService,
} from "@isela/catalog";
import { parseDecimal } from "@/lib/admin/format";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";

/*
 * Service catalogue actions (catalog:manage). Whitelisted fields only; the catalogue stores no
 * prices. Qualification keys and property types are validated by the domain service.
 */

const PATH = "/admin/services";

function optionalInt(value: string | undefined): number | null {
  return value === undefined ? null : Number(value);
}

function listOf(form: FormData, name: string): string[] {
  return (formField(form, name) ?? "")
    .split(",")
    .map((q) => q.trim().toLowerCase())
    .filter((q) => q !== "");
}

export async function createCategoryAction(form: FormData): Promise<void> {
  const sortOrder = formField(form, "sortOrder");
  await runAdminAction(PATH, "category_saved", (ctx) =>
    createServiceCategory(ctx, {
      key: formField(form, "key") ?? "",
      name: formField(form, "name") ?? "",
      description: formField(form, "description") ?? "",
      ...(sortOrder === undefined ? {} : { sortOrder: Number(sortOrder) }),
    }),
  );
}

export async function createServiceAction(form: FormData): Promise<void> {
  const minQuantity = formField(form, "minQuantity");
  await runAdminAction(PATH, "service_saved", (ctx) =>
    createCatalogService(ctx, {
      categoryId: formField(form, "categoryId"),
      key: formField(form, "key") ?? "",
      name: formField(form, "name") ?? "",
      description: formField(form, "description") ?? "",
      unit: formField(form, "unit"),
      minQuantity: minQuantity === undefined ? null : (parseDecimal(minQuantity) ?? Number.NaN),
      durationModel: formField(form, "durationModel"),
      baseDurationMinutes: optionalInt(formField(form, "baseDurationMinutes")),
      durationPerUnitSeconds: optionalInt(formField(form, "durationPerUnitSeconds")),
      pricingStrategy: formField(form, "pricingStrategy"),
      requiredQualifications: listOf(form, "requiredQualifications"),
      supportedPropertyTypes: form
        .getAll("supportedPropertyTypes")
        .filter((v): v is string => typeof v === "string"),
    }),
  );
}

export async function setServiceActiveAction(form: FormData): Promise<void> {
  const serviceId = formId(form, "serviceId");
  await runAdminAction(PATH, "service_saved", (ctx) =>
    updateCatalogService(ctx, { serviceId, active: formField(form, "active") === "true" }),
  );
}

export async function createOptionAction(form: FormData): Promise<void> {
  const serviceId = formId(form, "serviceId");
  await runAdminAction(PATH, "option_saved", (ctx) =>
    createServiceOption(ctx, {
      serviceId,
      key: formField(form, "key") ?? "",
      name: formField(form, "name") ?? "",
    }),
  );
}

export async function setOptionActiveAction(form: FormData): Promise<void> {
  const serviceId = formId(form, "serviceId");
  const optionId = formId(form, "optionId");
  await runAdminAction(PATH, "option_saved", (ctx) =>
    setServiceOptionActive(ctx, {
      serviceId,
      optionId,
      active: formField(form, "active") === "true",
    }),
  );
}
