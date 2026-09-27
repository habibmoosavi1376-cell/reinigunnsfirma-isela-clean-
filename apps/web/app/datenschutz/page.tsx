import type { Metadata } from "next";
import { PRIVACY_NOTICE_VERSION } from "@/lib/forms/request-form";

export const metadata: Metadata = { title: "Datenschutzhinweise" };

/**
 * Factual description of the processing implemented in this application. The final privacy
 * policy must be provided and approved by the controller before go-live (see report).
 */
export default function PrivacyPage() {
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
