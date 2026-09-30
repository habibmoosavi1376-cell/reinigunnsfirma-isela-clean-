import { isAuthorized } from "@isela/auth";
import { listPublicServiceCategories, listServiceAreaOptions } from "@isela/catalog";
import { LEAD_STATUSES, listLeadSourceOptions, listLeads } from "@isela/crm";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import {
  AVAILABILITY_LABELS,
  CUSTOMER_TYPE_LABELS,
  LEAD_STATUS_LABELS,
  label,
} from "@/lib/admin/labels";
import { leadQueryFromSearchParams, leadQueryString } from "@/lib/admin/lead-filters";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Leads" };

export default async function LeadListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!isAuthorized(actor, "lead:read")) forbidden();
  const ctx = await getServiceContext();
  const { query, invalid } = leadQueryFromSearchParams(await searchParams);
  const [page, categories, areas, sources] = await Promise.all([
    listLeads(ctx, query),
    listPublicServiceCategories(ctx.db),
    listServiceAreaOptions(ctx),
    listLeadSourceOptions(ctx),
  ]);
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const selectedStatus = query.status?.[0] ?? "";

  return (
    <>
      <h1>Leads</h1>
      {invalid ? (
        <p className="alert alert--error" role="alert">
          Die Filter waren ungültig und wurden zurückgesetzt.
        </p>
      ) : null}

      <form className="filters" method="get" role="search" aria-label="Leads filtern">
        <div className="field">
          <label htmlFor="q">Suche (Name, Firma, E-Mail, Lead-ID)</label>
          <input id="q" name="q" type="search" maxLength={100} defaultValue={query.q ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={selectedStatus}>
            <option value="">Alle</option>
            {LEAD_STATUSES.map((status) => (
              <option key={status} value={status}>
                {label(LEAD_STATUS_LABELS, status)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="customerType">Kundenart</label>
          <select id="customerType" name="customerType" defaultValue={query.customerType ?? ""}>
            <option value="">Alle</option>
            {Object.entries(CUSTOMER_TYPE_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="serviceCategoryKey">Leistung</label>
          <select
            id="serviceCategoryKey"
            name="serviceCategoryKey"
            defaultValue={query.serviceCategoryKey ?? ""}
          >
            <option value="">Alle</option>
            {categories.map((category) => (
              <option key={category.key} value={category.key}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="serviceAreaId">Servicegebiet</label>
          <select id="serviceAreaId" name="serviceAreaId" defaultValue={query.serviceAreaId ?? ""}>
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
          <label htmlFor="availability">Verfügbarkeit</label>
          <select id="availability" name="availability" defaultValue={query.availability ?? ""}>
            <option value="">Alle</option>
            {Object.entries(AVAILABILITY_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sourceKey">Quelle</label>
          <select id="sourceKey" name="sourceKey" defaultValue={query.sourceKey ?? ""}>
            <option value="">Alle</option>
            {sources.map((source) => (
              <option key={source.key} value={source.key}>
                {source.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="createdFrom">Eingang von</label>
          <input
            id="createdFrom"
            name="createdFrom"
            type="date"
            defaultValue={query.createdFrom ?? ""}
          />
        </div>
        <div className="field">
          <label htmlFor="createdTo">Eingang bis</label>
          <input id="createdTo" name="createdTo" type="date" defaultValue={query.createdTo ?? ""} />
        </div>
        <div className="cta-row">
          <button className="button" type="submit">
            Filtern
          </button>
          <Link href="/admin/leads">Zurücksetzen</Link>
        </div>
      </form>

      <p className="muted" aria-live="polite">
        {page.total === 0 ? "Keine Leads gefunden." : `${page.total} Lead(s) gefunden.`}
      </p>

      {page.items.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <caption className="muted">Leads, neueste zuerst</caption>
            <thead>
              <tr>
                <th scope="col">Lead</th>
                <th scope="col">Status</th>
                <th scope="col">Quelle</th>
                <th scope="col">Kundenart</th>
                <th scope="col">Kontakt</th>
                <th scope="col">Ort</th>
                <th scope="col">Leistung</th>
                <th scope="col">Gebiet</th>
                <th scope="col">Score</th>
                <th scope="col">Eingang</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((lead) => (
                <tr key={lead.id}>
                  <td>
                    <Link href={`/admin/leads/${lead.id}`}>{lead.id.slice(0, 8)}</Link>
                  </td>
                  <td>
                    <span className="badge">{label(LEAD_STATUS_LABELS, lead.status)}</span>
                  </td>
                  <td>{lead.sourceName}</td>
                  <td>{label(CUSTOMER_TYPE_LABELS, lead.customerType)}</td>
                  <td>
                    {lead.contactName ?? "–"}
                    {lead.customerType !== null && lead.customerType !== "PRIVATE" ? (
                      <>
                        <br />
                        <span className="muted">{lead.companyName}</span>
                      </>
                    ) : null}
                  </td>
                  <td>{[lead.postalCode, lead.city].filter(Boolean).join(" ") || "–"}</td>
                  <td>{lead.serviceName ?? "–"}</td>
                  <td>{label(AVAILABILITY_LABELS, lead.availability)}</td>
                  <td>{lead.score ?? "–"}</td>
                  <td>{lead.createdAt.toLocaleString("de-DE")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <nav className="pagination" aria-label="Seiten">
        {page.page > 1 ? (
          <Link href={`/admin/leads?${leadQueryString(query, page.page - 1)}`}>← Zurück</Link>
        ) : null}
        <span>
          Seite {page.page} von {pages}
        </span>
        {page.page < pages ? (
          <Link href={`/admin/leads?${leadQueryString(query, page.page + 1)}`}>Weiter →</Link>
        ) : null}
      </nav>
    </>
  );
}
