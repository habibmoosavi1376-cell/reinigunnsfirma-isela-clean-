import Link from "next/link";
import { getCustomer } from "@isela/crm";
import { requireCustomerArea } from "@/lib/server/guards";
import { getServiceContext, getSessionUser } from "@/lib/server/session";

export default async function CustomerProfilePage() {
  const { customerId } = await requireCustomerArea();
  const [customer, user] = await Promise.all([
    getCustomer(await getServiceContext(), { customerId }),
    getSessionUser(),
  ]);
  return (
    <>
      <h1>Profil</h1>
      <dl>
        <dt>Kundenname</dt>
        <dd>{customer.displayName}</dd>
        {customer.companyName === null ? null : (
          <>
            <dt>Firma</dt>
            <dd>{customer.companyName}</dd>
          </>
        )}
        <dt>Anmelde-E-Mail</dt>
        <dd>{user?.email}</dd>
      </dl>
      <p>
        <Link href="/account/security">Sicherheit und Zwei-Faktor-Authentifizierung</Link>
      </p>
    </>
  );
}
