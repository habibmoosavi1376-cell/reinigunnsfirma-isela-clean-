import type { Metadata } from "next";
import Link from "next/link";
import { RegisterForm } from "@/components/auth/register-form";

export const metadata: Metadata = { title: "Konto erstellen" };

export default function RegisterPage() {
  return (
    <>
      <h1>Konto erstellen</h1>
      <p className="muted">
        Nach der Registrierung bestätigen Sie Ihre E-Mail-Adresse. Die Verknüpfung mit einem
        Kundenkonto erfolgt durch ISELA CLEAN oder per Einladung.
      </p>
      <RegisterForm />
      <p>
        Bereits registriert? <Link href="/auth/login">Anmelden</Link>
      </p>
    </>
  );
}
