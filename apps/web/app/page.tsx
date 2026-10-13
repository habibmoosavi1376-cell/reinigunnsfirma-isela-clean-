import type { Metadata } from "next";
import Link from "next/link";
import { listActiveServiceAreas, listPublicServicePages } from "@isela/catalog";
import { JsonLd } from "@/components/public/json-ld";
import { ProcessSteps } from "@/components/public/process-steps";
import { buildOrganizationJsonLd, pageSeo, SITE_NAME } from "@/lib/seo/seo";
import { getServices } from "@/lib/server/services";

export function generateMetadata(): Metadata {
  const seo = pageSeo({
    baseUrl: getServices().env.APP_BASE_URL,
    path: "/",
    title: `${SITE_NAME} – Reinigung für Privat, Gewerbe und Immobilien`,
    description:
      "Reinigungsleistungen für Privathaushalte, Gewerbe und Hausverwaltungen. Unverbindlich anfragen oder Rückruf anfordern – Angebot nach persönlicher Prüfung, kein automatischer Preis.",
  });
  // The homepage title is complete on its own (no "| ISELA CLEAN" suffix from the template).
  return { ...seo, title: { absolute: seo.title } };
}

/** Facts about how the platform works – no ratings, references, certificates or prices. */
const TRUST_POINTS = [
  "Anfrage kostenlos und unverbindlich",
  "Kein automatischer Preis – Angebot nach persönlicher Prüfung",
  "Anfragen, Angebote und Rechnungen im Kundenbereich",
] as const;

export default async function HomePage() {
  const { database, env } = getServices();
  const [pages, areas] = await Promise.all([
    listPublicServicePages(database.db),
    listActiveServiceAreas(database.db),
  ]);
  const jsonLd = buildOrganizationJsonLd({
    baseUrl: env.APP_BASE_URL,
    legalName: env.BUSINESS_LEGAL_NAME,
    email: env.BUSINESS_EMAIL,
    phone: env.BUSINESS_PHONE,
    street: env.BUSINESS_STREET,
    postalCode: env.BUSINESS_POSTAL_CODE,
    city: env.BUSINESS_CITY,
    areaServed: areas.map((area) => area.name),
  });

  return (
    <>
      <JsonLd data={jsonLd} />

      <section className="hero" aria-labelledby="hero-title">
        <div className="container">
          <h1 id="hero-title">Professionelle Reinigung für Zuhause, Gewerbe und Immobilien</h1>
          <p className="lead-text">
            Beschreiben Sie in wenigen Schritten, was gereinigt werden soll. Wir prüfen Ihre Anfrage
            persönlich und melden uns mit einem passenden Angebot – unverbindlich.
          </p>
          <div className="cta-row">
            <Link className="button" href="/anfrage">
              Reinigung anfragen
            </Link>
            <Link className="button button--secondary" href="/leistungen">
              Leistungen ansehen
            </Link>
            <Link className="button button--ghost" href="/rueckruf">
              Rückruf anfordern
            </Link>
          </div>
          <ul className="trust-list" role="list">
            {TRUST_POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      </section>

      <section id="leistungen" className="section" aria-labelledby="leistungen-title">
        <div className="container">
          <h2 id="leistungen-title">Leistungen</h2>
          {pages.length === 0 ? (
            <p className="muted">Das Leistungsangebot wird derzeit eingerichtet.</p>
          ) : (
            <ul className="grid grid--3" role="list">
              {pages.map((page) => (
                <li key={page.key} className="card">
                  <h3 className="card__title">
                    <Link href={`/leistungen/${page.urlSlug}`}>{page.name}</Link>
                  </h3>
                  {page.description === null ? null : (
                    <p className="muted card__text">{page.description}</p>
                  )}
                  <Link
                    className="card__link"
                    href={`/anfrage?leistung=${encodeURIComponent(page.key)}`}
                  >
                    {page.name} anfragen
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p>
            <Link href="/leistungen">Alle Leistungen im Überblick</Link>
          </p>
        </div>
      </section>

      <section className="section section--alt" aria-labelledby="ablauf-title">
        <div className="container">
          <h2 id="ablauf-title">So funktioniert es</h2>
          <ProcessSteps />
        </div>
      </section>

      <section id="privat" className="section" aria-labelledby="privat-title">
        <div className="container">
          <h2 id="privat-title">Für Privathaushalte</h2>
          <p>
            Wohnungsreinigung, Grundreinigung oder Fensterreinigung – einmalig oder regelmäßig. Sie
            geben an, was Ihnen wichtig ist, und erhalten ein Angebot, bevor irgendetwas verbindlich
            wird.
          </p>
        </div>
      </section>

      <section id="gewerbe" className="section section--alt" aria-labelledby="gewerbe-title">
        <div className="container">
          <h2 id="gewerbe-title">Für Gewerbe</h2>
          <p>
            Büros, Praxen, Gastronomie und Einzelhandel: Unterhaltsreinigung im gewünschten Turnus
            sowie Sonderreinigungen. Anfrage, Angebot und Abrechnung laufen über klare,
            nachvollziehbare Prozesse – mit Rechnungen im Kundenbereich.
          </p>
        </div>
      </section>

      <section id="immobilien" className="section" aria-labelledby="immobilien-title">
        <div className="container">
          <h2 id="immobilien-title">Für Hausverwaltungen und Immobilien</h2>
          <p>
            Treppenhausreinigung, Objektbetreuung und Reinigung bei Ein- und Auszug. Mehrere Objekte
            lassen sich mit einer Anfrage beschreiben; wir stimmen Umfang und Turnus mit Ihnen ab.
          </p>
        </div>
      </section>

      <section className="section section--alt" aria-labelledby="warum-title">
        <div className="container">
          <h2 id="warum-title">Warum ISELA CLEAN</h2>
          <ul className="grid grid--3" role="list">
            <li className="card">
              <h3 className="card__title">Persönlich geprüft</h3>
              <p>Jede Anfrage wird von uns geprüft. Preise werden nicht automatisch zugesagt.</p>
            </li>
            <li className="card">
              <h3 className="card__title">Einmalig oder regelmäßig</h3>
              <p>Wöchentlich, zweiwöchentlich, monatlich oder nach individueller Absprache.</p>
            </li>
            <li className="card">
              <h3 className="card__title">Transparent</h3>
              <p>Den Stand Ihrer Anfragen, Angebote und Rechnungen sehen Sie im Kundenbereich.</p>
            </li>
          </ul>
        </div>
      </section>

      <section id="servicegebiet" className="section" aria-labelledby="gebiet-title">
        <div className="container">
          <h2 id="gebiet-title">Servicegebiet</h2>
          {areas.length === 0 ? (
            <p>
              Unser Servicegebiet wird derzeit eingerichtet. Senden Sie uns Ihre Anfrage – wir
              prüfen die Verfügbarkeit für Ihre Adresse.
            </p>
          ) : (
            <>
              <p>Wir sind aktuell in folgenden Gebieten tätig:</p>
              <ul>
                {areas.map((area) => (
                  <li key={area.key}>{area.name}</li>
                ))}
              </ul>
              <p className="muted">
                Ob Ihre Adresse im Servicegebiet liegt, prüfen wir anhand der genauen Lage Ihrer
                Adresse.
              </p>
            </>
          )}
        </div>
      </section>

      <section className="section section--alt" aria-labelledby="fragen-title">
        <div className="container">
          <h2 id="fragen-title">Häufige Fragen</h2>
          <dl className="faq">
            <dt>Was kostet eine Reinigung?</dt>
            <dd>
              Das hängt von Leistung, Fläche und Häufigkeit ab. Wir nennen den Preis im
              schriftlichen Angebot, nachdem wir Ihre Angaben geprüft haben. Die Anfrage selbst ist
              kostenlos.
            </dd>
            <dt>Brauche ich ein Kundenkonto?</dt>
            <dd>
              Nein, für die Anfrage oder den Rückrufwunsch nicht. Mit einem Kundenkonto sehen Sie
              Anfragen, Angebote, Termine und Rechnungen an einem Ort.
            </dd>
            <dt>Ist meine Anfrage verbindlich?</dt>
            <dd>
              Nein. Verbindlich wird erst die Annahme eines Angebots. Vorher entstehen weder eine
              Buchung noch eine Zahlungspflicht.
            </dd>
          </dl>
        </div>
      </section>

      <section className="section cta-band" aria-labelledby="cta-title">
        <div className="container">
          <h2 id="cta-title">Bereit für ein sauberes Ergebnis?</h2>
          <p>Die Anfrage ist kostenlos und unverbindlich.</p>
          <div className="cta-row">
            <Link className="button" href="/anfrage">
              Reinigung anfragen
            </Link>
            <Link className="button button--secondary" href="/rueckruf">
              Rückruf anfordern
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
