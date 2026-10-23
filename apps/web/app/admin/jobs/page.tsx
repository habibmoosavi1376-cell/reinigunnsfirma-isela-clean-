import { hasGlobalPermission } from "@isela/auth";
import { JOB_STATUSES, jobListQuerySchema, listJobs } from "@isela/operations";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { ListPagination } from "@/components/admin/list-pagination";
import { FULFILLMENT_LABELS, JOB_STATUS_LABELS, label } from "@/lib/admin/labels";
import { parseListParams, type SearchParams } from "@/lib/admin/list-params";
import { formatInTimeZone } from "@/lib/admin/time";
import { requireAdminArea } from "@/lib/server/guards";
import { loadOperationsConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Einsätze" };

type JobQuery = ReturnType<typeof jobListQuerySchema.parse>;

export default async function JobListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "job:read")) forbidden();
  const { query, raw } = parseListParams<JobQuery>(
    await searchParams,
    ["status", "from"],
    jobListQuerySchema,
  );
  const ctx = await getServiceContext();
  const [page, config] = await Promise.all([
    listJobs(ctx, query ?? {}),
    loadOperationsConfig(ctx.db, ctx.clock),
  ]);
  const filters = query === null ? {} : raw;

  return (
    <>
      <h1>Einsätze</h1>
      <p className="hint">
        Ein Einsatz ist die konkrete Ausführung einer Buchung. Zuweisungen schlägt das System nur
        vor; die Disposition entscheidet, der Server prüft jede Zuweisung erneut.
      </p>
      {query === null ? (
        <p className="alert alert--error" role="alert">
          Die Filter waren ungültig und wurden zurückgesetzt.
        </p>
      ) : null}
      <form className="filters" method="get" aria-label="Einsätze filtern">
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">Alle</option>
            {JOB_STATUSES.map((status) => (
              <option key={status} value={status}>
                {label(JOB_STATUS_LABELS, status)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="from">Ab Datum</label>
          <input id="from" name="from" type="date" defaultValue={filters.from ?? ""} />
        </div>
        <div className="cta-row">
          <button className="button" type="submit">
            Filtern
          </button>
          <Link href="/admin/jobs">Zurücksetzen</Link>
        </div>
      </form>
      <p className="muted" aria-live="polite">
        {page.total === 0
          ? "Keine Einsätze gefunden."
          : `${String(page.total)} Einsatz/Einsätze gefunden.`}
      </p>
      {page.items.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <caption className="muted">Einsätze nach Beginn</caption>
            <thead>
              <tr>
                <th scope="col">Beginn</th>
                <th scope="col">Kunde / Objekt</th>
                <th scope="col">Status</th>
                <th scope="col">Zugewiesen an</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((job) => (
                <tr key={job.id}>
                  <td>
                    <Link href={`/admin/jobs/${job.id}`}>
                      {formatInTimeZone(job.scheduledStart, config.timeZone)}
                    </Link>
                  </td>
                  <td>
                    {job.customerName}
                    <br />
                    <span className="muted">{job.propertyName}</span>
                  </td>
                  <td>
                    <span className="badge">{label(JOB_STATUS_LABELS, job.status)}</span>
                  </td>
                  <td>
                    {job.assigneeName ?? "–"}
                    {job.fulfillmentType === null ? null : (
                      <span className="muted">
                        {" "}
                        ({label(FULFILLMENT_LABELS, job.fulfillmentType)})
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ListPagination
        basePath="/admin/jobs"
        filters={filters}
        page={page.page}
        total={page.total}
        pageSize={page.pageSize}
      />
    </>
  );
}
