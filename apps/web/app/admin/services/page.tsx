import { hasGlobalPermission } from "@isela/auth";
import { getCatalogAdmin } from "@isela/catalog";
import { SERVICE_UNITS } from "@isela/quotes";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import {
  DURATION_MODEL_LABELS,
  PRICING_STRATEGY_LABELS,
  PROPERTY_TYPE_LABELS,
  SERVICE_UNIT_LABELS,
  label,
} from "@/lib/admin/labels";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";
import {
  createCategoryAction,
  createOptionAction,
  createServiceAction,
  setOptionActiveAction,
  setServiceActiveAction,
} from "./actions";

export const metadata: Metadata = { title: "Leistungen" };

function durationText(service: {
  durationModel: string;
  baseDurationMinutes: number | null;
  durationPerUnitSeconds: number | null;
}): string {
  if (service.durationModel === "FIXED") return `${String(service.baseDurationMinutes)} min`;
  if (service.durationModel === "PER_UNIT") {
    return `${String(service.baseDurationMinutes ?? 0)} min + ${String(service.durationPerUnitSeconds)} s/Einheit`;
  }
  return label(DURATION_MODEL_LABELS, service.durationModel);
}

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "catalog:manage")) forbidden();
  const catalog = await getCatalogAdmin(await getServiceContext());
  const query = await searchParams;

  return (
    <>
      <h1>Leistungen</h1>
      <ActionResult query={query} />
      <p className="hint">
        Der Leistungskatalog ist Datenbestand – ohne Preise. Preise entstehen aus versionierten{" "}
        <Link href="/admin/pricing">Preisregeln</Link> (Strategie „Preisregeln“) oder werden im
        Angebot manuell erfasst.
      </p>

      {catalog.categories.map((category) => (
        <section key={category.id} className="panel" aria-labelledby={`category-${category.id}`}>
          <h2 id={`category-${category.id}`}>
            {category.name} {category.active ? null : <span className="badge">inaktiv</span>}
          </h2>
          {category.services.length === 0 ? (
            <p className="muted">Keine Leistungen in dieser Kategorie.</p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Leistung</th>
                    <th scope="col">Einheit / Mindestmenge</th>
                    <th scope="col">Dauer</th>
                    <th scope="col">Preisstrategie</th>
                    <th scope="col">Qualifikationen / Objektarten</th>
                    <th scope="col">Extras</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {category.services.map((service) => (
                    <tr key={service.id}>
                      <td>
                        {service.name}
                        <br />
                        <span className="muted">{service.key}</span>
                      </td>
                      <td>
                        {label(SERVICE_UNIT_LABELS, service.unit)}
                        {service.minQuantity === null
                          ? null
                          : ` · min. ${service.minQuantity.toLocaleString("de-DE")}`}
                      </td>
                      <td>{durationText(service)}</td>
                      <td>{label(PRICING_STRATEGY_LABELS, service.pricingStrategy)}</td>
                      <td>
                        {service.requiredQualifications.join(", ") || "–"}
                        <br />
                        <span className="muted">
                          {service.supportedPropertyTypes.length === 0
                            ? "alle Objektarten"
                            : service.supportedPropertyTypes
                                .map((t) => label(PROPERTY_TYPE_LABELS, t))
                                .join(", ")}
                        </span>
                      </td>
                      <td>
                        <ul className="compact">
                          {service.options.map((option) => (
                            <li key={option.id}>
                              {option.name} {option.active ? "" : "(inaktiv)"}
                              <form action={setOptionActiveAction} className="inline-form">
                                <input type="hidden" name="serviceId" value={service.id} />
                                <input type="hidden" name="optionId" value={option.id} />
                                <input type="hidden" name="active" value={String(!option.active)} />
                                <button className="button button--secondary" type="submit">
                                  {option.active ? "Deaktivieren" : "Aktivieren"}
                                </button>
                              </form>
                            </li>
                          ))}
                        </ul>
                        <form action={createOptionAction} className="inline-form">
                          <input type="hidden" name="serviceId" value={service.id} />
                          <input
                            name="key"
                            aria-label={`Schlüssel neues Extra für ${service.name}`}
                            placeholder="schluessel"
                            required
                            maxLength={64}
                          />
                          <input
                            name="name"
                            aria-label={`Name neues Extra für ${service.name}`}
                            placeholder="Name"
                            required
                            maxLength={200}
                          />
                          <button className="button button--secondary" type="submit">
                            Extra hinzufügen
                          </button>
                        </form>
                      </td>
                      <td>
                        {service.active ? "aktiv" : "inaktiv"}
                        <form action={setServiceActiveAction} className="inline-form">
                          <input type="hidden" name="serviceId" value={service.id} />
                          <input type="hidden" name="active" value={String(!service.active)} />
                          <button className="button button--secondary" type="submit">
                            {service.active ? "Deaktivieren" : "Aktivieren"}
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      <section className="panel" aria-labelledby="new-service">
        <h2 id="new-service">Leistung anlegen</h2>
        <form action={createServiceAction} className="form">
          <div className="field">
            <label htmlFor="service-category">Kategorie</label>
            <select id="service-category" name="categoryId" required>
              {catalog.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="service-key">Schlüssel (slug)</label>
            <input
              id="service-key"
              name="key"
              required
              maxLength={64}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
            />
          </div>
          <div className="field">
            <label htmlFor="service-name">Name</label>
            <input id="service-name" name="name" required maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="service-description">Beschreibung</label>
            <textarea id="service-description" name="description" rows={2} maxLength={2000} />
          </div>
          <div className="field">
            <label htmlFor="service-unit">Einheit</label>
            <select id="service-unit" name="unit" defaultValue="HOUR">
              {SERVICE_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {label(SERVICE_UNIT_LABELS, unit)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="service-min">Mindestmenge (optional)</label>
            <input id="service-min" name="minQuantity" inputMode="decimal" maxLength={12} />
          </div>
          <div className="field">
            <label htmlFor="service-duration-model">Dauermodell</label>
            <select id="service-duration-model" name="durationModel" defaultValue="MANUAL">
              {Object.entries(DURATION_MODEL_LABELS).map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="service-base-minutes">Minuten (fest bzw. Rüstzeit)</label>
            <input
              id="service-base-minutes"
              name="baseDurationMinutes"
              inputMode="numeric"
              maxLength={5}
            />
          </div>
          <div className="field">
            <label htmlFor="service-unit-seconds">Sekunden je Einheit (bei „Je Einheit“)</label>
            <input
              id="service-unit-seconds"
              name="durationPerUnitSeconds"
              inputMode="numeric"
              maxLength={5}
            />
          </div>
          <div className="field">
            <label htmlFor="service-strategy">Preisstrategie</label>
            <select id="service-strategy" name="pricingStrategy" defaultValue="MANUAL_QUOTE">
              {Object.entries(PRICING_STRATEGY_LABELS).map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="service-qualifications">
              Erforderliche Qualifikationen (kommagetrennt)
            </label>
            <input id="service-qualifications" name="requiredQualifications" maxLength={500} />
          </div>
          <fieldset className="field">
            <legend>Objektarten (keine Auswahl = alle)</legend>
            {Object.entries(PROPERTY_TYPE_LABELS).map(([value, name]) => (
              <label key={value} className="checkbox">
                <input type="checkbox" name="supportedPropertyTypes" value={value} /> {name}
              </label>
            ))}
          </fieldset>
          <button className="button" type="submit">
            Leistung anlegen
          </button>
        </form>
      </section>

      <section className="panel" aria-labelledby="new-category">
        <h2 id="new-category">Kategorie anlegen</h2>
        <form action={createCategoryAction} className="form">
          <div className="field">
            <label htmlFor="category-key">Schlüssel (slug)</label>
            <input
              id="category-key"
              name="key"
              required
              maxLength={64}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
            />
          </div>
          <div className="field">
            <label htmlFor="category-name">Name</label>
            <input id="category-name" name="name" required maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="category-sort">Reihenfolge (optional)</label>
            <input id="category-sort" name="sortOrder" inputMode="numeric" maxLength={5} />
          </div>
          <button className="button" type="submit">
            Kategorie anlegen
          </button>
        </form>
      </section>
    </>
  );
}
