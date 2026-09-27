import { hasGlobalPermission } from "@isela/auth";
import { listServiceAreaOptions } from "@isela/catalog";
import {
  CUSTOMER_KINDS,
  CUSTOMER_STATUSES,
  customerListQuerySchema,
  listCustomers,
  type CustomerListQuery,
} from "@isela/crm";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { formatDateTime } from "@/lib/admin/format";
import { CUSTOMER_STATUS_LABELS, CUSTOMER_TYPE_LABELS, label } from "@/lib/admin/labels";
import { listQueryString, parseListParams, type SearchParams } from "@/lib/admin/list-params";
import { requireAdminArea } from "@/lib/server/guards";
import { getServices } from "@/lib/server/services";
import { getServiceContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Kunden" };

const FILTER_KEYS = ["q", "kind", "status", "serviceAreaId", "createdFrom", "createdTo"] as const;

export default async function CustomerListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "customer:read")) forbidden();
  const ctx = await getServiceContext();
  const { query, raw } = parseListParams<CustomerListQuery>(
    await searchParams,
    FILTER_KEYS,
    customerListQuerySchema,
  );
  const effective: CustomerListQuery = query ?? { page: 1, pageSize: 25 };
  const [page, areas] = await Promise.all([
    listCustomers(ctx, effective, getServices().crmConfig),
    listServiceAreaOptions(ctx),
  ]);
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const filters = query === null ? {} : raw;

  return (
    <>
      <h1>Kunden</h1>
      {query === null ? (
        <p className="alert alert--error" role="alert">
          Die Filter waren ungültig und wurden zurückgesetzt.
        </p>
      ) : null}

      <form className="filters" method="get" role="search" aria-label="Kunden filtern">
        <div className="field">
          <label htmlFor="q">Suche (Name, Firma, PLZ/Ort, exakte E-Mail, Kunden-ID)</label>
          <input id="q" name="q" type="search" maxLength={100} defaultValue={filters.q ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="kind">Kundenart</label>
          <select id="kind" name="kind" defaultValue={filters.kind ?? ""}>
            <option value="">Alle</option>
            {CUSTOMER_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {label(CUSTOMER_TYPE_LABELS, kind)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">Alle</option>
            {CUSTOMER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {label(CUSTOMER_STATUS_LABELS, status)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="serviceAreaId">Servicegebiet</label>
          <select
            id="serviceAreaId"
            name="serviceAreaId"
            defaultValue={filters.serviceAreaId ?? ""}
          >
            <option value="">Alle</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
                {area.active ? "" : " (inaktiv)"}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="createdFrom">Angelegt von</label>
          <input
            id="createdFrom"
            name="createdFrom"
            type="date"
            defaultValue={filters.createdFrom ?? ""}
          />
        </div>
        <div className="field">
          <label htmlFor="createdTo">Angelegt bis</label>
          <input
            id="createdTo"
            name="createdTo"
            type="date"
            defaultValue={filters.createdTo ?? ""}
          />
        </div>
        <div className="cta-row">
          <button className="button" type="submit">
            Filtern
          </button>
          <Link href="/admin/customers">Zurücksetzen</Link>
        </div>
      </form>

      <p className="muted" aria-live="polite">
        {page.total === 0 ? "Keine Kunden gefunden." : `${page.total} Kunde(n) gefunden.`}
      </p>

      {page.items.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <caption className="muted">Kunden, zuletzt angelegte zuerst</caption>
            <thead>
              <tr>
                <th scope="col">Kunde</th>
                <th scope="col">Art</th>
                <th scope="col">Status</th>
                <th scope="col">Ort</th>
                <th scope="col">Leads</th>
                <th scope="col">Objekte</th>
                <th scope="col">Offene Vorgänge</th>
                <th scope="col">Letzte Aktivität</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((customer) => (
                <tr key={customer.id}>
                  <td>
                    <Link href={`/admin/customers/${customer.id}`}>{customer.displayName}</Link>
                    {customer.companyName !== null ? (
                      <>
                        <br />
                        <span className="muted">{customer.companyName}</span>
                      </>
                    ) : null}
                    {customer.duplicateReviewStatus === "PENDING" ? (
                      <>
                        <br />
                        <span className="badge badge--warn">Dublettenprüfung</span>
                      </>
                    ) : null}
                  </td>
                  <td>{label(CUSTOMER_TYPE_LABELS, customer.kind)}</td>
                  <td>
                    <span
                      className={
                        customer.status === "ACTIVE" ? "badge badge--ok" : "badge badge--warn"
                      }
                    >
                      {label(CUSTOMER_STATUS_LABELS, customer.status)}
                    </span>
                  </td>
                  <td>{customer.primaryLocation ?? "–"}</td>
                  <td>{customer.leadCount}</td>
                  <td>{customer.propertyCount}</td>
                  <td>
                    {customer.openLeadCount} Lead(s)
                    {customer.openQuoteCount === null ? null : (
                      <>
                        <br />
                        {customer.openQuoteCount} Angebot(e)
                      </>
                    )}
                  </td>
                  <td>{formatDateTime(customer.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <nav className="pagination" aria-label="Seiten">
        {page.page > 1 ? (
          <Link href={`/admin/customers?${listQueryString(filters, page.page - 1)}`}>← Zurück</Link>
        ) : null}
        <span>
          Seite {page.page} von {pages}
        </span>
        {page.page < pages ? (
          <Link href={`/admin/customers?${listQueryString(filters, page.page + 1)}`}>Weiter →</Link>
        ) : null}
      </nav>
    </>
  );
}
