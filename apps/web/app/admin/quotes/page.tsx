import { hasGlobalPermission } from "@isela/auth";
import { QUOTE_STATUSES, listQuotes, quoteListQuerySchema } from "@isela/quotes";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { formatDate, formatMoney } from "@/lib/admin/format";
import { QUOTE_STATUS_LABELS, label } from "@/lib/admin/labels";
import { listQueryString, parseListParams, type SearchParams } from "@/lib/admin/list-params";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Angebote" };

type QuoteQuery = ReturnType<typeof quoteListQuerySchema.parse>;

export default async function QuoteListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "quote:read")) forbidden();
  const { query, raw } = parseListParams<QuoteQuery>(
    await searchParams,
    ["status", "customerId"],
    quoteListQuerySchema,
  );
  const page = await listQuotes(await getServiceContext(), query ?? {});
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const filters = query === null ? {} : raw;

  return (
    <>
      <h1>Angebote</h1>
      <p className="hint">
        Neue Angebote werden in der Kundenakte angelegt. Preise werden von berechtigten
        Mitarbeitenden erfasst und serverseitig berechnet; es gibt keine automatische Preiszusage.
      </p>
      {query === null ? (
        <p className="alert alert--error" role="alert">
          Die Filter waren ungültig und wurden zurückgesetzt.
        </p>
      ) : null}
      <form className="filters" method="get" aria-label="Angebote filtern">
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">Alle</option>
            {QUOTE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {label(QUOTE_STATUS_LABELS, status)}
              </option>
            ))}
          </select>
        </div>
        <div className="cta-row">
          <button className="button" type="submit">
            Filtern
          </button>
          <Link href="/admin/quotes">Zurücksetzen</Link>
        </div>
      </form>
      <p className="muted" aria-live="polite">
        {page.total === 0 ? "Keine Angebote gefunden." : `${page.total} Angebot(e) gefunden.`}
      </p>
      {page.items.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <caption className="muted">Angebote, neueste zuerst</caption>
            <thead>
              <tr>
                <th scope="col">Angebot</th>
                <th scope="col">Kunde</th>
                <th scope="col">Objekt</th>
                <th scope="col">Status</th>
                <th scope="col">Brutto</th>
                <th scope="col">Gültig bis</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((quote) => (
                <tr key={quote.id}>
                  <td>
                    <Link href={`/admin/quotes/${quote.id}`}>
                      {quote.id.slice(0, 8)} · {formatDate(quote.createdAt)}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/admin/customers/${quote.customerId}`}>{quote.customerName}</Link>
                  </td>
                  <td>{quote.propertyName ?? "–"}</td>
                  <td>
                    <span className="badge">{label(QUOTE_STATUS_LABELS, quote.status)}</span>
                  </td>
                  <td>{formatMoney(quote.grossCents, quote.currency)}</td>
                  <td>{formatDate(quote.validUntil)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <nav className="pagination" aria-label="Seiten">
        {page.page > 1 ? (
          <Link href={`/admin/quotes?${listQueryString(filters, page.page - 1)}`}>← Zurück</Link>
        ) : null}
        <span>
          Seite {page.page} von {pages}
        </span>
        {page.page < pages ? (
          <Link href={`/admin/quotes?${listQueryString(filters, page.page + 1)}`}>Weiter →</Link>
        ) : null}
      </nav>
    </>
  );
}
