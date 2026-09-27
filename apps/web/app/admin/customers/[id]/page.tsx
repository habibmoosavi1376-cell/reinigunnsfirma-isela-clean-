import { hasGlobalPermission, isAuthorized } from "@isela/auth";
import { ADDRESS_TYPES, PROPERTY_FREQUENCIES, PROPERTY_TYPES, getCustomerDetail } from "@isela/crm";
import { isDomainError } from "@isela/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { crmErrorText, crmNoticeText } from "@/lib/admin/crm-actions";
import { formatDate, formatDateTime, formatMoney } from "@/lib/admin/format";
import {
  ADDRESS_TYPE_LABELS,
  CONSENT_PURPOSE_LABELS,
  CUSTOMER_STATUS_LABELS,
  CUSTOMER_TYPE_LABELS,
  FREQUENCY_LABELS,
  GEOCODING_STATUS_LABELS,
  IDENTITY_KIND_LABELS,
  LEAD_STATUS_LABELS,
  PAYMENT_REASON_LABELS,
  PAYMENT_TERMS_LABELS,
  PROPERTY_TYPE_LABELS,
  QUOTE_STATUS_LABELS,
  SERVICE_AREA_MEMBERSHIP_LABELS,
  VERIFICATION_STATUS_LABELS,
  label,
} from "@/lib/admin/labels";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";
import {
  addAddressAction,
  createPropertyAction,
  createQuoteAction,
  setPrimaryAddressAction,
  setPropertyActiveAction,
  updateAddressAction,
  updateCustomerAction,
  updatePropertyAction,
} from "./actions";

export const metadata: Metadata = { title: "Kunde" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function addressLine(a: { street: string; houseNumber: string; postalCode: string; city: string }) {
  return `${a.street} ${a.houseNumber}, ${a.postalCode} ${a.city}`;
}

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "customer:read")) forbidden();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await getServiceContext();
  let detail;
  try {
    detail = await getCustomerDetail(ctx, { customerId: id });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  const query = await searchParams;
  const notice = crmNoticeText(query["notice"]);
  const error = crmErrorText(query["error"]);
  const { customer, addresses, properties, requests, quotes, payment } = detail;
  const canUpdate = isAuthorized(actor, "customer:update", { customerId: customer.id });
  const canWriteAddress = isAuthorized(actor, "customer_address:write", {
    customerId: customer.id,
  });
  const canWriteProperty = isAuthorized(actor, "property:write", { customerId: customer.id });
  const canWriteQuote = hasGlobalPermission(actor, "quote:write");
  const addressById = new Map(addresses.map((a) => [a.id, a]));

  return (
    <>
      <p>
        <Link href="/admin/customers">← Alle Kunden</Link>
      </p>
      <h1>{customer.displayName}</h1>
      {notice === null ? null : (
        <p className="alert alert--success" role="status">
          {notice}
        </p>
      )}
      {error === null ? null : (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}

      <div className="detail-grid">
        <section className="panel" aria-labelledby="master-title">
          <h2 id="master-title">Stammdaten</h2>
          <dl className="facts">
            <dt>Kunden-ID</dt>
            <dd>
              <code>{customer.id}</code>
            </dd>
            <dt>Kundenart</dt>
            <dd>{label(CUSTOMER_TYPE_LABELS, customer.kind)}</dd>
            <dt>Firma</dt>
            <dd>{customer.companyName ?? "–"}</dd>
            <dt>Status</dt>
            <dd>{label(CUSTOMER_STATUS_LABELS, customer.status)}</dd>
            <dt>Dublettenprüfung</dt>
            <dd>{customer.duplicateReviewStatus === "PENDING" ? "Offen" : "Keine"}</dd>
            <dt>Erkennungsmerkmale</dt>
            <dd>
              {customer.identityKinds.length === 0
                ? "–"
                : customer.identityKinds.map((k) => label(IDENTITY_KIND_LABELS, k)).join(", ")}
              <br />
              <span className="hint">Gespeichert nur als Hash, nicht im Klartext.</span>
            </dd>
            <dt>Angelegt</dt>
            <dd>{formatDateTime(customer.createdAt)}</dd>
            <dt>Geändert</dt>
            <dd>{formatDateTime(customer.updatedAt)}</dd>
          </dl>
          {canUpdate ? (
            <details>
              <summary>Stammdaten bearbeiten</summary>
              <form action={updateCustomerAction} className="form">
                <input type="hidden" name="customerId" value={customer.id} />
                <div className="field">
                  <label htmlFor="displayName">Anzeigename</label>
                  <input
                    id="displayName"
                    name="displayName"
                    required
                    maxLength={200}
                    defaultValue={customer.displayName}
                  />
                </div>
                {customer.kind === "PRIVATE" ? null : (
                  <div className="field">
                    <label htmlFor="companyName">Firma</label>
                    <input
                      id="companyName"
                      name="companyName"
                      maxLength={200}
                      defaultValue={customer.companyName ?? ""}
                    />
                  </div>
                )}
                <button className="button" type="submit">
                  Speichern
                </button>
              </form>
            </details>
          ) : null}
        </section>

        <section className="panel" aria-labelledby="payment-title">
          <h2 id="payment-title">Zahlungsstatus</h2>
          <p>
            Zahlungsbedingung: <strong>{label(PAYMENT_TERMS_LABELS, payment.terms)}</strong>
          </p>
          {payment.reasons.length > 0 ? (
            <ul>
              {payment.reasons.map((reason) => (
                <li key={reason}>{label(PAYMENT_REASON_LABELS, reason)}</li>
              ))}
            </ul>
          ) : null}
          {payment.invoiceReviewEligible ? (
            <p className="hint">
              Alle Voraussetzungen erfüllt – Rechnungskauf kann manuell geprüft werden.
            </p>
          ) : null}
          <p className="hint">
            Aufträge, Rechnungen und Zahlungen werden noch nicht im System geführt. Die
            Zahlungshistorie ist daher leer und es gilt Vorkasse (Richtlinie
            {payment.policyVersion === null ? " Standard" : ` Version ${payment.policyVersion}`}).
          </p>
        </section>
      </div>

      <section className="panel" aria-labelledby="contacts-title">
        <h2 id="contacts-title">Kontaktpersonen und Konten</h2>
        {detail.accounts.length === 0 ? (
          <p className="muted">Kein Nutzerkonto mit diesem Kunden verknüpft.</p>
        ) : (
          <ul>
            {detail.accounts.map((account) => (
              <li key={account.userId}>
                {account.name}
                {account.email === null ? null : ` – ${account.email}`}
                {account.emailVerified ? "" : " (E-Mail unbestätigt)"}
                {account.isScopeAdmin ? " · Konto-Administrator" : ""}
                <span className="muted"> · verknüpft {formatDateTime(account.linkedAt)}</span>
              </li>
            ))}
          </ul>
        )}
        {detail.contacts === null ? (
          <p className="hint">Kontaktdaten aus Anfragen sind für Ihre Rolle nicht sichtbar.</p>
        ) : detail.contacts.length === 0 ? null : (
          <>
            <h3>Aus Anfragen</h3>
            <ul>
              {detail.contacts.map((contact) => (
                <li key={contact.id}>
                  {contact.fullName}
                  {contact.email === null ? null : ` – ${contact.email}`}
                  {contact.phone === null ? null : ` – ${contact.phone}`}
                  {contact.suppressed ? " (Widerspruch – nicht kontaktieren)" : ""}{" "}
                  <Link href={`/admin/leads/${contact.leadId}`}>Lead</Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="addresses-title">
        <h2 id="addresses-title">Adressen</h2>
        {addresses.length === 0 ? (
          <p className="muted">Noch keine Adresse hinterlegt.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Adresse</th>
                  <th scope="col">Typ</th>
                  <th scope="col">Geocoding</th>
                  <th scope="col">Servicegebiet</th>
                  <th scope="col">Prüfung</th>
                  <th scope="col">Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {addresses.map((address) => (
                  <tr key={address.id}>
                    <td>
                      {addressLine(address)}
                      {address.isPrimary ? (
                        <>
                          {" "}
                          <span className="badge badge--ok">Hauptadresse</span>
                        </>
                      ) : null}
                    </td>
                    <td>{label(ADDRESS_TYPE_LABELS, address.addressType)}</td>
                    <td>{label(GEOCODING_STATUS_LABELS, address.geocodingStatus)}</td>
                    <td>{label(SERVICE_AREA_MEMBERSHIP_LABELS, address.inServiceArea)}</td>
                    <td>{label(VERIFICATION_STATUS_LABELS, address.verificationStatus)}</td>
                    <td>
                      {canWriteAddress && !address.isPrimary ? (
                        <form action={setPrimaryAddressAction} className="inline-form">
                          <input type="hidden" name="customerId" value={customer.id} />
                          <input type="hidden" name="addressId" value={address.id} />
                          <button className="button button--secondary" type="submit">
                            Als Hauptadresse
                          </button>
                        </form>
                      ) : null}
                      {canWriteAddress ? (
                        <details>
                          <summary>Bearbeiten</summary>
                          <form action={updateAddressAction} className="form">
                            <input type="hidden" name="customerId" value={customer.id} />
                            <input type="hidden" name="addressId" value={address.id} />
                            <AddressFields
                              prefix={`a-${address.id}`}
                              defaults={address}
                              required={false}
                            />
                            <p className="hint">
                              Bei Änderung der Lage werden die Koordinaten neu ermittelt.
                            </p>
                            <button className="button" type="submit">
                              Adresse speichern
                            </button>
                          </form>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canWriteAddress ? (
          <details>
            <summary>Adresse hinzufügen</summary>
            <form action={addAddressAction} className="form">
              <input type="hidden" name="customerId" value={customer.id} />
              <AddressFields prefix="new-address" defaults={null} required />
              <div className="field field--check">
                <input id="new-address-primary" name="isPrimary" type="checkbox" />
                <label htmlFor="new-address-primary">Als Hauptadresse festlegen</label>
              </div>
              <button className="button" type="submit">
                Adresse anlegen
              </button>
            </form>
          </details>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="properties-title">
        <h2 id="properties-title">Objekte</h2>
        {properties === null ? (
          <p className="hint">Objekte sind für Ihre Rolle nicht sichtbar.</p>
        ) : properties.length === 0 ? (
          <p className="muted">Noch keine Objekte angelegt.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Objekt</th>
                  <th scope="col">Typ</th>
                  <th scope="col">Adresse</th>
                  <th scope="col">Fläche/Räume</th>
                  <th scope="col">Intervall</th>
                  <th scope="col">Status</th>
                  {canWriteProperty ? <th scope="col">Aktionen</th> : null}
                </tr>
              </thead>
              <tbody>
                {properties.map((property) => {
                  const address = addressById.get(property.addressId);
                  return (
                    <tr key={property.id}>
                      <td>
                        {property.name}
                        {property.serviceRequirements === null ? null : (
                          <>
                            <br />
                            <span className="muted">{property.serviceRequirements}</span>
                          </>
                        )}
                      </td>
                      <td>{label(PROPERTY_TYPE_LABELS, property.propertyType)}</td>
                      <td>{address === undefined ? "–" : addressLine(address)}</td>
                      <td>
                        {property.areaSqm === null ? "–" : `${String(property.areaSqm)} m²`}
                        {property.rooms === null ? null : ` · ${String(property.rooms)} Räume`}
                        {property.bathrooms === null
                          ? null
                          : ` · ${String(property.bathrooms)} Bäder`}
                      </td>
                      <td>{label(FREQUENCY_LABELS, property.serviceFrequency)}</td>
                      <td>
                        <span className={property.active ? "badge badge--ok" : "badge badge--warn"}>
                          {property.active ? "Aktiv" : "Inaktiv"}
                        </span>
                      </td>
                      {canWriteProperty ? (
                        <td>
                          <form action={setPropertyActiveAction} className="inline-form">
                            <input type="hidden" name="customerId" value={customer.id} />
                            <input type="hidden" name="propertyId" value={property.id} />
                            <input
                              type="hidden"
                              name="active"
                              value={property.active ? "false" : "true"}
                            />
                            <button className="button button--secondary" type="submit">
                              {property.active ? "Deaktivieren" : "Aktivieren"}
                            </button>
                          </form>
                          <details>
                            <summary>Bearbeiten</summary>
                            <form action={updatePropertyAction} className="form">
                              <input type="hidden" name="customerId" value={customer.id} />
                              <input type="hidden" name="propertyId" value={property.id} />
                              <PropertyFields
                                prefix={`p-${property.id}`}
                                addresses={addresses}
                                defaults={property}
                              />
                              <button className="button" type="submit">
                                Objekt speichern
                              </button>
                            </form>
                          </details>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {canWriteProperty && addresses.length > 0 ? (
          <details>
            <summary>Objekt anlegen</summary>
            <form action={createPropertyAction} className="form">
              <input type="hidden" name="customerId" value={customer.id} />
              <PropertyFields prefix="new-property" addresses={addresses} defaults={null} />
              <button className="button" type="submit">
                Objekt anlegen
              </button>
            </form>
          </details>
        ) : null}
        {canWriteProperty && addresses.length === 0 ? (
          <p className="hint">Für ein Objekt wird zuerst eine Adresse benötigt.</p>
        ) : null}
      </section>

      {requests === null ? null : (
        <section className="panel" aria-labelledby="requests-title">
          <h2 id="requests-title">Anfragen und Leads</h2>
          {requests.length === 0 ? (
            <p className="muted">Keine Anfragen mit diesem Kunden verknüpft.</p>
          ) : (
            <ul>
              {requests.map((request) => (
                <li key={request.requestId}>
                  <Link href={`/admin/leads/${request.leadId}`}>
                    {request.serviceName} – {formatDate(request.createdAt)}
                  </Link>{" "}
                  <span className="badge">{label(LEAD_STATUS_LABELS, request.leadStatus)}</span>{" "}
                  <span className="muted">
                    {label(PROPERTY_TYPE_LABELS, request.propertyType)},{" "}
                    {label(FREQUENCY_LABELS, request.frequency)}
                    {request.propertyId === null ? "" : " · Objekt angelegt"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {quotes === null ? null : (
        <section className="panel" aria-labelledby="quotes-title">
          <h2 id="quotes-title">Angebote</h2>
          {quotes.length === 0 ? (
            <p className="muted">Noch keine Angebote.</p>
          ) : (
            <ul>
              {quotes.map((quote) => (
                <li key={quote.id}>
                  <Link href={`/admin/quotes/${quote.id}`}>
                    Angebot vom {formatDate(quote.createdAt)}
                  </Link>{" "}
                  <span className="badge">{label(QUOTE_STATUS_LABELS, quote.status)}</span>{" "}
                  {formatMoney(quote.grossCents, quote.currency)} brutto
                  {quote.validUntil === null ? null : (
                    <span className="muted"> · gültig bis {formatDate(quote.validUntil)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canWriteQuote ? (
            <form action={createQuoteAction} className="inline-form">
              <input type="hidden" name="customerId" value={customer.id} />
              <label htmlFor="quote-property">Objekt (optional)</label>
              <select id="quote-property" name="propertyId" defaultValue="">
                <option value="">Ohne Objekt</option>
                {(properties ?? [])
                  .filter((p) => p.active)
                  .map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
              </select>
              <button className="button" type="submit">
                Angebotsentwurf anlegen
              </button>
            </form>
          ) : null}
        </section>
      )}

      {detail.consents === null ? null : (
        <section className="panel" aria-labelledby="consent-title">
          <h2 id="consent-title">Einwilligungen</h2>
          {detail.consents.length === 0 ? (
            <p className="muted">Keine Einwilligungsnachweise erfasst.</p>
          ) : (
            <ul>
              {detail.consents.map((consent) => (
                <li key={consent.id}>
                  {label(CONSENT_PURPOSE_LABELS, consent.purpose)}:{" "}
                  {consent.status === "GRANTED" ? "erteilt" : "widerrufen"} (
                  {consent.subjectType === "CUSTOMER" ? "Kunde" : "Anfragekontakt"}, Text{" "}
                  {consent.textVersion}, {formatDateTime(consent.createdAt)})
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {detail.audit === null ? null : (
        <section className="panel" aria-labelledby="audit-title">
          <h2 id="audit-title">Audit-Historie</h2>
          {detail.audit.length === 0 ? (
            <p className="muted">Keine Einträge.</p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Zeitpunkt</th>
                    <th scope="col">Aktion</th>
                    <th scope="col">Objekt</th>
                    <th scope="col">Auslöser</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.audit.map((entry) => (
                    <tr key={entry.id}>
                      <td>{formatDateTime(entry.occurredAt)}</td>
                      <td>
                        <code>{entry.action}</code>
                      </td>
                      <td>{entry.entityType}</td>
                      <td>{entry.actorType === "USER" ? "Nutzer" : "System"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function AddressFields({
  prefix,
  defaults,
  required,
}: {
  prefix: string;
  defaults: {
    addressType: string;
    street: string;
    houseNumber: string;
    postalCode: string;
    city: string;
  } | null;
  required: boolean;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor={`${prefix}-type`}>Adresstyp</label>
        <select
          id={`${prefix}-type`}
          name="addressType"
          defaultValue={defaults?.addressType ?? "SERVICE"}
        >
          {ADDRESS_TYPES.map((type) => (
            <option key={type} value={type}>
              {label(ADDRESS_TYPE_LABELS, type)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-street`}>Straße</label>
        <input
          id={`${prefix}-street`}
          name="street"
          maxLength={200}
          required={required}
          autoComplete="off"
          defaultValue={defaults?.street ?? ""}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-number`}>Hausnummer</label>
        <input
          id={`${prefix}-number`}
          name="houseNumber"
          maxLength={20}
          required={required}
          autoComplete="off"
          defaultValue={defaults?.houseNumber ?? ""}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-postal`}>PLZ</label>
        <input
          id={`${prefix}-postal`}
          name="postalCode"
          maxLength={10}
          required={required}
          inputMode="numeric"
          autoComplete="off"
          defaultValue={defaults?.postalCode ?? ""}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-city`}>Ort</label>
        <input
          id={`${prefix}-city`}
          name="city"
          maxLength={120}
          required={required}
          autoComplete="off"
          defaultValue={defaults?.city ?? ""}
        />
      </div>
    </>
  );
}

function PropertyFields({
  prefix,
  addresses,
  defaults,
}: {
  prefix: string;
  addresses: readonly {
    id: string;
    street: string;
    houseNumber: string;
    postalCode: string;
    city: string;
  }[];
  defaults: {
    addressId: string;
    name: string;
    propertyType: string;
    areaSqm: number | null;
    rooms: number | null;
    bathrooms: number | null;
    serviceFrequency: string | null;
    serviceRequirements: string | null;
    notes: string | null;
  } | null;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor={`${prefix}-name`}>Bezeichnung</label>
        <input
          id={`${prefix}-name`}
          name="name"
          required
          maxLength={200}
          defaultValue={defaults?.name ?? ""}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-address`}>Adresse</label>
        <select
          id={`${prefix}-address`}
          name="addressId"
          required
          defaultValue={defaults?.addressId ?? addresses[0]?.id}
        >
          {addresses.map((address) => (
            <option key={address.id} value={address.id}>
              {addressLine(address)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-type`}>Objektart</label>
        <select
          id={`${prefix}-type`}
          name="propertyType"
          required
          defaultValue={defaults?.propertyType ?? "OFFICE"}
        >
          {PROPERTY_TYPES.map((type) => (
            <option key={type} value={type}>
              {label(PROPERTY_TYPE_LABELS, type)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-area`}>Fläche in m² (optional)</label>
        <input
          id={`${prefix}-area`}
          name="areaSqm"
          inputMode="decimal"
          maxLength={12}
          defaultValue={defaults?.areaSqm === null ? "" : String(defaults?.areaSqm ?? "")}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-rooms`}>Räume (optional)</label>
        <input
          id={`${prefix}-rooms`}
          name="rooms"
          inputMode="numeric"
          maxLength={5}
          defaultValue={defaults?.rooms === null ? "" : String(defaults?.rooms ?? "")}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-bathrooms`}>Bäder/Sanitärräume (optional)</label>
        <input
          id={`${prefix}-bathrooms`}
          name="bathrooms"
          inputMode="numeric"
          maxLength={5}
          defaultValue={defaults?.bathrooms === null ? "" : String(defaults?.bathrooms ?? "")}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-frequency`}>Reinigungsintervall (optional)</label>
        <select
          id={`${prefix}-frequency`}
          name="serviceFrequency"
          defaultValue={defaults?.serviceFrequency ?? ""}
        >
          <option value="">Nicht festgelegt</option>
          {PROPERTY_FREQUENCIES.map((frequency) => (
            <option key={frequency} value={frequency}>
              {label(FREQUENCY_LABELS, frequency)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-requirements`}>Leistungsanforderungen (optional)</label>
        <textarea
          id={`${prefix}-requirements`}
          name="serviceRequirements"
          maxLength={2000}
          rows={3}
          defaultValue={defaults?.serviceRequirements ?? ""}
        />
        <p className="hint">Z. B. Zugang, Materialien. Keine personenbezogenen Daten.</p>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-notes`}>Interne Notiz (optional)</label>
        <textarea
          id={`${prefix}-notes`}
          name="notes"
          maxLength={2000}
          rows={2}
          defaultValue={defaults?.notes ?? ""}
        />
      </div>
    </>
  );
}
