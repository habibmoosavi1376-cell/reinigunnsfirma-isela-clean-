import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { SITE_NAME } from "@/lib/seo/seo";
import "./globals.css";

// Every page is rendered per request: required for per-request CSP nonces (proxy.ts) and so
// that no server secret or database access is needed at build time.
export const dynamic = "force-dynamic";

const baseUrl = process.env["APP_BASE_URL"];

export const metadata: Metadata = {
  ...(baseUrl === undefined ? {} : { metadataBase: new URL(baseUrl) }),
  title: {
    default: `${SITE_NAME} – Reinigung für Privat, Gewerbe und Immobilien`,
    template: `%s | ${SITE_NAME}`,
  },
  description:
    "ISELA CLEAN: Reinigungsleistungen für Privathaushalte, Gewerbe und Hausverwaltungen. Unverbindlich anfragen – wir prüfen Ihre Anfrage und melden uns mit einem Angebot.",
  applicationName: SITE_NAME,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "de_DE",
  },
  robots: { index: true, follow: true },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b6e6e",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>
        <a className="skip-link" href="#main">
          Zum Inhalt springen
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
