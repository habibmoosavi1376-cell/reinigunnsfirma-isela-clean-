import { listQuotes } from "@isela/quotes";
import Link from "next/link";
import { formatDate, formatMoney } from "@/lib/admin/format";
import { QUOTE_STATUS_LABELS, label } from "@/lib/admin/labels";
import { requireCustomerArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";

export default async function CustomerQuotesPage() {
  await requireCustomerArea();
  // The domain service restricts the list to the customer's own, released quotes.
  const page = await listQuotes(await getServiceContext(), { pageSize: 50 });
  return (
    <>
      <h1>Angebote</h1>
      {page.items.length === 0 ? (
        <p className="muted">Für Sie liegen derzeit keine freigegebenen Angebote vor.</p>
      ) : (
        <table className="table">
          <caption className="muted">Ihre Angebote</caption>
          <thead>
            <tr>
              <th scope="col">Angebot</th>
              <th scope="col">Objekt</th>
              <th scope="col">Status</th>
              <th scope="col">Betrag (brutto)</th>
              <th scope="col">Gültig bis</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((quote) => (
              <tr key={quote.id}>
                <td>
                  <Link href={`/customer/quotes/${quote.id}`}>
                    Angebot vom {formatDate(quote.createdAt)}
                  </Link>
                </td>
                <td>{quote.propertyName ?? "–"}</td>
                <td>{label(QUOTE_STATUS_LABELS, quote.status)}</td>
                <td>{formatMoney(quote.grossCents, quote.currency)}</td>
                <td>{formatDate(quote.validUntil)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">
        Zur Annahme eines Angebots wenden Sie sich bitte direkt an uns. Eine Online-Annahme ist noch
        nicht verfügbar.
      </p>
    </>
  );
}
