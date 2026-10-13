import { randomUUID } from "node:crypto";
import { hasGlobalPermission } from "@isela/auth";
import {
  MANUAL_PROVIDER,
  PAYABLE_INVOICE_STATUSES,
  PAYMENT_METHODS,
  getInvoice,
  missingBillingConfig,
} from "@isela/billing";
import { businessDateOf } from "@isela/payment-risk";
import { isDomainError } from "@isela/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { forbidden, notFound } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import { formatDate, formatDateTime, formatMoney, formatTaxRate } from "@/lib/admin/format";
import {
  INVOICE_KIND_LABELS,
  INVOICE_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_RECORD_STATUS_LABELS,
  SERVICE_UNIT_LABELS,
  label,
} from "@/lib/admin/labels";
import { loadFinanceOptions } from "@/lib/server/finance";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";
import {
  abortRefundAction,
  cancelDraftAction,
  changeDueDateAction,
  chargebackAction,
  completeRefundAction,
  confirmPaymentAction,
  failPaymentAction,
  issueInvoiceAction,
  recordPaymentAction,
  releaseInvoiceAction,
  requestRefundAction,
  voidInvoiceAction,
} from "./actions";

export const metadata: Metadata = { title: "Rechnung" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ReasonForm({
  action,
  invoiceId,
  paymentId,
  id,
  fieldLabel,
  button,
  field = "reason",
}: {
  action: (form: FormData) => Promise<void>;
  invoiceId: string;
  paymentId?: string;
  id: string;
  fieldLabel: string;
  button: string;
  field?: string;
}) {
  return (
    <form action={action} className="form compact">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {paymentId === undefined ? null : <input type="hidden" name="paymentId" value={paymentId} />}
      <div className="field">
        <label htmlFor={id}>{fieldLabel}</label>
        <input id={id} name={field} required minLength={3} maxLength={500} />
      </div>
      <button className="button button--secondary" type="submit">
        {button}
      </button>
    </form>
  );
}

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "invoice:read")) forbidden();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await getServiceContext();
  let invoice;
  try {
    invoice = await getInvoice(ctx, { invoiceId: id });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  const options = await loadFinanceOptions(ctx.db, ctx.clock);
  const query = await searchParams;
  const canWrite = hasGlobalPermission(actor, "invoice:write");
  const canPay = hasGlobalPermission(actor, "payment:manage");
  const missing = missingBillingConfig(options.billing, invoice.kind);
  const payable = PAYABLE_INVOICE_STATUSES.includes(invoice.status);
  const today = businessDateOf(ctx.clock.now(), options.timeZone);
  const cur = invoice.currency;

  return (
    <>
      <p>
        <Link href="/admin/invoices">← Alle Rechnungen</Link> ·{" "}
        <Link href={`/admin/bookings/${invoice.bookingId}`}>Buchung</Link>
        {hasGlobalPermission(actor, "payment_risk:read") ? (
          <>
            {" "}
            · <Link href={`/admin/payment-risk/${invoice.customerId}`}>Zahlungsrisiko</Link>
          </>
        ) : null}
      </p>
      <h1>
        {invoice.invoiceNumber === null ? "Rechnungsentwurf" : `Rechnung ${invoice.invoiceNumber}`}{" "}
        <span className="badge">{label(INVOICE_STATUS_LABELS, invoice.status)}</span>
      </h1>
      <ActionResult query={query} />

      <div className="detail-grid">
        <section className="panel" aria-labelledby="invoice-facts">
          <h2 id="invoice-facts">Rechnungsdaten</h2>
          <dl className="facts">
            <dt>Art</dt>
            <dd>{label(INVOICE_KIND_LABELS, invoice.kind)}</dd>
            <dt>Kunde</dt>
            <dd>
              <Link href={`/admin/customers/${invoice.customerId}`}>{invoice.customerName}</Link>
            </dd>
            <dt>Objekt</dt>
            <dd>{invoice.propertyName}</dd>
            <dt>Rechnungsdatum</dt>
            <dd>{formatDate(invoice.issueDate)}</dd>
            <dt>Fällig am</dt>
            <dd>{formatDate(invoice.dueDate)}</dd>
            <dt>Zahlungsbedingung</dt>
            <dd>{invoice.paymentTerms === "VORKASSE" ? "Vorkasse" : "Rechnungskauf"}</dd>
            {invoice.voidReason === null ? null : (
              <>
                <dt>Stornogrund</dt>
                <dd>{invoice.voidReason}</dd>
              </>
            )}
          </dl>
        </section>

        <section className="panel" aria-labelledby="invoice-amounts">
          <h2 id="invoice-amounts">Beträge</h2>
          <dl className="facts">
            <dt>Netto</dt>
            <dd>{formatMoney(invoice.netCents, cur)}</dd>
            {invoice.taxByRate.map((rate) => (
              <Fragment key={rate.taxRateBasisPoints}>
                <dt>USt. {formatTaxRate(rate.taxRateBasisPoints)}</dt>
                <dd>{formatMoney(rate.taxCents, cur)}</dd>
              </Fragment>
            ))}
            <dt>Brutto</dt>
            <dd>
              <strong>{formatMoney(invoice.grossCents, cur)}</strong>
            </dd>
            <dt>Bezahlt</dt>
            <dd>{formatMoney(invoice.paidCents, cur)}</dd>
            <dt>Offen</dt>
            <dd>
              <strong>{formatMoney(invoice.outstandingCents, cur)}</strong>
            </dd>
          </dl>
        </section>
      </div>

      {canWrite ? (
        <section className="panel" aria-labelledby="invoice-actions">
          <h2 id="invoice-actions">Rechnungsablauf</h2>
          {invoice.status === "DRAFT" ? (
            <>
              {missing.length > 0 ? (
                <p className="alert" role="note">
                  CONFIG_REQUIRED – vor dem Ausstellen müssen die Rechnungseinstellungen freigegeben
                  werden: {missing.join(", ")}.
                </p>
              ) : null}
              <form action={issueInvoiceAction} className="form">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <button className="button" type="submit">
                  Rechnung ausstellen (Nummer vergeben)
                </button>
              </form>
              <ReasonForm
                action={cancelDraftAction}
                invoiceId={invoice.id}
                id="cancel-reason"
                fieldLabel="Grund für das Verwerfen"
                button="Entwurf verwerfen"
              />
            </>
          ) : null}
          {invoice.status === "ISSUED" ? (
            <form action={releaseInvoiceAction} className="form">
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <button className="button" type="submit">
                Rechnung freigeben (Zahlung erwartet)
              </button>
            </form>
          ) : null}
          {invoice.status === "ISSUED" || payable ? (
            <form action={changeDueDateAction} className="form">
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <div className="field">
                <label htmlFor="due-date">Neue Fälligkeit</label>
                <input
                  id="due-date"
                  name="dueDate"
                  type="date"
                  required
                  defaultValue={invoice.dueDate ?? ""}
                />
              </div>
              <div className="field">
                <label htmlFor="due-reason">Begründung (Pflicht, protokolliert)</label>
                <input id="due-reason" name="reason" required minLength={3} maxLength={1000} />
              </div>
              <button className="button button--secondary" type="submit">
                Fälligkeit ändern
              </button>
            </form>
          ) : null}
          {invoice.status !== "DRAFT" &&
          invoice.status !== "CANCELLED" &&
          invoice.status !== "VOID" ? (
            <ReasonForm
              action={voidInvoiceAction}
              invoiceId={invoice.id}
              id="void-reason"
              fieldLabel="Stornogrund"
              button="Rechnung stornieren"
            />
          ) : null}
          <p className="hint">
            Eine stornierte Rechnung behält ihre Nummer. Ein rechtlich erforderlicher
            Storno-/Gutschriftbeleg ist eine Owner-/Steuerberater-Entscheidung und wird hier nicht
            erzeugt.
          </p>
        </section>
      ) : null}

      <section className="panel" aria-labelledby="items-title">
        <h2 id="items-title">Positionen (unveränderlicher Stand)</h2>
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
              </tr>
            </thead>
            <tbody>
              {invoice.items.map((item) => (
                <tr key={item.position}>
                  <td>{item.position}</td>
                  <td>{item.description}</td>
                  <td>
                    {item.quantity.toLocaleString("de-DE")} {label(SERVICE_UNIT_LABELS, item.unit)}
                  </td>
                  <td>{formatMoney(item.unitPriceCents, cur)}</td>
                  <td>{formatTaxRate(item.taxRateBasisPoints)}</td>
                  <td>{formatMoney(item.netCents, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-labelledby="payments-title">
        <h2 id="payments-title">Zahlungen</h2>
        {invoice.payments.length === 0 ? (
          <p className="muted">Noch keine Zahlung erfasst.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Eingang</th>
                  <th scope="col">Art</th>
                  <th scope="col">Betrag</th>
                  <th scope="col">Zugeordnet</th>
                  <th scope="col">Referenz</th>
                  <th scope="col">Status</th>
                  {canPay ? <th scope="col">Aktion</th> : null}
                </tr>
              </thead>
              <tbody>
                {invoice.payments.map((payment) => {
                  const manual = payment.provider === MANUAL_PROVIDER;
                  return (
                    <tr key={payment.id}>
                      <td>{formatDate(payment.receivedAt)}</td>
                      <td>{label(PAYMENT_METHOD_LABELS, payment.method)}</td>
                      <td>{formatMoney(payment.amountCents, cur)}</td>
                      <td>
                        {formatMoney(payment.appliedCents, cur)}
                        {payment.excessCents > 0
                          ? ` (Überzahlung ${formatMoney(payment.excessCents, cur)} – Klärung erforderlich)`
                          : ""}
                      </td>
                      <td>{payment.references.join(", ") || "–"}</td>
                      <td>
                        {label(PAYMENT_RECORD_STATUS_LABELS, payment.status)}
                        {payment.statusReason === null ? null : (
                          <span className="muted"> – {payment.statusReason}</span>
                        )}
                      </td>
                      {canPay ? (
                        <td>
                          {manual &&
                          (payment.status === "PENDING" || payment.status === "AUTHORIZED") ? (
                            <>
                              <form action={confirmPaymentAction} className="inline-form">
                                <input type="hidden" name="invoiceId" value={invoice.id} />
                                <input type="hidden" name="paymentId" value={payment.id} />
                                <button className="button" type="submit">
                                  Zahlungseingang bestätigen
                                </button>
                              </form>
                              <ReasonForm
                                action={failPaymentAction}
                                invoiceId={invoice.id}
                                paymentId={payment.id}
                                id={`fail-${payment.id}`}
                                fieldLabel="Grund (fehlgeschlagen)"
                                button="Als fehlgeschlagen markieren"
                              />
                            </>
                          ) : null}
                          {manual && payment.status === "CONFIRMED" ? (
                            <>
                              {invoice.status === "VOID" ? (
                                <ReasonForm
                                  action={requestRefundAction}
                                  invoiceId={invoice.id}
                                  paymentId={payment.id}
                                  id={`refund-${payment.id}`}
                                  fieldLabel="Grund der Erstattung"
                                  button="Erstattung anstoßen"
                                />
                              ) : null}
                              <ReasonForm
                                action={chargebackAction}
                                invoiceId={invoice.id}
                                paymentId={payment.id}
                                id={`chargeback-${payment.id}`}
                                fieldLabel="Rückbuchung (Grund laut Bank)"
                                button="Rückbuchung erfassen"
                              />
                            </>
                          ) : null}
                          {manual && payment.status === "REFUND_PENDING" ? (
                            <>
                              <ReasonForm
                                action={completeRefundAction}
                                invoiceId={invoice.id}
                                paymentId={payment.id}
                                id={`refund-done-${payment.id}`}
                                fieldLabel="Referenz der Rücküberweisung"
                                button="Erstattung abschließen"
                                field="reference"
                              />
                              <ReasonForm
                                action={abortRefundAction}
                                invoiceId={invoice.id}
                                paymentId={payment.id}
                                id={`refund-abort-${payment.id}`}
                                fieldLabel="Grund für den Abbruch"
                                button="Erstattung abbrechen"
                              />
                            </>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {canPay && payable ? (
          <form action={recordPaymentAction} className="form" aria-label="Zahlungseingang erfassen">
            <h3>Zahlungseingang erfassen</h3>
            <input type="hidden" name="invoiceId" value={invoice.id} />
            {/* Server-generated per page view: a double submit never books twice. */}
            <input type="hidden" name="idempotencyKey" value={`manual:${randomUUID()}`} />
            <div className="field">
              <label htmlFor="payment-amount">Betrag in €</label>
              <input
                id="payment-amount"
                name="amount"
                inputMode="decimal"
                required
                maxLength={14}
              />
            </div>
            <div className="field">
              <label htmlFor="payment-method">Zahlungsart</label>
              <select id="payment-method" name="method" defaultValue="BANK_TRANSFER">
                {PAYMENT_METHODS.filter((m) => m !== "CARD").map((method) => (
                  <option key={method} value={method}>
                    {label(PAYMENT_METHOD_LABELS, method)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="payment-reference">
                Bank-/Transaktionsreferenz (eindeutig, keine Kartendaten)
              </label>
              <input
                id="payment-reference"
                name="reference"
                required
                minLength={3}
                maxLength={200}
              />
            </div>
            <div className="field">
              <label htmlFor="payment-date">Eingangsdatum</label>
              <input
                id="payment-date"
                name="receivedOn"
                type="date"
                required
                max={today}
                defaultValue={today}
              />
            </div>
            <button className="button" type="submit">
              Zahlung erfassen
            </button>
            <p className="hint">
              Teilzahlungen werden erfasst, die Rechnung bleibt „teilweise bezahlt“. Eine
              Überzahlung wird nicht verrechnet, sondern zur Klärung ausgewiesen.
            </p>
          </form>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="history-title">
        <h2 id="history-title">Verlauf</h2>
        <ul>
          {invoice.history.map((entry) => (
            <li key={`${entry.createdAt.toISOString()}-${entry.toStatus}`}>
              {formatDateTime(entry.createdAt)}:{" "}
              {entry.fromStatus === null
                ? ""
                : `${label(INVOICE_STATUS_LABELS, entry.fromStatus)} → `}
              {label(INVOICE_STATUS_LABELS, entry.toStatus)}
              {entry.actorName === null ? " (System)" : ` (${entry.actorName})`}
              {entry.reason === null ? null : ` – ${entry.reason}`}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
