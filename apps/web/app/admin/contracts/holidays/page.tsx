import { hasGlobalPermission } from "@isela/auth";
import { listHolidayCoverage } from "@isela/operations";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import { formatDateTime } from "@/lib/admin/format";
import { requireAdminArea } from "@/lib/server/guards";
import { loadRecurringConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";
import { recordHolidayYearAction, saveRecurringSettingsAction } from "./actions";

export const metadata: Metadata = { title: "Feiertagsdaten" };

export default async function HolidayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "booking:read")) forbidden();
  const ctx = await getServiceContext();
  const recurring = await loadRecurringConfig(ctx.db, ctx.clock);
  const coverage =
    recurring.holidayRegion === null
      ? []
      : await listHolidayCoverage(ctx, { region: recurring.holidayRegion });
  const canManage = hasGlobalPermission(actor, "settings:manage");
  const query = await searchParams;

  return (
    <>
      <p>
        <Link href="/admin/contracts">← Wiederkehrende Aufträge</Link>
      </p>
      <h1>Feiertagsdaten und Planung</h1>
      <ActionResult query={query} />
      <p className="hint">
        Termine werden nur für Jahre erzeugt, deren Feiertage aus einer amtlichen Quelle erfasst und
        freigegeben sind. Das System berechnet oder ergänzt keine Feiertage selbst.
      </p>

      <section className="panel" aria-labelledby="settings-title">
        <h2 id="settings-title">Einstellungen</h2>
        <dl className="facts">
          <dt>Feiertagsregion</dt>
          <dd>{recurring.holidayRegion ?? "nicht konfiguriert"}</dd>
          <dt>Planungshorizont</dt>
          <dd>{recurring.generationHorizonDays} Tage</dd>
          <dt>Vorlauf Terminerinnerung</dt>
          <dd>{recurring.reminderLeadHours} Stunden</dd>
        </dl>
        {canManage ? (
          <form
            action={saveRecurringSettingsAction}
            className="form"
            aria-label="Einstellungen ändern"
          >
            <div className="field">
              <label htmlFor="holiday-region">Feiertagsregion (ISO 3166-2, z. B. DE-NW)</label>
              <input
                id="holiday-region"
                name="holidayRegion"
                defaultValue={recurring.holidayRegion ?? ""}
                pattern="[A-Za-z]{2}-[A-Za-z0-9]{1,3}"
                maxLength={6}
              />
            </div>
            <div className="field">
              <label htmlFor="horizon">Planungshorizont in Tagen (1–120)</label>
              <input
                id="horizon"
                name="generationHorizonDays"
                inputMode="numeric"
                defaultValue={recurring.generationHorizonDays}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="lead">Vorlauf Terminerinnerung in Stunden (1–168)</label>
              <input
                id="lead"
                name="reminderLeadHours"
                inputMode="numeric"
                defaultValue={recurring.reminderLeadHours}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="change-reason">Begründung der Änderung</label>
              <input
                id="change-reason"
                name="changeReason"
                required
                minLength={3}
                maxLength={500}
              />
            </div>
            <button className="button" type="submit">
              Einstellungen speichern
            </button>
          </form>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="coverage-title">
        <h2 id="coverage-title">Freigegebene Jahre</h2>
        {coverage.length === 0 ? (
          <p className="muted">Noch keine freigegebenen Feiertagsdaten.</p>
        ) : (
          <table className="table">
            <caption className="visually-hidden">Freigegebene Feiertagsjahre</caption>
            <thead>
              <tr>
                <th scope="col">Jahr</th>
                <th scope="col">Feiertage</th>
                <th scope="col">Quelle</th>
                <th scope="col">Freigegeben</th>
              </tr>
            </thead>
            <tbody>
              {coverage.map((c) => (
                <tr key={c.year}>
                  <td>{c.year}</td>
                  <td>{c.holidays}</td>
                  <td>{c.sourceReference}</td>
                  <td>{formatDateTime(c.approvedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canManage && recurring.holidayRegion !== null ? (
          <form
            action={recordHolidayYearAction}
            className="form"
            aria-label="Feiertagsjahr erfassen"
          >
            <div className="field">
              <label htmlFor="holiday-year">Jahr</label>
              <input id="holiday-year" name="year" inputMode="numeric" required maxLength={4} />
            </div>
            <div className="field">
              <label htmlFor="holiday-source">Quelle (amtliche Veröffentlichung, Fundstelle)</label>
              <input
                id="holiday-source"
                name="sourceReference"
                required
                minLength={5}
                maxLength={500}
              />
            </div>
            <div className="field">
              <label htmlFor="holiday-lines">Feiertage – je Zeile „JJJJ-MM-TT;Name“</label>
              <textarea id="holiday-lines" name="holidays" rows={10} maxLength={9000} />
            </div>
            <button className="button" type="submit">
              Jahr geprüft freigeben
            </button>
            <p className="hint">
              Mit der Freigabe bestätigen Sie, dass die Daten vollständig der genannten Quelle
              entsprechen. Ein Jahr kann nur einmal erfasst werden (protokolliert).
            </p>
          </form>
        ) : null}
      </section>
    </>
  );
}
