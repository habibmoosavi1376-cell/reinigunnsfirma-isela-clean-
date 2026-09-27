import { requireCustomerArea } from "@/lib/server/guards";

export default async function CustomerAngebotePage() {
  await requireCustomerArea();
  return (
    <>
      <h1>Angebote</h1>
      <p className="muted">
        Angebote werden hier angezeigt, sobald die digitale Angebotsstellung freigeschaltet ist. Bis
        dahin erhalten Sie Angebote direkt von uns.
      </p>
    </>
  );
}
