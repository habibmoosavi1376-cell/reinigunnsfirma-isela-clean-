import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/auth/password-forms";

export const metadata: Metadata = { title: "Neues Passwort" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token =
    typeof params["token"] === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(params["token"])
      ? params["token"]
      : null;
  return (
    <>
      <h1>Neues Passwort festlegen</h1>
      {token === null || params["error"] !== undefined ? (
        <p className="alert alert--error" role="alert">
          Der Link ist ungültig oder abgelaufen.{" "}
          <Link href="/auth/forgot-password">Neuen Link anfordern</Link>
        </p>
      ) : (
        <ResetPasswordForm token={token} />
      )}
    </>
  );
}
