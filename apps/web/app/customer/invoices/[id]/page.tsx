import { getCustomerInvoice } from "@isela/billing";
import { isDomainError } from "@isela/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { formatDate, formatMoney, formatTaxRate } from "@/lib/admin/format";
import {
  INVOICE_KIND_LABELS,
  INVOICE_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_RECORD_STATUS_LABELS,
  SERVICE_UNIT_LABELS,
  label,
} from "@/lib/admin/labels";
import { requireCustomerArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Customer invoice view: only the customer-facing projection (amounts, dates, status, own
 * payments and their references) – no internal costs, margins, risk data, staff or partner
 * data. Foreign or unreleased invoices are NOT_FOUND (HTTP 404).
 */
export default async function CustomerInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  await requireCustomerArea();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await getServiceContext();
  let invoice;
  try {
    invoice = await getCustomerInvoice(ctx, { invoiceId: id });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  const cur = invoice.currency;
  return (
    <>
      <p>
        <Link href="/customer/invoices">← Alle Rechnungen</Link>
      </p>
      <h1>Rechnung {invoice.invoiceNumber}</h1>
      <dl className="facts">
        <dt>Status</dt>
        <dd>{label(INVOICE_STATUS_LABELS, invoice.status)}</dd>
        <dt>Art</dt>
        <dd>{label(INVOICE_KIND_LABELS, invoice.kind)}</dd>
        <dt>Objekt</dt>
        <dd>{invoice.propertyName}</dd>
        <dt>Rechnungsdatum</dt>
        <dd>{formatDate(invoice.issueDate)}</dd>
        <dt>Fällig am</dt>
        <dd>{formatDate(invoice.dueDate)}</dd>
      </dl>
      <div className="table-scroll">
        <table className="table">
          <caption className="muted">Positionen</caption>
          <thead>
            <tr>
              <th scope="col">Pos.</th>
              <th scope="col">Leistung</th>
              <th scope="col">Menge</th>
              <th scope="col">Einzelpreis (netto)</th>
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
      <dl className="facts">
        <dt>Netto</dt>
        <dd>{formatMoney(invoice.netCents, cur)}</dd>
        {invoice.taxByRate.map((rate) => (
          <Fragment key={rate.taxRateBasisPoints}>
            <dt>USt. {formatTaxRate(rate.taxRateBasisPoints)}</dt>
            <dd>{formatMoney(rate.taxCents, cur)}</dd>
          </Fragment>
        ))}
        <dt>Gesamt (brutto)</dt>
        <dd>
          <strong>{formatMoney(invoice.grossCents, cur)}</strong>
        </dd>
        <dt>Bezahlt</dt>
        <dd>{formatMoney(invoice.paidCents, cur)}</dd>
        <dt>Offener Betrag</dt>
        <dd>
          <strong>{formatMoney(invoice.outstandingCents, cur)}</strong>
        </dd>
      </dl>
      <h2>Zahlungen</h2>
      {invoice.payments.length === 0 ? (
        <p className="muted">Noch kein Zahlungseingang verbucht.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Eingang</th>
              <th scope="col">Zahlungsart</th>
              <th scope="col">Betrag</th>
              <th scope="col">Referenz</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {invoice.payments.map((payment) => (
              <tr key={payment.id}>
                <td>{formatDate(payment.receivedAt)}</td>
                <td>{label(PAYMENT_METHOD_LABELS, payment.method)}</td>
                <td>{formatMoney(payment.amountCents, cur)}</td>
                <td>{payment.references.join(", ") || "–"}</td>
                <td>{label(PAYMENT_RECORD_STATUS_LABELS, payment.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">
        Verwendungszweck für Überweisungen: <strong>{invoice.invoiceNumber}</strong>
      </p>
    </>
  );
}
