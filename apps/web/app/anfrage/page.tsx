import type { Metadata } from "next";
import { listPublicServiceCategories } from "@isela/catalog";
import { canonicalUrl } from "@/lib/seo/seo";
import { getServices } from "@/lib/server/services";
import { RequestForm } from "./request-form";

export function generateMetadata(): Metadata {
  const { env } = getServices();
  return {
    title: "Reinigung anfragen",
    description:
      "Unverbindliche Anfrage für Reinigungsleistungen – wir prüfen Ihre Angaben und melden uns mit einem Angebot.",
    alternates: { canonical: canonicalUrl(env.APP_BASE_URL, "/anfrage") },
  };
}

export default async function RequestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { database } = getServices();
  const categories = await listPublicServiceCategories(database.db);
  const requested = (await searchParams)["leistung"];
  // Only preselect a service that actually exists (the query parameter is untrusted).
  const preselected =
    typeof requested === "string" && categories.some((c) => c.key === requested)
      ? requested
      : undefined;

  return (
    <section className="section" aria-labelledby="anfrage-title">
      <div className="container">
        <h1 id="anfrage-title">Reinigung anfragen</h1>
        <p className="lead-text">
          Beschreiben Sie Ihr Anliegen. Wir prüfen die Anfrage und die Verfügbarkeit an Ihrer
          Adresse und melden uns mit einem Angebot.
        </p>
        <RequestForm
          services={categories.map((c) => ({ key: c.key, name: c.name }))}
          {...(preselected === undefined ? {} : { preselected })}
        />
      </div>
    </section>
  );
}
