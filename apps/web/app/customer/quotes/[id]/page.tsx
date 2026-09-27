import { getQuote } from "@isela/quotes";
import { isDomainError } from "@isela/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDate, formatMoney, formatTaxRate } from "@/lib/admin/format";
import { QUOTE_STATUS_LABELS, SERVICE_UNIT_LABELS, label } from "@/lib/admin/labels";
import { requireCustomerArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CustomerQuoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCustomerArea();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  let quote;
  try {
    // Foreign quotes, drafts and internal reviews are NOT_FOUND for customers.
    quote = await getQuote(await getServiceContext(), { quoteId: id });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  return (
    <>
      <p>
        <Link href="/customer/quotes">← Alle Angebote</Link>
      </p>
      <h1>Angebot vom {formatDate(quote.createdAt)}</h1>
      <p>
        Status: <strong>{label(QUOTE_STATUS_LABELS, quote.status)}</strong>
        {quote.validUntil === null ? null : ` · gültig bis ${formatDate(quote.validUntil)}`}
      </p>
      {quote.propertyName === null ? null : <p>Objekt: {quote.propertyName}</p>}
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Pos.</th>
            <th scope="col">Leistung</th>
            <th scope="col">Menge</th>
            <th scope="col">Einzelpreis (netto)</th>
            <th scope="col">Netto</th>
          </tr>
        </thead>
        <tbody>
          {quote.items.map((item) => (
            <tr key={item.id}>
              <td>{item.position}</td>
              <td>{item.description}</td>
              <td>
                {item.quantity.toLocaleString("de-DE")} {label(SERVICE_UNIT_LABELS, item.unit)}
              </td>
              <td>{formatMoney(item.unitPriceCents, quote.currency)}</td>
              <td>{formatMoney(item.netCents, quote.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="facts">
        <dt>Summe netto</dt>
        <dd>{formatMoney(quote.netCents, quote.currency)}</dd>
        {quote.taxByRate.map((rate) => (
          <div key={rate.taxRateBasisPoints}>
            <dt>USt. {formatTaxRate(rate.taxRateBasisPoints)}</dt>
            <dd>{formatMoney(rate.taxCents, quote.currency)}</dd>
          </div>
        ))}
        <dt>Summe brutto</dt>
        <dd>
          <strong>{formatMoney(quote.grossCents, quote.currency)}</strong>
        </dd>
      </dl>
    </>
  );
}
