import { hasGlobalPermission } from "@isela/auth";
import { getServiceContract, previewContractOccurrences } from "@isela/operations";
import { isDomainError } from "@isela/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import { formatDate } from "@/lib/admin/format";
import {
  CONTRACT_STATUS_LABELS,
  OCCURRENCE_SKIP_REASON_LABELS,
  OCCURRENCE_STATUS_LABELS,
  RECURRENCE_FREQUENCY_LABELS,
  label,
} from "@/lib/admin/labels";
import { formatInTimeZone, formatMinuteOfDay } from "@/lib/admin/time";
import { requireAdminArea } from "@/lib/server/guards";
import { loadOperationsConfig, loadRecurringConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";
import {
  addPauseAction,
  endPauseAction,
  generateContractAction,
  updateContractStatusAction,
  updatePauseAction,
} from "./actions";

export const metadata: Metadata = { title: "Wiederkehrender Auftrag" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEXT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  ACTIVE: ["PAUSED", "ENDED"],
  PAUSED: ["ACTIVE", "ENDED"],
  ENDED: [],
};

export default async function ContractDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "booking:read")) forbidden();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await getServiceContext();
  let contract;
  try {
    contract = await getServiceContract(ctx, { contractId: id });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  const [config, recurring] = await Promise.all([
    loadOperationsConfig(ctx.db, ctx.clock),
    loadRecurringConfig(ctx.db, ctx.clock),
  ]);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone }).format(
    ctx.clock.now(),
  );
  const horizonEnd = new Date(Date.parse(`${today}T00:00:00Z`) + 55 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const preview = await previewContractOccurrences(
    ctx,
    { contractId: contract.id, from: today, to: horizonEnd },
    { timeZone: config.timeZone, holidayRegion: recurring.holidayRegion },
  );
  const query = await searchParams;
  const canWrite = hasGlobalPermission(actor, "booking:write");
  const transitions = canWrite ? (NEXT_TRANSITIONS[contract.status] ?? []) : [];
  const canGenerate =
    canWrite &&
    contract.status === "ACTIVE" &&
    recurring.holidayRegion !== null &&
    preview.holidayDataComplete;
  const booked = new Map(contract.occurrences.map((o) => [o.date, o]));

  return (
    <>
      <p>
        <Link href="/admin/contracts">← Wiederkehrende Aufträge</Link>
      </p>
      <h1>
        Wiederkehrender Auftrag – {contract.customerName}{" "}
        <span className="badge">{label(CONTRACT_STATUS_LABELS, contract.status)}</span>
      </h1>
      <ActionResult query={query} />

      <section className="panel" aria-labelledby="rule-title">
        <h2 id="rule-title">Regel</h2>
        <dl className="facts">
          <dt>Intervall</dt>
          <dd>{label(RECURRENCE_FREQUENCY_LABELS, contract.frequency)}</dd>
          <dt>Laufzeit</dt>
          <dd>
            ab {formatDate(contract.startDate)}
            {contract.endDate === null ? " (unbefristet)" : ` bis ${formatDate(contract.endDate)}`}
          </dd>
          <dt>Zeitfenster</dt>
          <dd>
            {formatMinuteOfDay(contract.windowStartMinute)}–
            {formatMinuteOfDay(contract.windowEndMinute)} Uhr, Dauer {contract.durationMinutes} Min.
          </dd>
          <dt>Angebot (Leistung und Preis)</dt>
          <dd>
            <Link href={`/admin/quotes/${contract.quoteId}`}>
              Angebot {contract.quoteId.slice(0, 8)}
            </Link>
          </dd>
        </dl>
        {transitions.length > 0 ? (
          <form action={updateContractStatusAction} className="form" aria-label="Status ändern">
            <input type="hidden" name="contractId" value={contract.id} />
            <input type="hidden" name="expectedVersion" value={contract.version} />
            <div className="field">
              <label htmlFor="contract-to">Neuer Status</label>
              <select id="contract-to" name="to" required>
                {transitions.map((t) => (
                  <option key={t} value={t}>
                    {label(CONTRACT_STATUS_LABELS, t)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="contract-reason">Begründung</label>
              <input id="contract-reason" name="reason" required minLength={3} maxLength={500} />
            </div>
            <button className="button" type="submit">
              Status ändern
            </button>
            <p className="hint">
              „Beendet“ ist endgültig. Bereits erzeugte Buchungen bleiben bestehen und werden
              einzeln geprüft.
            </p>
          </form>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="plan-title">
        <h2 id="plan-title">Nächste Termine (8 Wochen)</h2>
        {!preview.holidayDataComplete ? (
          <p className="alert alert--error" role="alert">
            Für {preview.missingYears.join(", ")} liegen keine freigegebenen Feiertagsdaten
            {recurring.holidayRegion === null ? " (keine Region konfiguriert)" : ""} vor. Feiertage
            sind in dieser Vorschau nicht berücksichtigt; Termine werden nicht erzeugt.
          </p>
        ) : null}
        {preview.occurrences.length === 0 ? (
          <p className="muted">Keine Termine im Zeitraum.</p>
        ) : (
          <table className="table">
            <caption className="visually-hidden">Geplante Termine</caption>
            <thead>
              <tr>
                <th scope="col">Datum</th>
                <th scope="col">Zeitfenster</th>
                <th scope="col">Stand</th>
              </tr>
            </thead>
            <tbody>
              {preview.occurrences.map((o) => {
                const existing = booked.get(o.date);
                return (
                  <tr key={o.date}>
                    <td>{formatDate(o.date)}</td>
                    <td>
                      {o.windowStart === null || o.windowEnd === null
                        ? "–"
                        : `${formatInTimeZone(o.windowStart, config.timeZone)} – ${formatInTimeZone(o.windowEnd, config.timeZone)}`}
                    </td>
                    <td>
                      {existing?.bookingId != null ? (
                        <Link href={`/admin/bookings/${existing.bookingId}`}>
                          {label(OCCURRENCE_STATUS_LABELS, existing.status)}
                        </Link>
                      ) : existing !== undefined ? (
                        `${label(OCCURRENCE_STATUS_LABELS, existing.status)} (${label(OCCURRENCE_SKIP_REASON_LABELS, existing.skipReason ?? "")})`
                      ) : o.skipReason !== null ? (
                        `Wird übersprungen: ${label(OCCURRENCE_SKIP_REASON_LABELS, o.skipReason)}`
                      ) : (
                        "Noch nicht erzeugt"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {canGenerate ? (
          <form action={generateContractAction} className="form">
            <input type="hidden" name="contractId" value={contract.id} />
            <button className="button" type="submit">
              Termine für {recurring.generationHorizonDays} Tage erzeugen
            </button>
            <p className="hint">
              Bereits vorhandene Termine werden nicht doppelt angelegt. Jede Buchung erhält die
              Zahlungsbedingung aus der zentralen Zahlungslogik.
            </p>
          </form>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="pause-title">
        <h2 id="pause-title">Pausen</h2>
        {contract.pauses.length === 0 ? <p className="muted">Keine Pausen.</p> : null}
        {contract.pauses.map((p) => (
          <div key={p.id} className="panel">
            <p>
              {formatDate(p.fromDate)} – {formatDate(p.toDate)}: {p.reason}
            </p>
            {canWrite && p.toDate >= today ? (
              <>
                <form action={updatePauseAction} className="form" aria-label="Pause ändern">
                  <input type="hidden" name="contractId" value={contract.id} />
                  <input type="hidden" name="pauseId" value={p.id} />
                  <div className="field">
                    <label htmlFor={`from-${p.id}`}>Von</label>
                    <input
                      id={`from-${p.id}`}
                      name="fromDate"
                      type="date"
                      defaultValue={p.fromDate}
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`to-${p.id}`}>Bis</label>
                    <input
                      id={`to-${p.id}`}
                      name="toDate"
                      type="date"
                      defaultValue={p.toDate}
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`reason-${p.id}`}>Grund</label>
                    <input
                      id={`reason-${p.id}`}
                      name="reason"
                      defaultValue={p.reason}
                      required
                      minLength={3}
                      maxLength={500}
                    />
                  </div>
                  <button className="button button--secondary" type="submit">
                    Pause ändern
                  </button>
                </form>
                <form action={endPauseAction} className="form" aria-label="Pause beenden">
                  <input type="hidden" name="contractId" value={contract.id} />
                  <input type="hidden" name="pauseId" value={p.id} />
                  <div className="field">
                    <label htmlFor={`last-${p.id}`}>Letzter Pausentag</label>
                    <input id={`last-${p.id}`} name="lastDay" type="date" required />
                  </div>
                  <button className="button button--secondary" type="submit">
                    Pause vorzeitig beenden
                  </button>
                </form>
              </>
            ) : null}
          </div>
        ))}
        {canWrite && contract.status !== "ENDED" ? (
          <form action={addPauseAction} className="form" aria-label="Pause erfassen">
            <input type="hidden" name="contractId" value={contract.id} />
            <div className="field">
              <label htmlFor="pause-from">Von</label>
              <input id="pause-from" name="fromDate" type="date" required />
            </div>
            <div className="field">
              <label htmlFor="pause-to">Bis</label>
              <input id="pause-to" name="toDate" type="date" required />
            </div>
            <div className="field">
              <label htmlFor="pause-reason">Grund</label>
              <input id="pause-reason" name="reason" required minLength={3} maxLength={500} />
            </div>
            <button className="button" type="submit">
              Pause erfassen
            </button>
            <p className="hint">
              Künftige Termine im Zeitraum werden übersprungen. Bereits erzeugte Buchungen werden
              nicht automatisch storniert – Sie erhalten einen Hinweis.
            </p>
          </form>
        ) : null}
      </section>
    </>
  );
}
