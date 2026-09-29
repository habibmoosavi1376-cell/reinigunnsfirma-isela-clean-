import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SignOutButton } from "@/components/auth/password-forms";
import { requireTeamArea } from "@/lib/server/guards";

export const metadata: Metadata = {
  title: "Meine Einsätze",
  robots: { index: false, follow: false },
};

export default async function TeamLayout({ children }: { children: ReactNode }) {
  // Server-side authorization for the whole area; the services check ownership per job again.
  await requireTeamArea();
  return (
    <section className="section">
      <div className="container">
        <nav className="area-nav" aria-label="Einsatzbereich">
          <ul>
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
