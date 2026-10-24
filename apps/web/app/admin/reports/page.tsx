import { hasGlobalPermission } from "@isela/auth";
import { MAX_REPORT_DAYS, getConversionReport, type ConversionMetricKey } from "@isela/reporting";
import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { parseReportRange } from "@/lib/admin/report-range";
import { loadOperationsConfig } from "@/lib/server/operations-config";
import { requireAdminArea } from "@/lib/server/guards";
import { getServices } from "@/lib/server/services";
import { getServiceContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Berichte" };

const METRIC_LABELS: Record<ConversionMetricKey, { label: string; definition: string }> = {
  pageVisits: {
    label: "Seitenbesuche",
    definition: "Benötigt einen freigegebenen Analyse-Dienst.",
  },
  requestsStarted: {
    label: "Gestartete Anfragen",
    definition: "Benötigt einen freigegebenen Analyse-Dienst.",
  },
  requestsSubmitted: {
    label: "Abgesendete Anfragen",
    definition: "Gespeicherte Website-Anfragen (Doppelübermittlungen zählen einmal).",
  },
  callbacksRequested: { label: "Rückrufwünsche", definition: "Gespeicherte Rückrufwünsche." },
  qualifiedLeads: {
    label: "Qualifizierte Leads",
    definition: "Website-Leads, die im Zeitraum als qualifiziert markiert wurden.",
  },
  quotesSent: {
    label: "Versendete Angebote",
    definition: "Angebote mit Versanddatum im Zeitraum.",
  },
  quotesAccepted: {
    label: "Angenommene Angebote",
    definition: "Angebote, deren Annahme im Zeitraum erfasst wurde.",
  },
  bookingsCreated: { label: "Buchungen", definition: "Im Zeitraum angelegte Buchungen." },
  paidBookings: {
    label: "Bezahlte Aufträge",
    definition: "Buchungen mit vollständig bezahlter Rechnung (Zahlungseingang im Zeitraum).",
  },
  repeatCustomers: {
    label: "Wiederholungskunden",
    definition: "Kunden mit einer Buchung im Zeitraum und mindestens einer früheren Buchung.",
  },
};

const RATIO_LABELS: Record<string, string> = {
  requestToQualified: "Qualifizierte Leads je abgesendeter Anfrage",
  quoteAcceptance: "Angenommene je versendetem Angebot",
};

function percent(value: number | null): string {
  return value === null
    ? "nicht berechenbar"
    : `${(value * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`;
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "report:read")) forbidden();
  const { clock, env } = getServices();
  const ctx = await getServiceContext();
  const { timeZone } = await loadOperationsConfig(ctx.db, clock);
  const range = parseReportRange(await searchParams, clock.now(), 30, MAX_REPORT_DAYS, timeZone);
  const report = await getConversionReport(
    ctx,
    { from: range.from, to: range.to },
    { environment: env.APP_ENVIRONMENT },
  );

  return (
    <>
      <h1>Conversion-Bericht</h1>
      {report.realData ? null : (
        <p className="alert alert--error" role="note">
          Testdaten: Diese Installation ist als „{report.environment}“ gekennzeichnet. Die Zahlen
          stammen aus Test- bzw. Demodaten und sind keine Geschäftszahlen.
        </p>
      )}
      {range.valid ? null : (
        <p className="alert alert--error" role="alert">
          Der Zeitraum war ungültig und wurde auf die letzten 30 Tage zurückgesetzt.
        </p>
      )}
      <form className="form form--inline" method="get">
        <div className="field">
          <label htmlFor="report-from">Von (UTC)</label>
          <input id="report-from" name="from" type="date" defaultValue={range.fromDay} />
        </div>
        <div className="field">
          <label htmlFor="report-to">Bis einschließlich (UTC)</label>
          <input id="report-to" name="to" type="date" defaultValue={range.lastDay} />
        </div>
        <button className="button button--secondary" type="submit">
          Anzeigen
        </button>
      </form>

      <div className="table-scroll">
        <table className="table">
          <caption>
            Kennzahlen vom {range.fromDay} bis {range.lastDay}
          </caption>
          <thead>
            <tr>
              <th scope="col">Kennzahl</th>
              <th scope="col">Wert</th>
              <th scope="col">Quelle / Definition</th>
            </tr>
          </thead>
          <tbody>
            {report.metrics.map((metric) => (
              <tr key={metric.key}>
                <th scope="row">{METRIC_LABELS[metric.key].label}</th>
                <td>
                  {metric.value === null ? (
                    <span className="muted">nicht gemessen</span>
                  ) : (
                    metric.value.toLocaleString("de-DE")
                  )}
                </td>
                <td>
                  {metric.source === "DATABASE" ? "Datenbank" : "Keine Datenquelle"} –{" "}
                  {METRIC_LABELS[metric.key].definition}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Verhältnisse im Zeitraum</h2>
      <ul>
        {report.ratios.map((ratio) => (
          <li key={ratio.key}>
            {RATIO_LABELS[ratio.key]}: <strong>{percent(ratio.value)}</strong>
          </li>
        ))}
      </ul>
      <p className="hint">
        Die Verhältnisse beziehen sich auf Ereignisse im selben Zeitraum, nicht auf eine Kohorte
        (ein im Zeitraum angenommenes Angebot kann vorher versendet worden sein). Werte ohne
        Datenquelle werden nie geschätzt.
      </p>
    </>
  );
}
