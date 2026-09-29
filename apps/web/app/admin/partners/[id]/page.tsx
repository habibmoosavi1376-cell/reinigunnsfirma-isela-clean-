import { hasGlobalPermission } from "@isela/auth";
import { getCatalogAdmin } from "@isela/catalog";
import { PARTNER_DOCUMENT_KIND_VALUES, getPartnerDetail } from "@isela/partners";
import { isDomainError } from "@isela/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import { formatDate, formatDateTime } from "@/lib/admin/format";
import {
  PARTNER_DOCUMENT_KIND_LABELS,
  PARTNER_DOCUMENT_STATUS_LABELS,
  PARTNER_STATUS_LABELS,
  label,
} from "@/lib/admin/labels";
import { requireAdminArea } from "@/lib/server/guards";
import { loadOperationsConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";
import {
  addDocumentAction,
  reviewDocumentAction,
  setCapacityAction,
  setServicesAction,
  suspendPartnerAction,
  verifyPartnerAction,
} from "../actions";

export const metadata: Metadata = { title: "Partner" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PartnerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "partner:read")) forbidden();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await getServiceContext();
  let partner;
  try {
    partner = await getPartnerDetail(ctx, { partnerId: id });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  const canManage = hasGlobalPermission(actor, "partner:manage");
  const [config, catalog] = await Promise.all([
    loadOperationsConfig(ctx.db, ctx.clock),
    canManage ? getCatalogAdmin(ctx) : null,
  ]);
  const offered = new Set(partner.services.map((s) => s.id));
  const query = await searchParams;

  return (
    <>
      <p>
        <Link href="/admin/partners">← Alle Partner</Link>
      </p>
      <h1>
        {partner.legalName}{" "}
        <span className="badge">{label(PARTNER_STATUS_LABELS, partner.status)}</span>
      </h1>
      <ActionResult query={query} />
      {config.partnerAssignmentEnabled ? null : (
        <p className="alert" role="note">
          Die Partnerzuweisung ist in der Konfiguration nicht freigegeben (Owner-Regel). Partner
          werden in der Disposition angezeigt, aber nicht zugewiesen.
        </p>
      )}

      <div className="detail-grid">
        <section className="panel" aria-labelledby="partner-facts">
          <h2 id="partner-facts">Stammdaten</h2>
          <dl className="facts">
            <dt>Verifiziert</dt>
            <dd>{formatDateTime(partner.verifiedAt)}</dd>
            <dt>Einsatzradius</dt>
            <dd>{(partner.serviceRadiusM / 1000).toLocaleString("de-DE")} km</dd>
            <dt>Kapazität</dt>
            <dd>{partner.maxConcurrentJobs ?? "nicht konfiguriert (nicht zuweisbar)"}</dd>
            <dt>Leistungen</dt>
            <dd>{partner.services.map((s) => s.name).join(", ") || "keine"}</dd>
            <dt>Pflichtnachweise</dt>
            <dd>
              {config.requiredPartnerDocumentKinds
                .map((kind) => label(PARTNER_DOCUMENT_KIND_LABELS, kind))
                .join(", ")}
            </dd>
          </dl>
          {canManage ? (
            <>
              <form action={setCapacityAction} className="form">
                <input type="hidden" name="partnerId" value={partner.id} />
                <div className="field">
                  <label htmlFor="partner-capacity">Max. gleichzeitige Einsätze</label>
                  <input
                    id="partner-capacity"
                    name="maxConcurrentJobs"
                    inputMode="numeric"
                    maxLength={4}
                    defaultValue={partner.maxConcurrentJobs ?? ""}
                  />
                </div>
                <button className="button" type="submit">
                  Kapazität speichern
                </button>
              </form>
              {partner.status === "ACTIVE" ? (
                <form action={suspendPartnerAction} className="form">
                  <input type="hidden" name="partnerId" value={partner.id} />
                  <div className="field">
                    <label htmlFor="suspend-reason">Sperrgrund</label>
                    <input
                      id="suspend-reason"
                      name="reason"
                      required
                      minLength={3}
                      maxLength={1000}
                    />
                  </div>
                  <button className="button button--secondary" type="submit">
                    Partner sperren
                  </button>
                </form>
              ) : (
                <form action={verifyPartnerAction} className="form">
                  <input type="hidden" name="partnerId" value={partner.id} />
                  <button className="button" type="submit">
                    Verifizieren und aktivieren
                  </button>
                  <p className="hint">Nur mit geprüften, gültigen Pflichtnachweisen möglich.</p>
                </form>
              )}
            </>
          ) : null}
        </section>

        {canManage && catalog !== null ? (
          <section className="panel" aria-labelledby="partner-services">
            <h2 id="partner-services">Angebotene Leistungen</h2>
            <form action={setServicesAction} className="form">
              <input type="hidden" name="partnerId" value={partner.id} />
              {catalog.categories.flatMap((category) =>
                category.services.map((service) => (
                  <label key={service.id} className="checkbox">
                    <input
                      type="checkbox"
                      name="serviceIds"
                      value={service.id}
                      defaultChecked={offered.has(service.id)}
                    />{" "}
                    {service.name} <span className="muted">({category.name})</span>
                  </label>
                )),
              )}
              <button className="button" type="submit">
                Leistungen speichern
              </button>
            </form>
          </section>
        ) : null}
      </div>

      <section className="panel" aria-labelledby="partner-documents">
        <h2 id="partner-documents">Nachweise</h2>
        {partner.documents.length === 0 ? (
          <p className="muted">Noch keine Nachweise erfasst.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Art</th>
                <th scope="col">Referenz</th>
                <th scope="col">Gültig bis</th>
                <th scope="col">Status</th>
                {canManage ? <th scope="col">Prüfung</th> : null}
              </tr>
            </thead>
            <tbody>
              {partner.documents.map((document) => (
                <tr key={document.id}>
                  <td>{label(PARTNER_DOCUMENT_KIND_LABELS, document.kind)}</td>
                  <td>{document.reference ?? "–"}</td>
                  <td>{formatDate(document.validUntil)}</td>
                  <td>{label(PARTNER_DOCUMENT_STATUS_LABELS, document.status)}</td>
                  {canManage ? (
                    <td>
                      {document.status === "PENDING"
                        ? (["VERIFIED", "REJECTED"] as const).map((decision) => (
                            <form
                              key={decision}
                              action={reviewDocumentAction}
                              className="inline-form"
                            >
                              <input type="hidden" name="partnerId" value={partner.id} />
                              <input type="hidden" name="documentId" value={document.id} />
                              <input type="hidden" name="decision" value={decision} />
                              <button
                                className={
                                  decision === "VERIFIED" ? "button" : "button button--secondary"
                                }
                                type="submit"
                              >
                                {decision === "VERIFIED" ? "Geprüft" : "Ablehnen"}
                              </button>
                            </form>
                          ))
                        : formatDateTime(document.verifiedAt)}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canManage ? (
          <form action={addDocumentAction} className="form">
            <input type="hidden" name="partnerId" value={partner.id} />
            <div className="field">
              <label htmlFor="document-kind">Art</label>
              <select id="document-kind" name="kind">
                {PARTNER_DOCUMENT_KIND_VALUES.map((kind) => (
                  <option key={kind} value={kind}>
                    {label(PARTNER_DOCUMENT_KIND_LABELS, kind)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="document-reference">Referenz (kurz, ohne Inhalte)</label>
              <input id="document-reference" name="reference" maxLength={100} />
            </div>
            <div className="field">
              <label htmlFor="document-valid">Gültig bis (optional)</label>
              <input id="document-valid" name="validUntil" type="date" />
            </div>
            <button className="button" type="submit">
              Nachweis erfassen
            </button>
          </form>
        ) : null}
      </section>
    </>
  );
}
