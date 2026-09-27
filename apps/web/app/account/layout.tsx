import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Konto", robots: { index: false, follow: false } };

export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <section className="section">
      <div className="container">{children}</div>
    </section>
  );
}
