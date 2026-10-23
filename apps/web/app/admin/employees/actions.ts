"use server";

import {
  addUnavailability,
  addWorkingWindow,
  createEmployee,
  linkEmployeeAccount,
  removeWorkingWindow,
  setEmployeeServiceAreas,
  updateEmployee,
} from "@isela/operations";
import { parseMinuteOfDay, zonedDateTimeToIso } from "@/lib/admin/time";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";
import { loadOperationsConfig } from "@/lib/server/operations-config";

/*
 * Employee administration (employee:manage). Only whitelisted fields are read; qualification
 * keys are validated as slugs by the domain service.
 */

function qualificationsOf(form: FormData): string[] {
  return (formField(form, "qualifications") ?? "")
    .split(",")
    .map((q) => q.trim().toLowerCase())
    .filter((q) => q !== "");
}

function optionalInt(value: string | undefined): number | null {
  return value === undefined ? null : Number(value);
}

export async function createEmployeeAction(form: FormData): Promise<void> {
  await runAdminAction(
    "/admin/employees",
    "employee_saved",
    (ctx) =>
      createEmployee(ctx, {
        displayName: formField(form, "displayName") ?? "",
        qualifications: qualificationsOf(form),
        maxJobsPerDay: optionalInt(formField(form, "maxJobsPerDay")),
      }),
    { redirectTo: (id) => `/admin/employees/${String(id)}` },
  );
}

function pathOf(employeeId: string): string {
  return `/admin/employees/${employeeId}`;
}

export async function updateEmployeeAction(form: FormData): Promise<void> {
  const employeeId = formId(form, "employeeId");
  await runAdminAction(pathOf(employeeId), "employee_saved", (ctx) =>
    updateEmployee(ctx, {
      employeeId,
      displayName: formField(form, "displayName") ?? "",
      active: formField(form, "active") === "true",
      qualifications: qualificationsOf(form),
      maxJobsPerDay: optionalInt(formField(form, "maxJobsPerDay")),
    }),
  );
}

export async function setServiceAreasAction(form: FormData): Promise<void> {
  const employeeId = formId(form, "employeeId");
  const serviceAreaIds = form
    .getAll("serviceAreaIds")
    .filter((v): v is string => typeof v === "string");
  await runAdminAction(pathOf(employeeId), "employee_saved", (ctx) =>
    setEmployeeServiceAreas(ctx, { employeeId, serviceAreaIds }),
  );
}

export async function addWorkingWindowAction(form: FormData): Promise<void> {
  const employeeId = formId(form, "employeeId");
  await runAdminAction(pathOf(employeeId), "employee_saved", (ctx) =>
    addWorkingWindow(ctx, {
      employeeId,
      weekday: Number(formField(form, "weekday")),
      startMinute: parseMinuteOfDay(formField(form, "from") ?? "") ?? Number.NaN,
      endMinute: parseMinuteOfDay(formField(form, "to") ?? "") ?? Number.NaN,
    }),
  );
}

export async function removeWorkingWindowAction(form: FormData): Promise<void> {
  const employeeId = formId(form, "employeeId");
  const windowId = formId(form, "windowId");
  await runAdminAction(pathOf(employeeId), "employee_saved", (ctx) =>
    removeWorkingWindow(ctx, { employeeId, windowId }),
  );
}

export async function addUnavailabilityAction(form: FormData): Promise<void> {
  const employeeId = formId(form, "employeeId");
  await runAdminAction(pathOf(employeeId), "employee_saved", async (ctx) => {
    const { timeZone } = await loadOperationsConfig(ctx.db, ctx.clock);
    return addUnavailability(ctx, {
      employeeId,
      kind: formField(form, "kind"),
      startsAt:
        zonedDateTimeToIso(
          formField(form, "fromDate") ?? "",
          formField(form, "fromTime") ?? "",
          timeZone,
        ) ?? "",
      endsAt:
        zonedDateTimeToIso(
          formField(form, "toDate") ?? "",
          formField(form, "toTime") ?? "",
          timeZone,
        ) ?? "",
    });
  });
}

export async function linkAccountAction(form: FormData): Promise<void> {
  const employeeId = formId(form, "employeeId");
  await runAdminAction(pathOf(employeeId), "employee_saved", (ctx) =>
    linkEmployeeAccount(ctx, { employeeId, userId: formField(form, "userId") ?? "" }),
  );
}
