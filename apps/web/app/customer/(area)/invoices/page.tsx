import { listCustomerInvoices } from "@isela/billing";
import Link from "next/link";
import { formatDate, formatMoney } from "@/lib/admin/format";
import { INVOICE_KIND_LABELS, INVOICE_STATUS_LABELS, label } from "@/lib/admin/labels";
import { requireCustomerArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";

export default async function CustomerRechnungenPage() {
  await requireCustomerArea();
  const ctx = await getServiceContext();
  // The billing service restricts the list to the customer's own released invoices (OWN scope).
  const page = await listCustomerInvoices(ctx, {});
  return (
    <>
      <h1>Rechnungen</h1>
      {page.items.length === 0 ? (
        <p className="muted">Es liegen keine Rechnungen vor.</p>
      ) : (
        <table className="table">
          <caption className="muted">Ihre Rechnungen</caption>
          <thead>
            <tr>
              <th scope="col">Rechnungsnummer</th>
              <th scope="col">Art</th>
              <th scope="col">Rechnungsdatum</th>
              <th scope="col">Fällig am</th>
              <th scope="col">Status</th>
              <th scope="col">Betrag (brutto)</th>
              <th scope="col">Offen</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((invoice) => (
              <tr key={invoice.id}>
                <td>
                  <Link href={`/customer/invoices/${invoice.id}`}>{invoice.invoiceNumber}</Link>
                </td>
                <td>{label(INVOICE_KIND_LABELS, invoice.kind)}</td>
                <td>{formatDate(invoice.issueDate)}</td>
                <td>{formatDate(invoice.dueDate)}</td>
                <td>{label(INVOICE_STATUS_LABELS, invoice.status)}</td>
                <td>{formatMoney(invoice.grossCents, invoice.currency)}</td>
                <td>
                  {invoice.status === "VOID"
                    ? "–"
                    : formatMoney(invoice.grossCents - invoice.paidCents, invoice.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">
        Bitte geben Sie bei Überweisungen die Rechnungsnummer als Verwendungszweck an. Eine
        Online-Zahlung ist noch nicht verfügbar.
      </p>
    </>
  );
}
