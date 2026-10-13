import type { Metadata } from "next";
import Link from "next/link";
import { PRIVACY_NOTICE_VERSION } from "@/lib/forms/request-form";
import { pageSeo } from "@/lib/seo/seo";
import { getServices } from "@/lib/server/services";

export function generateMetadata(): Metadata {
  return pageSeo({
    baseUrl: getServices().env.APP_BASE_URL,
    path: "/datenschutz",
    title: "Datenschutzhinweise",
    description:
      "Welche Daten ISELA CLEAN bei Anfrage, Rückrufwunsch und Kundenkonto verarbeitet und wofür – Entwurf, vor Veröffentlichung rechtlich zu prüfen.",
  });
}

/**
 * Factual description of the processing implemented in this application. The final privacy
 * policy must be provided and approved by the controller before go-live (see report).
 */
export default function PrivacyPage() {
  const services = getServices();
  const geocodingProvider = services.geocoding.provider?.id ?? null;
  const analyticsActive = services.analytics.enabled;
  return (
    <section className="section">
      <div className="container">
        <h1>Datenschutzhinweise</h1>
        <p className="alert alert--error">
          Entwurf (Version {PRIVACY_NOTICE_VERSION}): Die vollständige Datenschutzerklärung wird vor
          der Veröffentlichung von der verantwortlichen Stelle bereitgestellt und rechtlich geprüft.
        </p>
        <h2>Anfrageformular</h2>
        <p>
          Wenn Sie eine Reinigung anfragen, verarbeiten wir Name, E-Mail-Adresse, optional
          Telefonnummer und Firma, die Adresse des Objekts sowie Ihre Angaben zur gewünschten
          Leistung, um Ihre Anfrage zu prüfen und Ihnen ein Angebot zu machen (vorvertragliche
          Maßnahme).
        </p>
        <p>
          Um zu prüfen, ob wir an der Adresse des Objekts tätig sein können, wird die Adresse in
          Koordinaten umgerechnet (Geocoding) und mit unseren Servicegebieten abgeglichen.
          {geocodingProvider === "geoapify"
            ? " Dafür wird ausschließlich die Objektadresse (ohne Name und Kontaktdaten) an den Dienstleister Geoapify GmbH (Deutschland) übermittelt."
            : " Derzeit ist dafür kein externer Dienstleister angebunden; die Prüfung erfolgt manuell."}
        </p>
        <p>
          Eine Einwilligung in Informationen per E-Mail ist freiwillig, wird gesondert gespeichert
          und kann jederzeit widerrufen werden.
        </p>
        <h2>Rückrufwunsch</h2>
        <p>
          Wenn Sie einen Rückruf anfordern, verarbeiten wir Ihren Namen, Ihre Telefonnummer, die
          Kundenart sowie optional Postleitzahl, gewünschte Leistung, Wunschzeitraum und Ihre
          Nachricht, um Sie zurückzurufen und Ihre Anfrage zu bearbeiten (vorvertragliche Maßnahme).
          Eine E-Mail-Adresse ist dafür nicht erforderlich.
        </p>
        <h2>Schutz vor Missbrauch und doppelten Übermittlungen</h2>
        <p>
          Um Missbrauch zu begrenzen, zählen wir Übermittlungen je Gerät (anhand eines nicht
          umkehrbaren Hashwerts der IP-Adresse) und je E-Mail-Adresse bzw. Telefonnummer (ebenfalls
          nur als Hashwert). Jedes Formular enthält ein einmaliges Kennzeichen, damit eine
          versehentlich doppelt abgeschickte Anfrage nur einmal gespeichert wird.
        </p>
        <h2>Kundenkonto</h2>
        <p>
          Für die Anmeldung speichern wir Name, E-Mail-Adresse, ein gehashtes Passwort sowie
          Sitzungsdaten (einschließlich IP-Adresse und Browserkennung zum Schutz vor Missbrauch).
        </p>
        <h2>Cookies, Statistik und Einwilligungen</h2>
        {analyticsActive ? (
          <p>
            Technisch notwendige Cookies verwenden wir für die Anmeldung. Statistikdienste setzen
            wir nur mit Ihrer Einwilligung ein; dabei werden keine Namen, Kontaktdaten, Adressen
            oder Formulareingaben übermittelt.
          </p>
        ) : (
          <p>
            Wir verwenden ausschließlich technisch notwendige Cookies für die Anmeldung. Es findet
            kein Tracking und keine Analyse statt; es ist kein Statistik- oder Marketingdienst
            angebunden.
          </p>
        )}
        <p>
          In den <Link href="/datenschutz/einstellungen">Datenschutz-Einstellungen</Link> sehen Sie
          Ihren Stand und können Einwilligungen jederzeit widerrufen. Ihre Entscheidung wird nur in
          einem Cookie auf Ihrem Gerät gespeichert (höchstens 12 Monate).
        </p>
      </div>
    </section>
  );
}
