import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "@/components/auth/password-forms";
import { requireCustomerArea } from "@/lib/server/guards";

export const metadata: Metadata = {
  title: "Kundenbereich",
  robots: { index: false, follow: false },
};

const LINKS = [
  { href: "/customer", label: "Übersicht" },
  { href: "/customer/requests", label: "Anfragen" },
  { href: "/customer/quotes", label: "Angebote" },
  { href: "/customer/jobs", label: "Termine/Buchungen" },
  { href: "/customer/invoices", label: "Rechnungen" },
  { href: "/customer/profile", label: "Profil" },
] as const;

export default async function CustomerLayout({ children }: { children: ReactNode }) {
  // Server-side authorization for the whole area (pages authorize their data access again).
  await requireCustomerArea();
  return (
    <section className="section">
      <div className="container">
        <nav className="area-nav" aria-label="Kundenbereich">
          <ul>
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href}>{link.label}</Link>
              </li>
            ))}
            <li>
              <SignOutButton />
            </li>
          </ul>
        </nav>
        {children}
      </div>
    </section>
  );
}
