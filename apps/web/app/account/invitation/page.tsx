import type { Metadata } from "next";
import Link from "next/link";
import { requireSignedIn } from "@/lib/server/guards";
import { acceptInvitationAction } from "./actions";

export const metadata: Metadata = {
  title: "Einladung annehmen",
  robots: { index: false, follow: false },
  // The token is part of the URL: never pass it on to other sites.
  referrer: "no-referrer",
};

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

const RESULTS: Record<string, { readonly text: string; readonly ok: boolean }> = {
  accepted: { text: "Die Einladung wurde angenommen. Ihr Kundenkonto ist verknüpft.", ok: true },
  invalid: {
    text: "Die Einladung ist ungültig, abgelaufen, bereits verwendet oder gehört zu einer anderen, bestätigten E-Mail-Adresse. Bitte fordern Sie bei uns eine neue Einladung an.",
    ok: false,
  },
  conflict: {
    text: "Dieses Konto ist bereits mit einem anderen Kundendatensatz verknüpft. Bitte wenden Sie sich an uns.",
    ok: false,
  },
  failed: {
    text: "Die Einladung konnte nicht verarbeitet werden. Bitte später erneut versuchen.",
    ok: false,
  },
};

export default async function InvitationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSignedIn();
  const query = await searchParams;
  const token = typeof query["token"] === "string" ? query["token"] : null;
  const result =
    typeof query["result"] === "string" && Object.hasOwn(RESULTS, query["result"])
      ? RESULTS[query["result"]]
      : undefined;

  return (
    <>
      <h1>Einladung annehmen</h1>
      {result === undefined ? null : (
        <p className={result.ok ? "alert alert--success" : "alert alert--error"} role="status">
          {result.text}
        </p>
      )}
      {result?.ok === true ? (
        <p>
          <Link href="/customer">Zum Kundenbereich</Link>
        </p>
      ) : token !== null && TOKEN.test(token) ? (
        <form action={acceptInvitationAction} className="form">
          <input type="hidden" name="token" value={token} />
          <p>
            Mit der Annahme wird Ihr angemeldetes Konto mit dem Kundendatensatz verknüpft, für den
            Sie eingeladen wurden. Die Einladung ist nur für die bestätigte E-Mail-Adresse gültig,
            an die sie gesendet wurde.
          </p>
          <button className="button" type="submit">
            Einladung annehmen
          </button>
        </form>
      ) : result === undefined ? (
        <p className="alert alert--error" role="alert">
          Der Einladungslink ist unvollständig. Bitte öffnen Sie den Link aus der E-Mail erneut.
        </p>
      ) : null}
    </>
  );
}
