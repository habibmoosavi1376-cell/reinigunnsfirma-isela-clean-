import type { Metadata } from "next";
import { PRIVACY_NOTICE_VERSION } from "@/lib/forms/request-form";
import { getServices } from "@/lib/server/services";

export const metadata: Metadata = { title: "Datenschutzhinweise" };

/**
 * Factual description of the processing implemented in this application. The final privacy
 * policy must be provided and approved by the controller before go-live (see report).
 */
export default function PrivacyPage() {
  const geocodingProvider = getServices().geocoding.provider?.id ?? null;
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
        <h2>Kundenkonto</h2>
        <p>
          Für die Anmeldung speichern wir Name, E-Mail-Adresse, ein gehashtes Passwort sowie
          Sitzungsdaten (einschließlich IP-Adresse und Browserkennung zum Schutz vor Missbrauch).
        </p>
        <h2>Cookies</h2>
        <p>
          Wir verwenden ausschließlich technisch notwendige Cookies für die Anmeldung. Es findet
          kein Tracking und keine Analyse statt.
        </p>
      </div>
    </section>
  );
}
