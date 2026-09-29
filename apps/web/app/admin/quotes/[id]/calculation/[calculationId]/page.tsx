import { hasGlobalPermission } from "@isela/auth";
import { getPricingCalculation } from "@isela/quotes";
import { isDomainError } from "@isela/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { crmNoticeText } from "@/lib/admin/crm-actions";
import { formatMoney, formatTaxRate } from "@/lib/admin/format";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";
import { addItemFromCalculationAction } from "../../actions";

export const metadata: Metadata = { title: "Preisberechnung" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Readable component names; engine keys are shown as they are for extras/adjustments. */
const COMPONENT_LABELS: Record<string, string> = {
  BASE_PRICE: "Grundpreis",
  PER_UNIT: "Menge",
  PER_SQM: "Fläche (m²)",
  PER_ROOM: "Räume",
  PER_BATHROOM: "Bäder",
  PER_WINDOW: "Fenster",
  ADJUSTMENTS: "Häufigkeit/Dringlichkeit/Zuschläge/Rabatte",
  DISTANCE: "Anfahrt",
  MINIMUM_PRICE: "Anhebung auf Mindestpreis",
};

export default async function CalculationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; calculationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "quote:read")) forbidden();
  const { id, calculationId } = await params;
  if (!UUID.test(id) || !UUID.test(calculationId)) notFound();
  let calc;
  try {
    calc = await getPricingCalculation(await getServiceContext(), { quoteId: id, calculationId });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  const notice = crmNoticeText((await searchParams)["notice"]);
  const canAdopt =
    hasGlobalPermission(actor, "quote:write") && calc.status === "CALCULATED" && !calc.used;
  const canOverride = hasGlobalPermission(actor, "pricing:override");

  return (
    <>
      <p>
        <Link href={`/admin/quotes/${id}`}>← Zurück zum Angebot</Link>
      </p>
      <h1>Preisberechnung · {calc.serviceName}</h1>
      {notice === null ? null : (
        <p className="alert alert--success" role="status">
          {notice}
        </p>
      )}
      {calc.status === "CONFIG_REQUIRED" ? (
        <section className="panel" aria-labelledby="missing-title">
          <h2 id="missing-title">CONFIG_REQUIRED – kein Preis</h2>
          <p>
            Für diese Berechnung fehlen freigegebene Werte. Es wird kein Preis vorgeschlagen und
            kein Betrag übernommen.
          </p>
          <ul>
            {calc.missing.map((key) => (
              <li key={key}>
                <code>{key}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="panel" aria-labelledby="result-title">
          <h2 id="result-title">Ergebnis (Vorschlag, Version {calc.pricingVersion})</h2>
          <table className="table">
            <tbody>
              {calc.components.map((component) => (
                <tr key={component.key}>
                  <th scope="row">{COMPONENT_LABELS[component.key] ?? component.key}</th>
                  <td>{formatMoney(component.amountCents, calc.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="facts">
            <dt>Netto</dt>
            <dd>{formatMoney(calc.netCents ?? 0, calc.currency)}</dd>
            <dt>USt. {formatTaxRate(calc.taxRateBasisPoints ?? 0)}</dt>
            <dd>{formatMoney(calc.taxCents ?? 0, calc.currency)}</dd>
            <dt>Brutto</dt>
            <dd>
              <strong>{formatMoney(calc.grossCents ?? 0, calc.currency)}</strong>
            </dd>
          </dl>
          {calc.notes.length === 0 ? null : (
            <p className="hint">Hinweise: {calc.notes.join(", ")}</p>
          )}
          {calc.internal === null ? null : (
            <>
              <h3>Intern (nur Finanz-/Leitungsrollen)</h3>
              <dl className="facts">
                <dt>Geschätzte Arbeitszeit</dt>
                <dd>
                  {calc.internal.estimatedLaborMinutes === null
                    ? "nicht ermittelbar"
                    : `${String(calc.internal.estimatedLaborMinutes)} min`}
                </dd>
                <dt>Direkte Kosten</dt>
                <dd>{formatMoney(calc.internal.directCostsCents ?? 0, calc.currency)}</dd>
                <dt>Interne Kosten</dt>
                <dd>
                  {calc.internal.internalCostCents === null
                    ? "CONFIG_REQUIRED"
                    : formatMoney(calc.internal.internalCostCents, calc.currency)}
                </dd>
                <dt>Deckungsbeitrag</dt>
                <dd>
                  {calc.internal.contributionMarginCents === null
                    ? "–"
                    : formatMoney(calc.internal.contributionMarginCents, calc.currency)}
                </dd>
              </dl>
            </>
          )}
          {calc.used ? <p className="muted">Diese Berechnung wurde bereits übernommen.</p> : null}
          {canAdopt ? (
            <form action={addItemFromCalculationAction} className="form">
              <input type="hidden" name="quoteId" value={id} />
              <input type="hidden" name="calculationId" value={calc.id} />
              {canOverride ? (
                <>
                  <div className="field">
                    <label htmlFor="override-net">Abweichender Nettopreis in € (optional)</label>
                    <input
                      id="override-net"
                      name="overrideNet"
                      inputMode="decimal"
                      maxLength={14}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="override-reason">Begründung der Übersteuerung</label>
                    <input id="override-reason" name="overrideReason" maxLength={1000} />
                  </div>
                </>
              ) : null}
              <button className="button" type="submit">
                Als Position übernehmen
              </button>
            </form>
          ) : null}
        </section>
      )}
    </>
  );
}
