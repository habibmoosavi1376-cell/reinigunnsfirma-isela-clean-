import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";
import { safeRedirectPath } from "@/lib/security/redirects";

export const metadata: Metadata = { title: "Anmelden" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Open-redirect protection: only same-origin paths are accepted.
  const next = safeRedirectPath((await searchParams)["next"], "/customer");
  return (
    <>
      <h1>Anmelden</h1>
      <LoginForm next={next} />
    </>
  );
}
