import type { Metadata } from "next";
import Link from "next/link";
import { pageSeo } from "@/lib/seo/seo";
import { currentConsent } from "@/lib/server/analytics";
import { getServices } from "@/lib/server/services";
import { grantStatisticsConsentAction, withdrawConsentAction } from "./actions";

export function generateMetadata(): Metadata {
  return pageSeo({
    baseUrl: getServices().env.APP_BASE_URL,
    path: "/datenschutz/einstellungen",
    title: "Datenschutz-Einstellungen",
    description:
      "Einwilligungen für optionale Statistik- und Marketingdienste ansehen und jederzeit widerrufen.",
    indexable: false,
  });
}

const STATUS_TEXT: Record<string, string> = {
  saved: "Ihre Einwilligung wurde gespeichert.",
  withdrawn: "Ihre Einwilligungen wurden widerrufen. Optionale Dienste sind deaktiviert.",
  unavailable: "Derzeit ist kein optionaler Dienst aktiv – es wurde nichts gespeichert.",
};

export default async function ConsentSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const provider = getServices().analytics;
  const consent = await currentConsent();
  const status = (await searchParams)["status"];
  const notice = typeof status === "string" ? STATUS_TEXT[status] : undefined;

  return (
    <section className="section" aria-labelledby="consent-title">
      <div className="container container--narrow">
        <h1 id="consent-title">Datenschutz-Einstellungen</h1>
        {notice === undefined ? null : (
          <p className="alert alert--success" role="status">
            {notice}
          </p>
        )}
        <h2>Technisch notwendige Cookies</h2>
        <p>
          Für die Anmeldung im Kundenbereich und zum Schutz vor Missbrauch verwenden wir technisch
          notwendige Cookies. Dafür ist keine Einwilligung erforderlich.
        </p>
        <h2>Statistik und Marketing</h2>
        {provider.enabled ? (
          <p>
            Mit Ihrer Einwilligung messen wir anonymisiert, welche Seiten genutzt werden. Es werden
            keine Namen, Kontaktdaten, Adressen oder Formulareingaben übermittelt.
          </p>
        ) : (
          <p>
            Derzeit setzen wir <strong>keine</strong> Statistik-, Analyse- oder Marketingdienste
            ein. Es werden keine Nutzungsdaten gemessen und keine entsprechenden Cookies gesetzt.
          </p>
        )}
        <p>
          Ihr aktueller Stand:{" "}
          <strong>
            {consent.statistics || consent.marketing
              ? "Einwilligung erteilt"
              : "keine Einwilligung erteilt"}
          </strong>
          {consent.decidedAt === null
            ? null
            : ` (gespeichert am ${consent.decidedAt.toLocaleDateString("de-DE")})`}
          .
        </p>
        <div className="cta-row">
          {provider.enabled ? (
            <form action={grantStatisticsConsentAction}>
              <button className="button" type="submit">
                Statistik erlauben
              </button>
            </form>
          ) : null}
          <form action={withdrawConsentAction}>
            <button className="button button--secondary" type="submit">
              Alle optionalen Einwilligungen widerrufen
            </button>
          </form>
        </div>
        <p>
          Weitere Informationen finden Sie in den{" "}
          <Link href="/datenschutz">Datenschutzhinweisen</Link>.
        </p>
      </div>
    </section>
  );
}
