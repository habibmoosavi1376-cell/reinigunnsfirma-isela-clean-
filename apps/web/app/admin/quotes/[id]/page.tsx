import { hasGlobalPermission } from "@isela/auth";
import { listProperties } from "@isela/crm";
import {
  QUOTE_TRANSITIONS,
  SERVICE_UNITS,
  getQuote,
  listQuoteServiceOptions,
  permissionForQuoteTransition,
} from "@isela/quotes";
import { isDomainError } from "@isela/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { crmErrorText, crmNoticeText } from "@/lib/admin/crm-actions";
import { formatDate, formatDateTime, formatMoney, formatTaxRate } from "@/lib/admin/format";
import {
  QUOTE_STATUS_LABELS,
  QUOTE_TRANSITION_LABELS,
  SERVICE_UNIT_LABELS,
  label,
} from "@/lib/admin/labels";
import { requireAdminArea } from "@/lib/server/guards";
import { loadQuoteConfig } from "@/lib/server/quote-config";
import { getServiceContext } from "@/lib/server/session";
import {
  addQuoteItemAction,
  removeQuoteItemAction,
  transitionQuoteAction,
  updateQuoteDetailsAction,
} from "./actions";

export const metadata: Metadata = { title: "Angebot" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_REQUIRED = new Set(["ACCEPTED", "DECLINED", "CANCELLED"]);

export default async function QuoteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "quote:read")) forbidden();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await getServiceContext();
  let quote;
  try {
    quote = await getQuote(ctx, { quoteId: id });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  const query = await searchParams;
  const notice = crmNoticeText(query["notice"]);
  const error = crmErrorText(query["error"]);
  const canWrite = hasGlobalPermission(actor, "quote:write");
  const editable = canWrite && quote.status === "DRAFT";
  const [config, options, properties] = await Promise.all([
    loadQuoteConfig(ctx.db, ctx.clock),
    editable ? listQuoteServiceOptions(ctx) : null,
    editable ? listProperties(ctx, { customerId: quote.customerId }) : null,
  ]);
  const transitions = QUOTE_TRANSITIONS[quote.status].filter(
    (to) => to !== "EXPIRED" && hasGlobalPermission(actor, permissionForQuoteTransition(to)),
  );

  return (
    <>
      <p>
        <Link href="/admin/quotes">← Alle Angebote</Link> ·{" "}
        <Link href={`/admin/customers/${quote.customerId}`}>Kunde {quote.customerName}</Link>
      </p>
      <h1>
        Angebot {quote.id.slice(0, 8)}{" "}
        <span className="badge">{label(QUOTE_STATUS_LABELS, quote.status)}</span>
      </h1>
      {notice === null ? null : (
        <p className="alert alert--success" role="status">
          {notice}
        </p>
      )}
      {error === null ? null : (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}

      <div className="detail-grid">
        <section className="panel" aria-labelledby="summary-title">
          <h2 id="summary-title">Übersicht</h2>
          <dl className="facts">
            <dt>Kunde</dt>
            <dd>{quote.customerName}</dd>
            <dt>Objekt</dt>
            <dd>{quote.propertyName ?? "–"}</dd>
            <dt>Netto</dt>
            <dd>{formatMoney(quote.netCents, quote.currency)}</dd>
            {quote.taxByRate.map((rate) => (
              <div key={rate.taxRateBasisPoints}>
                <dt>USt. {formatTaxRate(rate.taxRateBasisPoints)}</dt>
                <dd>
                  {formatMoney(rate.taxCents, quote.currency)}{" "}
                  <span className="muted">auf {formatMoney(rate.netCents, quote.currency)}</span>
                </dd>
              </div>
            ))}
            <dt>Brutto</dt>
            <dd>
              <strong>{formatMoney(quote.grossCents, quote.currency)}</strong>
            </dd>
            <dt>Gültig bis</dt>
            <dd>
              {quote.validUntil === null
                ? `bei Freigabe: ${String(config.validityDays)} Tage`
                : formatDate(quote.validUntil)}
            </dd>
            <dt>Freigegeben</dt>
            <dd>{formatDateTime(quote.sentAt)}</dd>
            <dt>Entschieden</dt>
            <dd>{formatDateTime(quote.decidedAt)}</dd>
            <dt>Erstellt von</dt>
            <dd>{quote.internal?.createdByName ?? "–"}</dd>
          </dl>
          {quote.internal?.notes == null ? null : (
            <p>
              <strong>Interne Notiz:</strong> {quote.internal.notes}
            </p>
          )}
        </section>

        <section className="panel" aria-labelledby="status-title">
          <h2 id="status-title">Status</h2>
          {transitions.length === 0 ? (
            <p className="muted">
              {quote.status === "DRAFT" ||
              quote.status === "PENDING_REVIEW" ||
              quote.status === "SENT"
                ? "Für Ihre Rolle sind keine Statusänderungen möglich."
                : "Das Angebot ist abgeschlossen."}
            </p>
          ) : (
            transitions.map((to) => (
              <form key={to} action={transitionQuoteAction} className="form">
                <input type="hidden" name="quoteId" value={quote.id} />
                <input type="hidden" name="to" value={to} />
                {REASON_REQUIRED.has(to) ? (
                  <div className="field">
                    <label htmlFor={`reason-${to}`}>Begründung/Nachweis (Pflicht)</label>
                    <input id={`reason-${to}`} name="reason" required maxLength={1000} />
                  </div>
                ) : null}
                <button
                  className={to === "CANCELLED" ? "button button--secondary" : "button"}
                  type="submit"
                >
                  {label(QUOTE_TRANSITION_LABELS, to)}
                </button>
              </form>
            ))
          )}
          <p className="hint">
            Freigabe nur durch berechtigte Rollen. Ein freigegebenes Angebot ist im Kundenbereich
            sichtbar; ein E-Mail-Versand ist noch nicht angebunden.
          </p>
        </section>
      </div>

      <section className="panel" aria-labelledby="items-title">
        <h2 id="items-title">Positionen</h2>
        {quote.items.length === 0 ? (
          <p className="muted">Noch keine Positionen.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Pos.</th>
                  <th scope="col">Leistung</th>
                  <th scope="col">Menge</th>
                  <th scope="col">Einzelpreis</th>
                  <th scope="col">USt.</th>
                  <th scope="col">Netto</th>
                  {editable ? <th scope="col">Aktion</th> : null}
                </tr>
              </thead>
              <tbody>
                {quote.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.position}</td>
                    <td>
                      {item.description}
                      <br />
                      <span className="muted">{item.serviceCategoryName}</span>
                    </td>
                    <td>
                      {item.quantity.toLocaleString("de-DE")}{" "}
                      {label(SERVICE_UNIT_LABELS, item.unit)}
                    </td>
                    <td>{formatMoney(item.unitPriceCents, quote.currency)}</td>
                    <td>{formatTaxRate(item.taxRateBasisPoints)}</td>
                    <td>{formatMoney(item.netCents, quote.currency)}</td>
                    {editable ? (
                      <td>
                        <form action={removeQuoteItemAction} className="inline-form">
                          <input type="hidden" name="quoteId" value={quote.id} />
                          <input type="hidden" name="itemId" value={item.id} />
                          <button className="button button--secondary" type="submit">
                            Entfernen
                          </button>
                        </form>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {editable && options !== null ? (
          options.categories.length === 0 ? (
            <p className="hint">Keine aktiven Leistungen im Katalog.</p>
          ) : (
            <details open={quote.items.length === 0}>
              <summary>Position hinzufügen</summary>
              <form action={addQuoteItemAction} className="form">
                <input type="hidden" name="quoteId" value={quote.id} />
                <div className="field">
                  <label htmlFor="item-category">Leistungsbereich</label>
                  <select id="item-category" name="serviceCategoryId" required>
                    {options.categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </div>
                {options.services.length === 0 ? null : (
                  <div className="field">
                    <label htmlFor="item-service">Katalogleistung (optional)</label>
                    <select id="item-service" name="serviceId" defaultValue="">
                      <option value="">Keine</option>
                      {options.services.map((service) => (
                        <option key={service.id} value={service.id}>
                          {service.name} ({label(SERVICE_UNIT_LABELS, service.unit)})
                        </option>
                      ))}
                    </select>
                    <p className="hint">Muss zum Leistungsbereich und zur Einheit passen.</p>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="item-description">Beschreibung</label>
                  <input id="item-description" name="description" required maxLength={500} />
                </div>
                <div className="field">
                  <label htmlFor="item-quantity">Menge</label>
                  <input
                    id="item-quantity"
                    name="quantity"
                    required
                    inputMode="decimal"
                    maxLength={12}
                    aria-describedby="item-quantity-hint"
                  />
                  <p className="hint" id="item-quantity-hint">
                    Bis zu drei Nachkommastellen, z. B. 2,5
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="item-unit">Einheit</label>
                  <select id="item-unit" name="unit" required defaultValue="HOUR">
                    {SERVICE_UNITS.map((unit) => (
                      <option key={unit} value={unit}>
                        {label(SERVICE_UNIT_LABELS, unit)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="item-price">Einzelpreis netto in €</label>
                  <input
                    id="item-price"
                    name="unitPrice"
                    required
                    inputMode="decimal"
                    maxLength={14}
                    aria-describedby="item-price-hint"
                  />
                  <p className="hint" id="item-price-hint">
                    Manuell erfasster Preis, z. B. 32,90. Summen berechnet der Server.
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="item-tax">Umsatzsteuer</label>
                  <select
                    id="item-tax"
                    name="taxRateBasisPoints"
                    defaultValue={String(config.defaultVatRateBasisPoints)}
                  >
                    {config.vatRatesBasisPoints.map((rate) => (
                      <option key={rate} value={String(rate)}>
                        {formatTaxRate(rate)}
                      </option>
                    ))}
                  </select>
                </div>
                <button className="button" type="submit">
                  Position hinzufügen
                </button>
              </form>
            </details>
          )
        ) : null}
      </section>

      {editable && properties !== null ? (
        <section className="panel" aria-labelledby="details-title">
          <h2 id="details-title">Angebotsdaten</h2>
          <form action={updateQuoteDetailsAction} className="form">
            <input type="hidden" name="quoteId" value={quote.id} />
            <div className="field">
              <label htmlFor="quote-property">Objekt</label>
              <select id="quote-property" name="propertyId" defaultValue={quote.propertyId ?? ""}>
                <option value="">Ohne Objekt</option>
                {properties.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                    {property.active ? "" : " (inaktiv)"}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="quote-valid">Gültig bis (optional)</label>
              <input
                id="quote-valid"
                name="validUntil"
                type="date"
                defaultValue={quote.validUntil ?? ""}
              />
            </div>
            <div className="field">
              <label htmlFor="quote-notes">Interne Notiz</label>
              <textarea
                id="quote-notes"
                name="notes"
                rows={3}
                maxLength={4000}
                defaultValue={quote.internal?.notes ?? ""}
              />
            </div>
            <button className="button" type="submit">
              Speichern
            </button>
          </form>
        </section>
      ) : null}

      {quote.internal === null || quote.internal.history.length === 0 ? null : (
        <section className="panel" aria-labelledby="history-title">
          <h2 id="history-title">Statusverlauf</h2>
          <ul>
            {quote.internal.history.map((entry) => (
              <li key={`${entry.createdAt.toISOString()}-${entry.toStatus}`}>
                {formatDateTime(entry.createdAt)}: {label(QUOTE_STATUS_LABELS, entry.fromStatus)} →{" "}
                {label(QUOTE_STATUS_LABELS, entry.toStatus)}
                {entry.actorName === null ? " (System)" : ` (${entry.actorName})`}
                {entry.reason === null ? null : ` – ${entry.reason}`}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
