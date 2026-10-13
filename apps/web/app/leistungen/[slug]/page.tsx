import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicServicePage, listActiveServiceAreas } from "@isela/catalog";
import { Breadcrumbs } from "@/components/public/breadcrumbs";
import { JsonLd } from "@/components/public/json-ld";
import { ProcessSteps } from "@/components/public/process-steps";
import { buildBreadcrumbJsonLd, buildServiceJsonLd, excerpt, pageSeo } from "@/lib/seo/seo";
import { getServices } from "@/lib/server/services";

/*
 * Public service page, rendered from catalogue DATA (category name, admin-written description
 * and its active services). No generated text, no prices, no city variants. Pages without
 * a reviewed description are reachable but "noindex" and not listed in the sitemap.
 */

type Params = Promise<{ slug: string }>;

async function load(slug: string) {
  return getPublicServicePage(getServices().database.db, slug);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const page = await load((await params).slug);
  if (page === null) return { title: "Seite nicht gefunden", robots: { index: false } };
  return pageSeo({
    baseUrl: getServices().env.APP_BASE_URL,
    path: `/leistungen/${page.urlSlug}`,
    title: page.name,
    description:
      page.description === null
        ? `${page.name} bei ISELA CLEAN unverbindlich anfragen – wir prüfen Ihre Anfrage persönlich und melden uns mit einem Angebot.`
        : excerpt(page.description),
    indexable: page.indexable,
  });
}

export default async function ServicePage({ params }: { params: Params }) {
  const { slug } = await params;
  const page = await load(slug);
  if (page === null) notFound();
  const { database, env } = getServices();
  const areas = await listActiveServiceAreas(database.db);
  const path = `/leistungen/${page.urlSlug}`;
  const breadcrumbs = [
    { name: "Startseite", path: "/" },
    { name: "Leistungen", path: "/leistungen" },
    { name: page.name, path },
  ];
  const requestHref = `/anfrage?leistung=${encodeURIComponent(page.key)}`;
  const callbackHref = `/rueckruf?leistung=${encodeURIComponent(page.key)}`;

  return (
    <>
      <JsonLd data={buildBreadcrumbJsonLd(env.APP_BASE_URL, breadcrumbs)} />
      {page.indexable && page.description !== null ? (
        <JsonLd
          data={buildServiceJsonLd({
            baseUrl: env.APP_BASE_URL,
            name: page.name,
            description: page.description,
            path,
            areaServed: areas.map((area) => area.name),
          })}
        />
      ) : null}

      <section className="hero hero--compact" aria-labelledby="service-title">
        <div className="container">
          <Breadcrumbs items={breadcrumbs} />
          <h1 id="service-title">{page.name}</h1>
          {page.description === null ? (
            <p className="lead-text">
              Die ausführliche Beschreibung dieser Leistung wird gerade erstellt. Sie können{" "}
              {page.name} bereits jetzt unverbindlich anfragen – wir besprechen Umfang und Ablauf
              persönlich mit Ihnen.
            </p>
          ) : (
            <p className="lead-text prose">{page.description}</p>
          )}
          <div className="cta-row">
            <Link className="button" href={requestHref}>
              {page.name} anfragen
            </Link>
            <Link className="button button--secondary" href={callbackHref}>
              Rückruf anfordern
            </Link>
          </div>
        </div>
      </section>

      {page.services.length === 0 ? null : (
        <section className="section" aria-labelledby="included-title">
          <div className="container">
            <h2 id="included-title">Leistungen in diesem Bereich</h2>
            <ul className="grid grid--2" role="list">
              {page.services.map((service) => (
                <li key={service.name} className="card">
                  <h3 className="card__title">{service.name}</h3>
                  {service.description === null ? null : (
                    <p className="muted card__text">{service.description}</p>
                  )}
                </li>
              ))}
            </ul>
            <p className="muted">
              Der genaue Leistungsumfang wird im Angebot festgelegt. Preise nennen wir erst nach
              Prüfung Ihrer Angaben.
            </p>
          </div>
        </section>
      )}

      <section className="section section--alt" aria-labelledby="process-title">
        <div className="container">
          <h2 id="process-title">So läuft Ihre Anfrage ab</h2>
          <ProcessSteps />
        </div>
      </section>

      <section className="section" aria-labelledby="area-title">
        <div className="container">
          <h2 id="area-title">Servicegebiet</h2>
          {areas.length === 0 ? (
            <p>
              Unser Servicegebiet wird derzeit eingerichtet. Senden Sie uns Ihre Anfrage – wir
              prüfen die Verfügbarkeit für Ihre Adresse persönlich.
            </p>
          ) : (
            <p>
              Wir sind aktuell tätig in: {areas.map((area) => area.name).join(", ")}. Ob Ihre
              Adresse dazugehört, prüfen wir anhand der genauen Lage – eine Verfügbarkeit sagen wir
              erst nach dieser Prüfung zu.
            </p>
          )}
          <p>
            <Link href="/leistungen">Alle Leistungen ansehen</Link>
          </p>
        </div>
      </section>
    </>
  );
}
