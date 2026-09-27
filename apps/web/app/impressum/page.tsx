import type { Metadata } from "next";
import { getServices } from "@/lib/server/services";

export const metadata: Metadata = { title: "Impressum" };

/** Renders only configured legal data (BUSINESS_* env). Required in production by env validation. */
export default function ImpressumPage() {
  const { env } = getServices();
  const complete =
    env.BUSINESS_LEGAL_NAME !== undefined &&
    env.BUSINESS_STREET !== undefined &&
    env.BUSINESS_CITY !== undefined;
  return (
    <section className="section">
      <div className="container">
        <h1>Impressum</h1>
        {complete ? (
          <address>
            {env.BUSINESS_LEGAL_NAME}
            <br />
            {env.BUSINESS_STREET}
            <br />
            {env.BUSINESS_POSTAL_CODE} {env.BUSINESS_CITY}
            <br />
            {env.BUSINESS_REPRESENTATIVE === undefined ? null : (
              <>
                Vertreten durch: {env.BUSINESS_REPRESENTATIVE}
                <br />
              </>
            )}
            {env.BUSINESS_EMAIL === undefined ? null : (
              <>
                E-Mail: {env.BUSINESS_EMAIL}
                <br />
              </>
            )}
            {env.BUSINESS_PHONE === undefined ? null : (
              <>
                Telefon: {env.BUSINESS_PHONE}
                <br />
              </>
            )}
            {env.BUSINESS_VAT_ID === undefined ? null : <>USt-IdNr.: {env.BUSINESS_VAT_ID}</>}
          </address>
        ) : (
          <p className="alert alert--error">
            Die Anbieterangaben sind in dieser Umgebung nicht konfiguriert. In der Produktion
            startet die Anwendung ohne diese Angaben nicht.
          </p>
        )}
      </div>
    </section>
  );
}
