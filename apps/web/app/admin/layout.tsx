import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AdminNavLink } from "@/components/admin/nav-link";
import { SignOutButton } from "@/components/auth/password-forms";
import { visibleModules } from "@/lib/admin/navigation";
import { requireAdminArea } from "@/lib/server/guards";

export const metadata: Metadata = { title: "Verwaltung", robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const actor = await requireAdminArea();
  const modules = visibleModules(actor);
  return (
    <section className="section">
      <div className="container admin-shell">
        <nav className="admin-nav" aria-label="Verwaltung">
          <ul>
            {modules.map((module) => (
              <li key={module.key}>
                {module.href === null ? (
                  <span className="admin-nav__soon" aria-disabled="true">
                    {module.label}
                    <small>kommt später</small>
                  </span>
                ) : (
                  <AdminNavLink href={module.href}>{module.label}</AdminNavLink>
                )}
              </li>
            ))}
            <li>
              <Link href="/account/security">Sicherheit</Link>
            </li>
            <li>
              <SignOutButton />
            </li>
          </ul>
        </nav>
        <div>{children}</div>
      </div>
    </section>
  );
}
