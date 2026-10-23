import { hasGlobalPermission } from "@isela/auth";
import { listPartners } from "@isela/partners";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import { ListPagination } from "@/components/admin/list-pagination";
import { PARTNER_STATUS_LABELS, label } from "@/lib/admin/labels";
import { firstParam, type SearchParams } from "@/lib/admin/list-params";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";
import { createPartnerAction } from "./actions";

export const metadata: Metadata = { title: "Partner" };

export default async function PartnerListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "partner:read")) forbidden();
  const query = await searchParams;
  const pageParam = Number(firstParam(query["page"]) ?? "1");
  const page = await listPartners(await getServiceContext(), {
    page: Number.isInteger(pageParam) && pageParam > 0 && pageParam <= 10_000 ? pageParam : 1,
  });
  const canManage = hasGlobalPermission(actor, "partner:manage");

  return (
    <>
      <h1>Partner</h1>
      <ActionResult query={query} />
      <p className="hint">
        Partner erhalten Einsätze nur, wenn sie verifiziert und aktiv sind, die Leistung anbieten,
        das Gebiet abdecken, Kapazität haben, die Nachweise gültig sind – und der Inhaber die
        Partnerzuweisung freigegeben hat.
      </p>
      {page.items.length === 0 ? (
        <p className="muted">Noch keine Partner erfasst.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Partner</th>
                <th scope="col">Status</th>
                <th scope="col">Einsatzradius</th>
                <th scope="col">Kapazität</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((partner) => (
                <tr key={partner.id}>
                  <td>
                    <Link href={`/admin/partners/${partner.id}`}>{partner.legalName}</Link>
                  </td>
                  <td>
                    <span className="badge">{label(PARTNER_STATUS_LABELS, partner.status)}</span>
                  </td>
                  <td>{(partner.serviceRadiusM / 1000).toLocaleString("de-DE")} km</td>
                  <td>{partner.maxConcurrentJobs ?? "nicht konfiguriert"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ListPagination
        basePath="/admin/partners"
        filters={{}}
        page={page.page}
        total={page.total}
        pageSize={page.pageSize}
      />
      {canManage ? (
        <section className="panel" aria-labelledby="new-partner">
          <h2 id="new-partner">Partner anlegen (Prüfung ausstehend)</h2>
          <form action={createPartnerAction} className="form">
            <div className="field">
              <label htmlFor="partner-name">Firmenname</label>
              <input id="partner-name" name="legalName" required maxLength={200} />
            </div>
            <div className="field">
              <label htmlFor="partner-lat">Standort Breitengrad</label>
              <input
                id="partner-lat"
                name="baseLatitude"
                inputMode="decimal"
                required
                maxLength={12}
              />
            </div>
            <div className="field">
              <label htmlFor="partner-lng">Standort Längengrad</label>
              <input
                id="partner-lng"
                name="baseLongitude"
                inputMode="decimal"
                required
                maxLength={12}
              />
            </div>
            <div className="field">
              <label htmlFor="partner-radius">Einsatzradius in km</label>
              <input
                id="partner-radius"
                name="serviceRadiusKm"
                inputMode="numeric"
                required
                maxLength={3}
              />
            </div>
            <div className="field">
              <label htmlFor="partner-capacity">Max. gleichzeitige Einsätze (optional)</label>
              <input
                id="partner-capacity"
                name="maxConcurrentJobs"
                inputMode="numeric"
                maxLength={4}
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
