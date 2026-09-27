import { hasGlobalPermission, isAuthorized } from "@isela/auth";
import { getLeadDetail } from "@isela/crm";
import { isDomainError } from "@isela/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import {
  AVAILABILITY_LABELS,
  CONSENT_PURPOSE_LABELS,
  CUSTOMER_TYPE_LABELS,
  FREQUENCY_LABELS,
  GEOCODING_OUTCOME_LABELS,
  GEOCODING_REASON_LABELS,
  GEOCODING_STATUS_LABELS,
  LEAD_STATUS_LABELS,
  PROPERTY_TYPE_LABELS,
  label,
} from "@/lib/admin/labels";
import { errorText, noticeText } from "@/lib/admin/lead-actions";
import { nextActions } from "@/lib/admin/next-action";
import { requireAdminArea } from "@/lib/server/guards";
import { getServices } from "@/lib/server/services";
import { getServiceContext } from "@/lib/server/session";
import {
  correctAddressAction,
  createPropertyFromLeadAction,
  inviteCustomerAction,
  linkAccountAction,
  linkCustomerAction,
  rerunGeocodingAction,
  reviewGeocodingAction,
  transitionLeadAction,
  withdrawConsentAction,
} from "./actions";

export const metadata: Metadata = { title: "Lead" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatDate(date: Date | null): string {
  return date === null ? "–" : date.toLocaleString("de-DE");
}

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!isAuthorized(actor, "lead:read")) forbidden();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await getServiceContext();
  let detail;
  try {
    detail = await getLeadDetail(ctx, { leadId: id });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  const query = await searchParams;
  const notice = noticeText(query["notice"]);
  const error = errorText(query["error"]);
  const geocodingConfigured = getServices().geocoding.provider !== null;
  const canUpdate = isAuthorized(actor, "lead:update");
  const request = detail.request;
  const latestAttempt = detail.geocoding[0];
  const suggestions = nextActions(detail, geocodingConfigured);

  // Latest consent record per contact and purpose (records are append-only).
  const effectiveConsents = new Map<string, NonNullable<typeof detail.consents>[number]>();
  for (const consent of detail.consents ?? []) {
    const key = `${consent.subjectId}:${consent.purpose}`;
    if (!effectiveConsents.has(key)) effectiveConsents.set(key, consent);
  }

  return (
    <>
      <p>
        <Link href="/admin/leads">← Alle Leads</Link>
      </p>
      <h1>
        Lead {detail.lead.id.slice(0, 8)}{" "}
        <span className="badge">{label(LEAD_STATUS_LABELS, detail.lead.status)}</span>
      </h1>
      <p className="muted">
        Quelle: {detail.lead.source.name} · Eingang: {formatDate(detail.lead.createdAt)} · ID:{" "}
        <code>{detail.lead.id}</code>
      </p>
      {notice !== null ? (
        <p className="alert alert--success" role="status">
          {notice}
        </p>
      ) : null}
      {error !== null ? (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="detail-grid">
        <section className="panel" aria-labelledby="next-title">
          <h2 id="next-title">Nächste Aktion</h2>
          {suggestions.length === 0 ? (
            <p className="muted">Keine offene Empfehlung.</p>
          ) : (
            <ul>
              {suggestions.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          )}
          {detail.allowedTransitions.length > 0 ? (
            <form action={transitionLeadAction} className="inline-form">
              <input type="hidden" name="leadId" value={detail.lead.id} />
              <div className="field">
                <label htmlFor="to">Neuer Status</label>
                <select id="to" name="to" required defaultValue="">
                  <option value="" disabled>
                    Bitte wählen
                  </option>
                  {detail.allowedTransitions.map((status) => (
                    <option key={status} value={status}>
                      {label(LEAD_STATUS_LABELS, status)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="reason">Begründung (Pflicht bei „Verloren“)</label>
                <input id="reason" name="reason" maxLength={500} />
              </div>
              <button className="button" type="submit">
                Status ändern
              </button>
            </form>
          ) : (
            <p className="muted">Kein Statuswechsel möglich oder keine Berechtigung.</p>
          )}
        </section>

        <section className="panel" aria-labelledby="contact-title">
          <h2 id="contact-title">Kontakt</h2>
          {detail.contacts === null ? (
            <p className="muted">Keine Berechtigung für Kontaktdaten.</p>
          ) : detail.contacts.length === 0 ? (
            <p className="muted">Kein Kontakt erfasst.</p>
          ) : (
            detail.contacts.map((contact) => (
              <dl className="facts" key={contact.id}>
                <dt>Name</dt>
                <dd>{contact.fullName}</dd>
                <dt>E-Mail</dt>
                <dd>{contact.email ?? "–"}</dd>
                <dt>Telefon</dt>
                <dd>{contact.phone ?? "–"}</dd>
                <dt>Rechtsgrundlage</dt>
                <dd>
                  {contact.legalBasis === "GDPR_ART6_1B_CONTRACT"
                    ? "Anfrage (Vertragsanbahnung)"
                    : contact.legalBasis}
                </dd>
                <dt>Sperre</dt>
                <dd>{contact.suppressed ? "gesperrt – nicht kontaktieren" : "nein"}</dd>
              </dl>
            ))
          )}
          {detail.lead.companyName !== detail.contacts?.[0]?.fullName ? (
            <p>
              Firma: <strong>{detail.lead.companyName}</strong>
            </p>
          ) : null}
        </section>

        <section className="panel" aria-labelledby="request-title">
          <h2 id="request-title">Anfrage</h2>
          {request === null ? (
            <p className="muted">Keine Website-Anfrage zu diesem Lead.</p>
          ) : (
            <dl className="facts">
              <dt>Kundenart</dt>
              <dd>{label(CUSTOMER_TYPE_LABELS, request.customerType)}</dd>
              <dt>Leistung</dt>
              <dd>{request.serviceName}</dd>
              <dt>Objektart</dt>
              <dd>{label(PROPERTY_TYPE_LABELS, request.propertyType)}</dd>
              <dt>Fläche</dt>
              <dd>
                {request.approximateAreaSqm === null ? "–" : `${request.approximateAreaSqm} m²`}
              </dd>
              <dt>Häufigkeit</dt>
              <dd>{label(FREQUENCY_LABELS, request.frequency)}</dd>
              {request.numberOfProperties === null ? null : (
                <>
                  <dt>Anzahl Objekte</dt>
                  <dd>{request.numberOfProperties}</dd>
                </>
              )}
              <dt>Nachricht</dt>
              <dd>{request.message ?? "–"}</dd>
            </dl>
          )}
        </section>

        {request === null ? null : (
          <section className="panel" aria-labelledby="address-title">
            <h2 id="address-title">Adresse, Geocoding und Servicegebiet</h2>
            <dl className="facts">
              <dt>Adresse (Eingabe)</dt>
              <dd>
                {request.street} {request.houseNumber}, {request.postalCode} {request.city} (
                {request.country})
              </dd>
              <dt>Geocoding</dt>
              <dd>
                {label(GEOCODING_STATUS_LABELS, request.geocodingStatus)}
                {geocodingConfigured ? null : " – kein Anbieter konfiguriert"}
              </dd>
              <dt>Koordinaten</dt>
              <dd>
                {request.latitude === null || request.longitude === null
                  ? "keine vertrauenswürdigen Koordinaten"
                  : `${request.latitude.toFixed(5)}, ${request.longitude.toFixed(5)}`}
              </dd>
              <dt>Servicegebiet</dt>
              <dd>
                <span
                  className={`badge ${request.serviceAreaStatus === "AVAILABLE" ? "badge--ok" : request.serviceAreaStatus === "NOT_AVAILABLE" ? "badge--warn" : ""}`}
                >
                  {label(AVAILABILITY_LABELS, request.serviceAreaStatus)}
                </span>{" "}
                {request.serviceAreaName ?? ""}
              </dd>
              <dt>Geprüft am</dt>
              <dd>{formatDate(request.serviceAreaCheckedAt)}</dd>
            </dl>

            {latestAttempt === undefined ? (
              <p className="muted">Noch kein Geocoding-Ergebnis.</p>
            ) : (
              <>
                <h3>Letztes Ergebnis ({latestAttempt.provider})</h3>
                {latestAttempt.provider === "geoapify" ? (
                  <p className="hint">
                    Geocoding: <a href="https://www.geoapify.com/">Geoapify</a> · Kartendaten ©{" "}
                    <a href="https://www.openstreetmap.org/copyright">OpenStreetMap-Mitwirkende</a>
                  </p>
                ) : null}
                <dl className="facts">
                  <dt>Ergebnis</dt>
                  <dd>{label(GEOCODING_OUTCOME_LABELS, latestAttempt.outcome)}</dd>
                  <dt>Normalisiert</dt>
                  <dd>{latestAttempt.normalizedAddress ?? "–"}</dd>
                  <dt>Region</dt>
                  <dd>{latestAttempt.region ?? "–"}</dd>
                  <dt>Genauigkeit</dt>
                  <dd>
                    {latestAttempt.precision ?? "–"}
                    {latestAttempt.confidence === null
                      ? ""
                      : ` · Konfidenz ${latestAttempt.confidence}`}
                  </dd>
                  <dt>Hinweise</dt>
                  <dd>
                    {latestAttempt.reasons.length === 0
                      ? "–"
                      : latestAttempt.reasons
                          .map((r) => label(GEOCODING_REASON_LABELS, r))
                          .join(", ")}
                  </dd>
                  <dt>Zeitpunkt</dt>
                  <dd>
                    {formatDate(latestAttempt.createdAt)}
                    {latestAttempt.byStaff ? " (manuell)" : ""}
                  </dd>
                </dl>
                {canUpdate && latestAttempt.outcome === "NEEDS_REVIEW" ? (
                  <form action={reviewGeocodingAction} className="inline-form">
                    <input type="hidden" name="leadId" value={detail.lead.id} />
                    <input type="hidden" name="attemptId" value={latestAttempt.id} />
                    <button className="button" type="submit" name="decision" value="CONFIRM">
                      Treffer bestätigen
                    </button>
                    <button
                      className="button button--secondary"
                      type="submit"
                      name="decision"
                      value="REJECT"
                    >
                      Treffer verwerfen
                    </button>
                  </form>
                ) : null}
              </>
            )}

            {canUpdate ? (
              <>
                {geocodingConfigured ? (
                  <form action={rerunGeocodingAction} className="inline-form">
                    <input type="hidden" name="leadId" value={detail.lead.id} />
                    <button className="button button--secondary" type="submit">
                      Geocoding erneut ausführen
                    </button>
                  </form>
                ) : null}
                <details>
                  <summary>Adresse korrigieren</summary>
                  <form action={correctAddressAction} className="form">
                    <input type="hidden" name="leadId" value={detail.lead.id} />
                    <div className="field">
                      <label htmlFor="street">Straße</label>
                      <input
                        id="street"
                        name="street"
                        required
                        maxLength={200}
                        defaultValue={request.street}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="houseNumber">Hausnummer</label>
                      <input
                        id="houseNumber"
                        name="houseNumber"
                        required
                        maxLength={20}
                        defaultValue={request.houseNumber}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="postalCode">Postleitzahl</label>
                      <input
                        id="postalCode"
                        name="postalCode"
                        required
                        maxLength={10}
                        defaultValue={request.postalCode}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="city">Ort</label>
                      <input
                        id="city"
                        name="city"
                        required
                        maxLength={120}
                        defaultValue={request.city}
                      />
                    </div>
                    <button className="button" type="submit">
                      Adresse speichern und neu prüfen
                    </button>
                  </form>
                </details>
              </>
            ) : null}
          </section>
        )}

        {request === null ? null : (
          <section className="panel" aria-labelledby="customer-title">
            <h2 id="customer-title">Kunde</h2>
            {request.customerId === null ? (
              <>
                <p>Noch kein Kundendatensatz verknüpft.</p>
                {isAuthorized(actor, "customer:create") ? (
                  <form action={linkCustomerAction} className="form">
                    <input type="hidden" name="leadId" value={detail.lead.id} />
                    <p className="hint">
                      Bestehende Kunden werden über E-Mail, Steuer- oder Zahlungsreferenz erkannt
                      und nicht doppelt angelegt.
                    </p>
                    <div className="field">
                      <label htmlFor="taxId">Steuernummer/USt-IdNr. (optional)</label>
                      <input id="taxId" name="taxId" maxLength={40} />
                    </div>
                    <div className="field">
                      <label htmlFor="paymentReference">
                        Zahlungsreferenz, z. B. IBAN (optional)
                      </label>
                      <input
                        id="paymentReference"
                        name="paymentReference"
                        maxLength={64}
                        autoComplete="off"
                      />
                    </div>
                    <button className="button" type="submit">
                      Kundendatensatz anlegen/zuordnen
                    </button>
                  </form>
                ) : null}
              </>
            ) : (
              <>
                <p>
                  Verknüpft mit:{" "}
                  {hasGlobalPermission(actor, "customer:read") ? (
                    <Link href={`/admin/customers/${request.customerId}`}>
                      <strong>{request.customerName ?? request.customerId}</strong>
                    </Link>
                  ) : (
                    <strong>{request.customerName ?? request.customerId}</strong>
                  )}
                </p>
                {isAuthorized(actor, "property:write") ? (
                  request.propertyId === null ? (
                    <form action={createPropertyFromLeadAction} className="inline-form">
                      <input type="hidden" name="leadId" value={detail.lead.id} />
                      <button className="button button--secondary" type="submit">
                        Objekt aus Anfrage anlegen
                      </button>
                      <span className="hint">
                        Übernimmt Objektart, Fläche und Intervall an der Anfrageadresse.
                      </span>
                    </form>
                  ) : (
                    <p className="muted">Objekt aus dieser Anfrage ist angelegt.</p>
                  )
                ) : null}
                {isAuthorized(actor, "customer:link_account") ? (
                  <form action={inviteCustomerAction} className="inline-form">
                    <input type="hidden" name="leadId" value={detail.lead.id} />
                    <button className="button button--secondary" type="submit">
                      Kundenkonto einladen
                    </button>
                    <span className="hint">
                      Nur an die E-Mail-Adresse der Anfrage, wenn sie diesem Kunden zugeordnet ist.
                      Einmal-Link, 7 Tage gültig.
                    </span>
                  </form>
                ) : null}
                {isAuthorized(actor, "customer:link_account") ? (
                  <form action={linkAccountAction} className="inline-form">
                    <input type="hidden" name="leadId" value={detail.lead.id} />
                    <button className="button button--secondary" type="submit">
                      Verifiziertes Nutzerkonto verknüpfen
                    </button>
                    <span className="hint">
                      Nur ein Konto mit bestätigter, identischer E-Mail-Adresse wird verknüpft.
                    </span>
                  </form>
                ) : null}
              </>
            )}
          </section>
        )}

        <section className="panel" aria-labelledby="consent-title">
          <h2 id="consent-title">Einwilligungen und Hinweise</h2>
          {request === null ? null : (
            <p>
              Datenschutzhinweis zur Kenntnis genommen (Version {request.privacyNoticeVersion}) am{" "}
              {formatDate(request.privacyNoticeAcknowledgedAt)}.{" "}
              <span className="muted">
                Keine Einwilligung, sondern Information zur Bearbeitung der Anfrage.
              </span>
            </p>
          )}
          {detail.consents === null ? (
            <p className="muted">Keine Berechtigung für Einwilligungsdaten.</p>
          ) : detail.consents.length === 0 ? (
            <p className="muted">Keine Marketing-Einwilligung erteilt.</p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Zweck</th>
                    <th scope="col">Status</th>
                    <th scope="col">Quelle</th>
                    <th scope="col">Textversion</th>
                    <th scope="col">Zeitpunkt</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.consents.map((consent) => (
                    <tr key={consent.id}>
                      <td>{label(CONSENT_PURPOSE_LABELS, consent.purpose)}</td>
                      <td>{consent.status === "GRANTED" ? "erteilt" : "widerrufen"}</td>
                      <td>{consent.source}</td>
                      <td>{consent.textVersion}</td>
                      <td>{formatDate(consent.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {isAuthorized(actor, "consent:record")
            ? [...effectiveConsents.values()]
                .filter((consent) => consent.status === "GRANTED")
                .map((consent) => (
                  <form action={withdrawConsentAction} className="inline-form" key={consent.id}>
                    <input type="hidden" name="leadId" value={detail.lead.id} />
                    <input type="hidden" name="contactId" value={consent.subjectId} />
                    <input type="hidden" name="purpose" value={consent.purpose} />
                    <button className="button button--secondary" type="submit">
                      Widerruf dokumentieren: {label(CONSENT_PURPOSE_LABELS, consent.purpose)}
                    </button>
                  </form>
                ))
            : null}
        </section>

        <section className="panel" aria-labelledby="history-title">
          <h2 id="history-title">Historie</h2>
          {detail.history.length === 0 ? (
            <p className="muted">Noch keine Statusänderung.</p>
          ) : (
            <ol>
              {detail.history.map((entry) => (
                <li key={`${entry.createdAt.toISOString()}-${entry.toStatus}`}>
                  {formatDate(entry.createdAt)}: {label(LEAD_STATUS_LABELS, entry.fromStatus)} →{" "}
                  {label(LEAD_STATUS_LABELS, entry.toStatus)}
                  {entry.actorName === null ? "" : ` (${entry.actorName})`}
                  {entry.reason === null ? "" : ` – ${entry.reason}`}
                </li>
              ))}
            </ol>
          )}
        </section>

        {detail.audit === null ? null : (
          <section className="panel" aria-labelledby="audit-title">
            <h2 id="audit-title">Audit</h2>
            {detail.audit.length === 0 ? (
              <p className="muted">Keine Einträge.</p>
            ) : (
              <ol>
                {detail.audit.map((entry) => (
                  <li key={entry.id}>
                    {formatDate(entry.occurredAt)}: <code>{entry.action}</code> (
                    {entry.actorType === "SYSTEM" ? "System" : "Nutzer"})
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </div>
    </>
  );
}
