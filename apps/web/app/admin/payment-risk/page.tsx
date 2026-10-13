import { hasGlobalPermission } from "@isela/auth";
import { listRiskOverview, riskListQuerySchema } from "@isela/billing";
import { PAYMENT_TERMS_OUTCOMES } from "@isela/payment-risk";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import { ListPagination } from "@/components/admin/list-pagination";
import { formatDateTime } from "@/lib/admin/format";
import {
  CREDIT_TERMS_STATUS_LABELS,
  PAYMENT_OUTCOME_LABELS,
  PAYMENT_REASON_LABELS,
  label,
} from "@/lib/admin/labels";
import { parseListParams, type SearchParams } from "@/lib/admin/list-params";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";
import { runOverdueCheckAction } from "./actions";

export const metadata: Metadata = { title: "Zahlungsrisiko" };

type RiskQuery = ReturnType<typeof riskListQuerySchema.parse>;

export default async function PaymentRiskPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "payment_risk:read")) forbidden();
  const params = await searchParams;
  const { query, raw } = parseListParams<RiskQuery>(params, ["outcome"], riskListQuerySchema);
  const ctx = await getServiceContext();
  const page = await listRiskOverview(ctx, query ?? {});
  const filters = query === null ? {} : raw;
  const canRun = hasGlobalPermission(actor, "credit_terms:request");

  return (
    <>
      <h1>Zahlungsrisiko</h1>
      <ActionResult query={params} />
      <p className="hint">
        Zentrale Bewertung aus erfassten Aufträgen, Rechnungen, Zahlungen und Kreditentscheidungen.
        Neukunden sowie der 1. und 2. Auftrag laufen immer auf Vorkasse; Rechnungskauf erst nach
        mindestens drei abgeschlossenen und bezahlten Aufträgen und nur nach Freigabe durch eine
        zweite Person.
      </p>
      {canRun ? (
        <form action={runOverdueCheckAction} className="form">
          <button className="button button--secondary" type="submit">
            Fälligkeitslauf starten
          </button>
          <p className="hint">
            Markiert überfällige Rechnungen, bewertet betroffene Kunden neu und stellt deren noch
            nicht begonnene Termine auf Vorkasse um (mit Prüfvermerk). Neue Aufträge sind unabhängig
            davon sofort geschützt.
          </p>
        </form>
      ) : null}
      <form className="filters" method="get" aria-label="Bewertungen filtern">
        <div className="field">
          <label htmlFor="outcome">Ergebnis</label>
          <select id="outcome" name="outcome" defaultValue={filters.outcome ?? ""}>
            <option value="">Alle</option>
            {PAYMENT_TERMS_OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {label(PAYMENT_OUTCOME_LABELS, outcome)}
              </option>
            ))}
          </select>
        </div>
        <div className="cta-row">
          <button className="button" type="submit">
            Filtern
          </button>
          <Link href="/admin/payment-risk">Zurücksetzen</Link>
        </div>
      </form>
      <p className="muted" aria-live="polite">
        {page.total === 0
          ? "Noch keine Bewertungen erfasst."
          : `${String(page.total)} Kunde(n) mit Bewertung.`}
      </p>
      {page.items.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Kunde</th>
                <th scope="col">Ergebnis</th>
                <th scope="col">Gründe</th>
                <th scope="col">Rechnungskauf</th>
                <th scope="col">Zuletzt bewertet</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr key={item.customerId}>
                  <td>
                    <Link href={`/admin/payment-risk/${item.customerId}`}>{item.customerName}</Link>
                  </td>
                  <td>{label(PAYMENT_OUTCOME_LABELS, item.outcome)}</td>
                  <td>{item.reasons.map((r) => label(PAYMENT_REASON_LABELS, r)).join("; ")}</td>
                  <td>
                    {item.creditStatus === null
                      ? "–"
                      : label(CREDIT_TERMS_STATUS_LABELS, item.creditStatus)}
                  </td>
                  <td>{formatDateTime(item.evaluatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ListPagination
        basePath="/admin/payment-risk"
        filters={filters}
        page={page.page}
        total={page.total}
        pageSize={page.pageSize}
      />
    </>
  );
}
