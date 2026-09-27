import { isAuthorized } from "@isela/auth";
import { getLeadOverview } from "@isela/crm";
import Link from "next/link";
import {
  AVAILABILITY_LABELS,
  CUSTOMER_TYPE_LABELS,
  LEAD_STATUS_LABELS,
  label,
} from "@/lib/admin/labels";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";

export default async function AdminDashboardPage() {
  const actor = await requireAdminArea();
  if (!isAuthorized(actor, "lead:read")) {
    return (
      <>
        <h1>Dashboard</h1>
        <p className="muted">Für Ihre Rolle sind hier noch keine Übersichten verfügbar.</p>
      </>
    );
  }
  const overview = await getLeadOverview(await getServiceContext());
  const total = overview.byStatus.reduce((sum, row) => sum + row.count, 0);
  return (
    <>
      <h1>Dashboard</h1>
      <h2>Leads nach Status</h2>
      {total === 0 ? (
        <p className="muted">Noch keine Leads vorhanden.</p>
      ) : (
        <ul>
          {overview.byStatus.map((row) => (
            <li key={row.status}>
              <Link href={`/admin/leads?status=${row.status}`}>
                {label(LEAD_STATUS_LABELS, row.status)}
              </Link>
              : {row.count}
            </li>
          ))}
        </ul>
      )}
      <h2>Neueste Anfragen</h2>
      {overview.latestRequests.length === 0 ? (
        <p className="muted">Noch keine Anfragen über die Website.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Eingang</th>
              <th scope="col">Leistung</th>
              <th scope="col">Kundenart</th>
              <th scope="col">Ort</th>
              <th scope="col">Servicegebiet</th>
            </tr>
          </thead>
          <tbody>
            {overview.latestRequests.map((request) => (
              <tr key={request.id}>
                <td>{request.createdAt.toLocaleString("de-DE")}</td>
                <td>{request.serviceName}</td>
                <td>{label(CUSTOMER_TYPE_LABELS, request.customerType)}</td>
                <td>{request.city}</td>
                <td>{label(AVAILABILITY_LABELS, request.serviceAreaStatus)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
