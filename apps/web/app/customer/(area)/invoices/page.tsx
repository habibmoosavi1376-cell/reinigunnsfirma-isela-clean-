import { requireCustomerArea } from "@/lib/server/guards";

export default async function CustomerRechnungenPage() {
  await requireCustomerArea();
  return (
    <>
      <h1>Rechnungen</h1>
      <p className="muted">
        Rechnungen werden hier angezeigt, sobald die Rechnungsstellung im Kundenbereich
        freigeschaltet ist.
      </p>
    </>
  );
}
