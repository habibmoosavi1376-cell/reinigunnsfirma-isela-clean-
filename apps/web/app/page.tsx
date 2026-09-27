import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { listActiveServiceAreas, listPublicServiceCategories } from "@isela/catalog";
import { buildOrganizationJsonLd, canonicalUrl, serializeJsonLd } from "@/lib/seo/seo";
import { getServices } from "@/lib/server/services";

export function generateMetadata(): Metadata {
  const { env } = getServices();
  return { alternates: { canonical: canonicalUrl(env.APP_BASE_URL, "/") } };
}

export default async function HomePage() {
  const { database, env } = getServices();
  const [categories, areas] = await Promise.all([
    listPublicServiceCategories(database.db),
    listActiveServiceAreas(database.db),
  ]);
  const nonce = (await headers()).get("x-nonce") ?? undefined;
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
      <script
        type="application/ld+json"
        nonce={nonce}
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />

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
            <Link className="button button--secondary" href="#leistungen">
              Leistungen ansehen
            </Link>
          </div>
        </div>
      </section>

      <section id="leistungen" className="section" aria-labelledby="leistungen-title">
        <div className="container">
          <h2 id="leistungen-title">Leistungen</h2>
          {categories.length === 0 ? (
            <p className="muted">Das Leistungsangebot wird derzeit eingerichtet.</p>
          ) : (
            <ul className="grid grid--3" role="list">
              {categories.map((category) => (
                <li key={category.key} className="card">
                  <h3>{category.name}</h3>
                  {category.description === null ? null : (
                    <p className="muted">{category.description}</p>
                  )}
                  <Link href={`/anfrage?leistung=${encodeURIComponent(category.key)}`}>
                    {category.name} anfragen
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section id="privat" className="section section--alt" aria-labelledby="privat-title">
        <div className="container">
          <h2 id="privat-title">Für Privathaushalte</h2>
          <p>
            Wohnungsreinigung, Grundreinigung oder Fensterreinigung – einmalig oder regelmäßig. Sie
            geben an, was Ihnen wichtig ist, und erhalten ein Angebot, bevor irgendetwas verbindlich
            wird.
          </p>
        </div>
      </section>

      <section id="gewerbe" className="section" aria-labelledby="gewerbe-title">
        <div className="container">
          <h2 id="gewerbe-title">Für Gewerbe</h2>
          <p>
            Büros, Praxen, Gastronomie, Fitnessstudios und Einzelhandel: Unterhaltsreinigung im
            gewünschten Turnus sowie Sonderreinigungen. Für Gewerbekunden stellen wir Anfrage,
            Angebot und Abrechnung auf klare, nachvollziehbare Prozesse.
          </p>
        </div>
      </section>

      <section id="immobilien" className="section section--alt" aria-labelledby="immobilien-title">
        <div className="container">
          <h2 id="immobilien-title">Für Hausverwaltungen und Immobilien</h2>
          <p>
            Treppenhausreinigung, Objektbetreuung und Reinigung bei Ein- und Auszug. Mehrere Objekte
            lassen sich mit einer Anfrage beschreiben; wir stimmen Umfang und Turnus mit Ihnen ab.
          </p>
        </div>
      </section>

      <section className="section" aria-labelledby="warum-title">
        <div className="container">
          <h2 id="warum-title">Warum ISELA CLEAN</h2>
          <ul className="grid grid--3" role="list">
            <li className="card">
              <h3>Persönlich geprüft</h3>
              <p>Jede Anfrage wird von uns geprüft. Preise werden nicht automatisch zugesagt.</p>
            </li>
            <li className="card">
              <h3>Einmalig oder regelmäßig</h3>
              <p>Wöchentlich, zweiwöchentlich, monatlich oder nach individueller Absprache.</p>
            </li>
            <li className="card">
              <h3>Transparent</h3>
              <p>Sie sehen den Stand Ihrer Anfragen im Kundenbereich.</p>
            </li>
          </ul>
        </div>
      </section>

      <section id="servicegebiet" className="section section--alt" aria-labelledby="gebiet-title">
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

      <section className="section" aria-labelledby="cta-title">
        <div className="container">
          <h2 id="cta-title">Bereit für ein sauberes Ergebnis?</h2>
          <p>Die Anfrage ist kostenlos und unverbindlich.</p>
          <Link className="button" href="/anfrage">
            Reinigung anfragen
          </Link>
        </div>
      </section>
    </>
  );
}
