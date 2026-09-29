import { hasGlobalPermission } from "@isela/auth";
import { listEmployees } from "@isela/operations";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import { ListPagination } from "@/components/admin/list-pagination";
import { firstParam, type SearchParams } from "@/lib/admin/list-params";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";
import { createEmployeeAction } from "./actions";

export const metadata: Metadata = { title: "Mitarbeitende" };

export default async function EmployeeListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "employee:read")) forbidden();
  const query = await searchParams;
  const pageParam = Number(firstParam(query["page"]) ?? "1");
  const page = await listEmployees(await getServiceContext(), {
    page: Number.isInteger(pageParam) && pageParam > 0 && pageParam <= 10_000 ? pageParam : 1,
  });
  const canManage = hasGlobalPermission(actor, "employee:manage");

  return (
    <>
      <h1>Mitarbeitende</h1>
      <ActionResult query={query} />
      <p className="hint">
        Es werden nur einsatzrelevante Daten gespeichert (Qualifikationen, Gebiete, Arbeitszeiten,
        Abwesenheiten ohne Gründe). Keine Gesundheitsdaten.
      </p>
      {page.items.length === 0 ? (
        <p className="muted">Noch keine Mitarbeitenden erfasst.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">Qualifikationen</th>
                <th scope="col">Gebiete</th>
                <th scope="col">Arbeitszeiten</th>
                <th scope="col">Konto</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((employee) => (
                <tr key={employee.id}>
                  <td>
                    <Link href={`/admin/employees/${employee.id}`}>{employee.displayName}</Link>
                  </td>
                  <td>{employee.active ? "aktiv" : "inaktiv"}</td>
                  <td>{employee.qualifications.join(", ") || "–"}</td>
                  <td>{employee.serviceAreas}</td>
                  <td>{employee.workingWindows}</td>
                  <td>{employee.hasAccount ? "verknüpft" : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ListPagination
        basePath="/admin/employees"
        filters={{}}
        page={page.page}
        total={page.total}
        pageSize={page.pageSize}
      />
      {canManage ? (
        <section className="panel" aria-labelledby="new-employee">
          <h2 id="new-employee">Mitarbeitende/n anlegen</h2>
          <form action={createEmployeeAction} className="form">
            <div className="field">
              <label htmlFor="employee-name">Anzeigename</label>
              <input id="employee-name" name="displayName" required maxLength={200} />
            </div>
            <div className="field">
              <label htmlFor="employee-qualifications">
                Qualifikationen (Schlüssel, kommagetrennt)
              </label>
              <input id="employee-qualifications" name="qualifications" maxLength={500} />
            </div>
            <div className="field">
              <label htmlFor="employee-capacity">Max. Einsätze pro Tag (optional)</label>
              <input
                id="employee-capacity"
                name="maxJobsPerDay"
                inputMode="numeric"
                maxLength={2}
              />
            </div>
            <button className="button" type="submit">
              Anlegen
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}
