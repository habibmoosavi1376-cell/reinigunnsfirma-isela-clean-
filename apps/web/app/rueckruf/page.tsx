import type { Metadata } from "next";
import Link from "next/link";
import { listPublicServiceCategories } from "@isela/catalog";
import { newSubmissionToken } from "@/lib/forms/submission-token";
import { pageSeo } from "@/lib/seo/seo";
import { getServices } from "@/lib/server/services";
import { CallbackForm } from "./callback-form";

export function generateMetadata(): Metadata {
  return pageSeo({
    baseUrl: getServices().env.APP_BASE_URL,
    path: "/rueckruf",
    title: "Rückruf anfordern",
    description:
      "Lieber persönlich sprechen? Hinterlassen Sie Name und Telefonnummer – ISELA CLEAN ruft Sie zurück und bespricht Ihre Reinigungsanfrage unverbindlich.",
  });
}

export default async function CallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const categories = await listPublicServiceCategories(getServices().database.db);
  const requested = (await searchParams)["leistung"];
  // Only preselect a service that actually exists (the query parameter is untrusted).
  const preselected =
    typeof requested === "string" && categories.some((c) => c.key === requested)
      ? requested
      : undefined;

  return (
    <section className="section" aria-labelledby="rueckruf-title">
      <div className="container container--narrow">
        <h1 id="rueckruf-title">Rückruf anfordern</h1>
        <p className="lead-text">
          Hinterlassen Sie Ihren Namen und Ihre Telefonnummer. Wir rufen Sie zurück und besprechen
          Ihr Anliegen – unverbindlich und ohne automatische Preis- oder Terminzusage.
        </p>
        <p>
          Sie möchten Ihr Anliegen lieber schriftlich beschreiben?{" "}
          <Link href="/anfrage">Zur ausführlichen Anfrage</Link>
        </p>
        <CallbackForm
          submissionToken={newSubmissionToken()}
          services={categories.map((c) => ({ key: c.key, name: c.name }))}
          {...(preselected === undefined ? {} : { preselected })}
        />
      </div>
    </section>
  );
}
