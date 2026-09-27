import Link from "next/link";
import { getCustomer } from "@isela/crm";
import { requireCustomerArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";

export default async function CustomerHomePage() {
  const { customerId } = await requireCustomerArea();
  const customer = await getCustomer(await getServiceContext(), { customerId });
  return (
    <>
      <h1>Willkommen, {customer.displayName}</h1>
      <p>Hier sehen Sie Ihre Anfragen und – sobald verfügbar – Angebote, Termine und Rechnungen.</p>
      <Link className="button" href="/anfrage">
        Neue Reinigung anfragen
      </Link>
    </>
  );
}
