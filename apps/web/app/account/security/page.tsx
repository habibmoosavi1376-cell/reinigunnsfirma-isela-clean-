import { SignOutButton } from "@/components/auth/password-forms";
import { TwoFactorSetup } from "@/components/auth/two-factor-setup";
import { requireSignedIn } from "@/lib/server/guards";
import { getSessionUser } from "@/lib/server/session";

export default async function AccountSecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSignedIn();
  const user = await getSessionUser();
  const mfaRequired = (await searchParams)["reason"] === "mfa-required";
  return (
    <>
      <h1>Sicherheit</h1>
      {mfaRequired ? (
        <p className="alert alert--error" role="alert">
          Für Ihre Rolle ist die Zwei-Faktor-Authentifizierung verpflichtend. Bitte richten Sie sie
          ein und melden Sie sich anschließend erneut an.
        </p>
      ) : null}
      <h2>Zwei-Faktor-Authentifizierung</h2>
      {user?.twoFactorEnabled === true ? (
        <p>Die Zwei-Faktor-Authentifizierung ist aktiv.</p>
      ) : (
        <TwoFactorSetup />
      )}
      <h2>Abmelden</h2>
      <SignOutButton />
    </>
  );
}
