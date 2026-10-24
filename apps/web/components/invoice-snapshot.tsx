import type { CustomerInvoiceView } from "@isela/billing";
import { formatDate } from "@/lib/admin/format";

/**
 * Issuance snapshot of an invoice (frozen at issuance): service date, recipient and issuer.
 * Renders definition-list rows; nothing is shown for drafts or older invoices without it.
 */
export function InvoiceSnapshotRows({
  invoice,
}: {
  invoice: Pick<CustomerInvoiceView, "serviceDate" | "serviceDateBasis" | "recipient" | "issuer">;
}) {
  return (
    <>
      {invoice.serviceDate === null ? null : (
        <>
          <dt>
            {invoice.serviceDateBasis === "PERFORMED"
              ? "Leistungsdatum"
              : "Leistungsdatum (geplant)"}
          </dt>
          <dd>{formatDate(invoice.serviceDate)}</dd>
        </>
      )}
      {invoice.recipient === null ? null : (
        <>
          <dt>Rechnungsempfänger</dt>
          <dd>
            {invoice.recipient.companyName ?? invoice.recipient.name}
            {invoice.recipient.companyName === null ? null : `, ${invoice.recipient.name}`},{" "}
            {invoice.recipient.street} {invoice.recipient.houseNumber},{" "}
            {invoice.recipient.postalCode} {invoice.recipient.city}
          </dd>
        </>
      )}
      {invoice.issuer === null ? null : (
        <>
          <dt>Rechnungssteller</dt>
          <dd>
            {invoice.issuer.legalName}, {invoice.issuer.street}, {invoice.issuer.postalCode}{" "}
            {invoice.issuer.city}
            {invoice.issuer.vatId === null ? null : ` · USt-IdNr. ${invoice.issuer.vatId}`}
            {invoice.issuer.taxNumber === null
              ? null
              : ` · Steuernummer ${invoice.issuer.taxNumber}`}
          </dd>
        </>
      )}
    </>
  );
}
