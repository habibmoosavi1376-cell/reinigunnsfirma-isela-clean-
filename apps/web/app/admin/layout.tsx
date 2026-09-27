import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "@/components/auth/password-forms";
import { requireAdminArea } from "@/lib/server/guards";

export const metadata: Metadata = { title: "Verwaltung", robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdminArea();
  return (
    <section className="section">
      <div className="container">
        <nav className="area-nav" aria-label="Verwaltung">
          <ul>
            <li>
              <Link href="/admin/dashboard">Dashboard</Link>
            </li>
            <li>
              <Link href="/account/security">Sicherheit</Link>
            </li>
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
