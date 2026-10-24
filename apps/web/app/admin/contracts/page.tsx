import { hasGlobalPermission } from "@isela/auth";
import { contractListQuerySchema, listServiceContracts } from "@isela/operations";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { ListPagination } from "@/components/admin/list-pagination";
import { formatDate } from "@/lib/admin/format";
import { CONTRACT_STATUS_LABELS, RECURRENCE_FREQUENCY_LABELS, label } from "@/lib/admin/labels";
import { parseListParams, type SearchParams } from "@/lib/admin/list-params";
import { requireAdminArea } from "@/lib/server/guards";
import { loadOperationsConfig, loadRecurringConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Wiederkehrende Aufträge" };

type ContractQuery = ReturnType<typeof contractListQuerySchema.parse>;

export default async function ContractListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "booking:read")) forbidden();
  const { query, raw } = parseListParams<ContractQuery>(
    await searchParams,
    ["status"],
    contractListQuerySchema,
  );
  const ctx = await getServiceContext();
  const config = await loadOperationsConfig(ctx.db, ctx.clock);
  const recurring = await loadRecurringConfig(ctx.db, ctx.clock);
  const page = await listServiceContracts(ctx, query ?? {}, { timeZone: config.timeZone });
  const filters = query === null ? {} : raw;

  return (
    <>
      <h1>Wiederkehrende Aufträge</h1>
      <p className="hint">
        Verträge entstehen aus angenommenen Angeboten (Angebotsdetail → „Wiederkehrenden Auftrag
        anlegen“). Jeder Termin wird eine eigene Buchung mit der zentralen Zahlungslogik.
      </p>
      {recurring.holidayRegion === null ? (
        <p className="alert alert--error" role="alert">
          Es ist keine Feiertagsregion konfiguriert – Termine werden nicht automatisch erzeugt.{" "}
          {hasGlobalPermission(actor, "settings:manage") ? (
            <Link href="/admin/contracts/holidays">Feiertagsdaten verwalten</Link>
          ) : (
            "Bitte eine berechtigte Person informieren."
          )}
        </p>
      ) : (
        <p>
          Feiertagsregion: <strong>{recurring.holidayRegion}</strong> ·{" "}
          <Link href="/admin/contracts/holidays">Feiertagsdaten</Link>
        </p>
      )}
      {query === null ? (
        <p className="alert alert--error" role="alert">
          Die Filter waren ungültig und wurden zurückgesetzt.
        </p>
      ) : null}
      <form className="filters" method="get" aria-label="Verträge filtern">
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">Alle</option>
            {Object.entries(CONTRACT_STATUS_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </div>
        <button className="button" type="submit">
          Filtern
        </button>
      </form>
      {page.items.length === 0 ? (
        <p className="muted">Keine Verträge gefunden.</p>
      ) : (
        <table className="table">
          <caption className="visually-hidden">Wiederkehrende Aufträge</caption>
          <thead>
            <tr>
              <th scope="col">Kunde</th>
              <th scope="col">Intervall</th>
              <th scope="col">Laufzeit</th>
              <th scope="col">Status</th>
              <th scope="col">Nächster gebuchter Termin</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/admin/contracts/${c.id}`}>{c.customerName}</Link>
                </td>
                <td>{label(RECURRENCE_FREQUENCY_LABELS, c.frequency)}</td>
                <td>
                  ab {formatDate(c.startDate)}
                  {c.endDate === null ? " (unbefristet)" : ` bis ${formatDate(c.endDate)}`}
                </td>
                <td>
                  <span className="badge">{label(CONTRACT_STATUS_LABELS, c.status)}</span>
                </td>
                <td>{c.nextBookedDate === null ? "–" : formatDate(c.nextBookedDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ListPagination
        basePath="/admin/contracts"
        filters={filters}
        page={page.page}
        total={page.total}
        pageSize={page.pageSize}
      />
    </>
  );
}
