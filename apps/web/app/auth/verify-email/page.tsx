import type { Metadata } from "next";
import Link from "next/link";
import { ResendVerificationForm } from "@/components/auth/password-forms";

export const metadata: Metadata = { title: "E-Mail bestätigen" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const verified = params["status"] === "verified" && params["error"] === undefined;
  return (
    <>
      <h1>E-Mail-Adresse bestätigen</h1>
      {verified ? (
        <p className="alert alert--success" role="status">
          Ihre E-Mail-Adresse ist bestätigt. <Link href="/auth/login">Jetzt anmelden</Link>
        </p>
      ) : params["error"] === undefined ? (
        <p>Bitte öffnen Sie den Bestätigungslink aus Ihrer E-Mail. Der Link ist 1 Stunde gültig.</p>
      ) : (
        <p className="alert alert--error" role="alert">
          Der Bestätigungslink ist ungültig oder abgelaufen. Fordern Sie unten einen neuen Link an.
        </p>
      )}
      <h2>Keinen Link erhalten?</h2>
      <ResendVerificationForm />
    </>
  );
}
