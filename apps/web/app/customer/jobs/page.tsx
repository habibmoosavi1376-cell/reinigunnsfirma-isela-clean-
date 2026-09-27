import { requireCustomerArea } from "@/lib/server/guards";

export default async function CustomerTerminePage() {
  await requireCustomerArea();
  return (
    <>
      <h1>Termine</h1>
      <p className="muted">
        Termine werden hier angezeigt, sobald die Terminplanung im Kundenbereich freigeschaltet ist.
      </p>
    </>
  );
}
