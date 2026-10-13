import type { Metadata } from "next";
import Link from "next/link";
import { listPublicServicePages } from "@isela/catalog";
import { Breadcrumbs } from "@/components/public/breadcrumbs";
import { JsonLd } from "@/components/public/json-ld";
import { buildBreadcrumbJsonLd, pageSeo } from "@/lib/seo/seo";
import { getServices } from "@/lib/server/services";

const PATH = "/leistungen";
const BREADCRUMBS = [
  { name: "Startseite", path: "/" },
  { name: "Leistungen", path: PATH },
] as const;

export function generateMetadata(): Metadata {
  return pageSeo({
    baseUrl: getServices().env.APP_BASE_URL,
    path: PATH,
    title: "Leistungen",
    description:
      "Übersicht der Reinigungsleistungen von ISELA CLEAN für Privathaushalte, Gewerbe und Hausverwaltungen – unverbindlich anfragen, Angebot nach persönlicher Prüfung.",
  });
}

export default async function ServicesIndexPage() {
  const { database, env } = getServices();
  const pages = await listPublicServicePages(database.db);
  return (
    <>
      <JsonLd data={buildBreadcrumbJsonLd(env.APP_BASE_URL, BREADCRUMBS)} />
      <section className="section" aria-labelledby="services-title">
        <div className="container">
          <Breadcrumbs items={BREADCRUMBS} />
          <h1 id="services-title">Leistungen</h1>
          <p className="lead-text">
            Wählen Sie eine Leistung, um mehr zu erfahren, oder senden Sie direkt eine Anfrage.
            Umfang und Preis legen wir nach persönlicher Prüfung im Angebot fest.
          </p>
          {pages.length === 0 ? (
            <p className="muted">Das Leistungsangebot wird derzeit eingerichtet.</p>
          ) : (
            <ul className="grid grid--3" role="list">
              {pages.map((page) => (
                <li key={page.key} className="card">
                  <h2 className="card__title">
                    <Link href={`${PATH}/${page.urlSlug}`}>{page.name}</Link>
                  </h2>
                  {page.description === null ? null : (
                    <p className="muted card__text">{page.description}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
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
