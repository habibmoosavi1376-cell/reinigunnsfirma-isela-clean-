"use server";

import { recordHolidayYear } from "@isela/operations";
import { updateSetting } from "@isela/settings";
import { DomainError } from "@isela/shared";
import { formField, runAdminAction } from "@/lib/server/admin-actions";
import { loadRecurringConfig } from "@/lib/server/operations-config";

/*
 * Holiday data and recurring settings (settings:manage, enforced by the services). Holiday
 * rows are entered from the named official source and approved by the submitting person –
 * the system never derives or invents them.
 */

const PATH = "/admin/contracts/holidays";

export async function saveRecurringSettingsAction(form: FormData): Promise<void> {
  await runAdminAction(PATH, "settings_saved", async (ctx) => {
    const current = await loadRecurringConfig(ctx.db, ctx.clock);
    const region = (formField(form, "holidayRegion") ?? "").trim().toUpperCase();
    return updateSetting(ctx, {
      key: "operations.recurring",
      scopeType: "GLOBAL",
      value: {
        ...current,
        holidayRegion: region === "" ? null : region,
        generationHorizonDays: Number(formField(form, "generationHorizonDays") ?? Number.NaN),
        reminderLeadHours: Number(formField(form, "reminderLeadHours") ?? Number.NaN),
      },
      changeReason: formField(form, "changeReason") ?? "",
    });
  });
}

/** Lines "YYYY-MM-DD;Name" → holiday rows (strict format, max 40). */
function parseHolidayLines(text: string): { date: string; name: string }[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length > 40) throw new DomainError("VALIDATION_FAILED", "Too many holidays");
  return lines.map((line) => {
    const match = /^(\d{4}-\d{2}-\d{2})\s*;\s*(.{2,200})$/.exec(line);
    if (match === null) throw new DomainError("VALIDATION_FAILED", "Invalid holiday line");
    return { date: match[1] ?? "", name: (match[2] ?? "").trim() };
  });
}

export async function recordHolidayYearAction(form: FormData): Promise<void> {
  await runAdminAction(PATH, "holidays_recorded", async (ctx) => {
    const current = await loadRecurringConfig(ctx.db, ctx.clock);
    if (current.holidayRegion === null) {
      throw new DomainError("CONFIG_REQUIRED", "Configure the holiday region first");
    }
    return recordHolidayYear(ctx, {
      region: current.holidayRegion,
      year: Number(formField(form, "year") ?? Number.NaN),
      sourceReference: formField(form, "sourceReference") ?? "",
      holidays: parseHolidayLines(formField(form, "holidays") ?? ""),
    });
  });
}
