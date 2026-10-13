import { hasGlobalPermission } from "@isela/auth";
import { PROPERTY_TYPES, propertySearchSchema, searchProperties } from "@isela/crm";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { FREQUENCY_LABELS, PROPERTY_TYPE_LABELS, label } from "@/lib/admin/labels";
import { listQueryString, parseListParams, type SearchParams } from "@/lib/admin/list-params";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Objekte" };

type PropertyQuery = ReturnType<typeof propertySearchSchema.parse>;

export default async function PropertyListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "property:read")) forbidden();
  const { query, raw } = parseListParams<PropertyQuery>(
    await searchParams,
    ["q", "propertyType", "active"],
    propertySearchSchema,
  );
  const page = await searchProperties(await getServiceContext(), query ?? {});
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const filters = query === null ? {} : raw;

  return (
    <>
      <h1>Objekte</h1>
      {query === null ? (
        <p className="alert alert--error" role="alert">
          Die Filter waren ungültig und wurden zurückgesetzt.
        </p>
      ) : null}
      <form className="filters" method="get" role="search" aria-label="Objekte filtern">
        <div className="field">
          <label htmlFor="q">Suche (Objekt, Kunde, Straße, PLZ, Ort)</label>
          <input id="q" name="q" type="search" maxLength={100} defaultValue={filters.q ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="propertyType">Objektart</label>
          <select id="propertyType" name="propertyType" defaultValue={filters.propertyType ?? ""}>
            <option value="">Alle</option>
            {PROPERTY_TYPES.map((type) => (
              <option key={type} value={type}>
                {label(PROPERTY_TYPE_LABELS, type)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="active">Status</label>
          <select id="active" name="active" defaultValue={filters.active ?? ""}>
            <option value="">Alle</option>
            <option value="true">Aktiv</option>
            <option value="false">Inaktiv</option>
          </select>
        </div>
        <div className="cta-row">
          <button className="button" type="submit">
            Filtern
          </button>
          <Link href="/admin/properties">Zurücksetzen</Link>
        </div>
      </form>

      <p className="muted" aria-live="polite">
        {page.total === 0 ? "Keine Objekte gefunden." : `${page.total} Objekt(e) gefunden.`}
      </p>
      {page.items.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <caption className="muted">Objekte, zuletzt angelegte zuerst</caption>
            <thead>
              <tr>
                <th scope="col">Objekt</th>
                <th scope="col">Art</th>
                <th scope="col">Kunde</th>
                <th scope="col">Ort</th>
                <th scope="col">Intervall</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((property) => (
                <tr key={property.id}>
                  <td>{property.name}</td>
                  <td>{label(PROPERTY_TYPE_LABELS, property.propertyType)}</td>
                  <td>
                    <Link href={`/admin/customers/${property.customerId}`}>
                      {property.customerName}
                    </Link>
                  </td>
                  <td>
                    {property.postalCode} {property.city}
                  </td>
                  <td>{label(FREQUENCY_LABELS, property.serviceFrequency)}</td>
                  <td>
                    <span className={property.active ? "badge badge--ok" : "badge badge--warn"}>
                      {property.active ? "Aktiv" : "Inaktiv"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <nav className="pagination" aria-label="Seiten">
        {page.page > 1 ? (
          <Link href={`/admin/properties?${listQueryString(filters, page.page - 1)}`}>
            ← Zurück
          </Link>
        ) : null}
        <span>
          Seite {page.page} von {pages}
        </span>
        {page.page < pages ? (
          <Link href={`/admin/properties?${listQueryString(filters, page.page + 1)}`}>
            Weiter →
          </Link>
        ) : null}
      </nav>
    </>
  );
}
