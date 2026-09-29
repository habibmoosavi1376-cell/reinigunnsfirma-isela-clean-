import { hasGlobalPermission } from "@isela/auth";
import { listServiceAreaOptions } from "@isela/catalog";
import { getEmployee, listLinkableStaffAccounts } from "@isela/operations";
import { isDomainError } from "@isela/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import { UNAVAILABILITY_KIND_LABELS, WEEKDAY_LABELS, label } from "@/lib/admin/labels";
import { formatInTimeZone, formatMinuteOfDay } from "@/lib/admin/time";
import { requireAdminArea } from "@/lib/server/guards";
import { loadOperationsConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";
import {
  addUnavailabilityAction,
  addWorkingWindowAction,
  linkAccountAction,
  removeWorkingWindowAction,
  setServiceAreasAction,
  updateEmployeeAction,
} from "../actions";

export const metadata: Metadata = { title: "Mitarbeitende/r" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "employee:read")) forbidden();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await getServiceContext();
  let employee;
  try {
    employee = await getEmployee(ctx, { employeeId: id });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  const canManage = hasGlobalPermission(actor, "employee:manage");
  const [config, areas, accounts] = await Promise.all([
    loadOperationsConfig(ctx.db, ctx.clock),
    canManage ? listServiceAreaOptions(ctx) : [],
    canManage && employee.accountName === null ? listLinkableStaffAccounts(ctx) : [],
  ]);
  const assignedAreas = new Set(employee.serviceAreas.map((a) => a.id));
  const query = await searchParams;

  return (
    <>
      <p>
        <Link href="/admin/employees">← Alle Mitarbeitenden</Link>
      </p>
      <h1>
        {employee.displayName}{" "}
        <span className="badge">{employee.active ? "aktiv" : "inaktiv"}</span>
      </h1>
      <ActionResult query={query} />

      <div className="detail-grid">
        <section className="panel" aria-labelledby="employee-master">
          <h2 id="employee-master">Stammdaten</h2>
          <dl className="facts">
            <dt>Qualifikationen</dt>
            <dd>{employee.qualifications.join(", ") || "–"}</dd>
            <dt>Max. Einsätze pro Tag</dt>
            <dd>{employee.maxJobsPerDay ?? "nicht begrenzt"}</dd>
            <dt>Startpunkt für Entfernung</dt>
            <dd>{employee.hasBaseLocation ? "hinterlegt" : "nicht hinterlegt"}</dd>
            <dt>Konto (STAFF)</dt>
            <dd>{employee.accountName ?? "nicht verknüpft"}</dd>
            <dt>Servicegebiete</dt>
            <dd>{employee.serviceAreas.map((a) => a.name).join(", ") || "keine"}</dd>
          </dl>
          {canManage ? (
            <form action={updateEmployeeAction} className="form">
              <input type="hidden" name="employeeId" value={employee.id} />
              <div className="field">
                <label htmlFor="employee-name">Anzeigename</label>
                <input
                  id="employee-name"
                  name="displayName"
                  defaultValue={employee.displayName}
                  required
                  maxLength={200}
                />
              </div>
              <div className="field">
                <label htmlFor="employee-qualifications">Qualifikationen (kommagetrennt)</label>
                <input
                  id="employee-qualifications"
                  name="qualifications"
                  defaultValue={employee.qualifications.join(", ")}
                  maxLength={500}
                />
              </div>
              <div className="field">
                <label htmlFor="employee-capacity">Max. Einsätze pro Tag</label>
                <input
                  id="employee-capacity"
                  name="maxJobsPerDay"
                  inputMode="numeric"
                  maxLength={2}
                  defaultValue={employee.maxJobsPerDay ?? ""}
                />
              </div>
              <div className="field">
                <label htmlFor="employee-active">Status</label>
                <select id="employee-active" name="active" defaultValue={String(employee.active)}>
                  <option value="true">aktiv</option>
                  <option value="false">inaktiv</option>
                </select>
              </div>
              <button className="button" type="submit">
                Speichern
              </button>
            </form>
          ) : null}
        </section>

        <section className="panel" aria-labelledby="employee-areas">
          <h2 id="employee-areas">Servicegebiete</h2>
          {canManage ? (
            <form action={setServiceAreasAction} className="form">
              <input type="hidden" name="employeeId" value={employee.id} />
              {areas.length === 0 ? <p className="muted">Keine Servicegebiete angelegt.</p> : null}
              {areas.map((area) => (
                <label key={area.id} className="checkbox">
                  <input
                    type="checkbox"
                    name="serviceAreaIds"
                    value={area.id}
                    defaultChecked={assignedAreas.has(area.id)}
                  />{" "}
                  {area.name}
                  {area.active ? "" : " (inaktiv)"}
                </label>
              ))}
              <button className="button" type="submit">
                Gebiete speichern
              </button>
            </form>
          ) : (
            <p>{employee.serviceAreas.map((a) => a.name).join(", ") || "keine"}</p>
          )}
          {canManage && employee.accountName === null ? (
            <form action={linkAccountAction} className="form">
              <input type="hidden" name="employeeId" value={employee.id} />
              <div className="field">
                <label htmlFor="employee-account">STAFF-Konto verknüpfen</label>
                <select id="employee-account" name="userId" required>
                  {accounts.map((account) => (
                    <option key={account.userId} value={account.userId}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
              <button className="button" type="submit" disabled={accounts.length === 0}>
                Verknüpfen
              </button>
            </form>
          ) : null}
        </section>
      </div>

      <section className="panel" aria-labelledby="employee-windows">
        <h2 id="employee-windows">Arbeitszeiten ({config.timeZone})</h2>
        <ul>
          {employee.workingWindows.map((window) => (
            <li key={window.id}>
              {label(WEEKDAY_LABELS, String(window.weekday))}{" "}
              {formatMinuteOfDay(window.startMinute)}–{formatMinuteOfDay(window.endMinute)}
              {canManage ? (
                <form action={removeWorkingWindowAction} className="inline-form">
                  <input type="hidden" name="employeeId" value={employee.id} />
                  <input type="hidden" name="windowId" value={window.id} />
                  <button className="button button--secondary" type="submit">
                    Entfernen
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {canManage ? (
          <form action={addWorkingWindowAction} className="form">
            <input type="hidden" name="employeeId" value={employee.id} />
            <div className="field">
              <label htmlFor="window-weekday">Wochentag</label>
              <select id="window-weekday" name="weekday">
                {Object.entries(WEEKDAY_LABELS).map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="window-from">Von</label>
              <input id="window-from" name="from" type="time" required />
            </div>
            <div className="field">
              <label htmlFor="window-to">Bis</label>
              <input id="window-to" name="to" type="time" required />
            </div>
            <button className="button" type="submit">
              Arbeitszeit hinzufügen
            </button>
          </form>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="employee-absence">
        <h2 id="employee-absence">Abwesenheiten</h2>
        <ul>
          {employee.unavailability.map((entry) => (
            <li key={entry.id}>
              {label(UNAVAILABILITY_KIND_LABELS, entry.kind)}:{" "}
              {formatInTimeZone(entry.startsAt, config.timeZone)} –{" "}
              {formatInTimeZone(entry.endsAt, config.timeZone)}
            </li>
          ))}
        </ul>
        {canManage ? (
          <form action={addUnavailabilityAction} className="form">
            <input type="hidden" name="employeeId" value={employee.id} />
            <div className="field">
              <label htmlFor="absence-kind">Art (ohne Grund, keine Gesundheitsdaten)</label>
              <select id="absence-kind" name="kind">
                {Object.entries(UNAVAILABILITY_KIND_LABELS).map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="absence-from-date">Von (Datum)</label>
              <input id="absence-from-date" name="fromDate" type="date" required />
            </div>
            <div className="field">
              <label htmlFor="absence-from-time">Von (Uhrzeit)</label>
              <input
                id="absence-from-time"
                name="fromTime"
                type="time"
                required
                defaultValue="00:00"
              />
            </div>
            <div className="field">
              <label htmlFor="absence-to-date">Bis (Datum)</label>
              <input id="absence-to-date" name="toDate" type="date" required />
            </div>
            <div className="field">
              <label htmlFor="absence-to-time">Bis (Uhrzeit)</label>
              <input id="absence-to-time" name="toTime" type="time" required defaultValue="23:59" />
            </div>
            <button className="button" type="submit">
              Abwesenheit erfassen
            </button>
          </form>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="employee-jobs">
        <h2 id="employee-jobs">Anstehende Einsätze</h2>
        {employee.upcomingAssignments.length === 0 ? (
          <p className="muted">Keine.</p>
        ) : (
          <ul>
            {employee.upcomingAssignments.map((assignment) => (
              <li key={assignment.jobId}>
                <Link href={`/admin/jobs/${assignment.jobId}`}>
                  {formatInTimeZone(assignment.startsAt, config.timeZone)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
