import { listCustomerServiceRequests } from "@isela/crm";
import { requireCustomerArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";

const FREQUENCY_LABEL: Record<string, string> = {
  ONCE: "Einmalig",
  WEEKLY: "Wöchentlich",
  BIWEEKLY: "Zweiwöchentlich",
  MONTHLY: "Monatlich",
  CUSTOM: "Individuell",
};

export default async function CustomerRequestsPage() {
  const { customerId } = await requireCustomerArea();
  // The domain service authorizes again (OWN scope) – the page never queries the DB itself.
  const requests = await listCustomerServiceRequests(await getServiceContext(), { customerId });
  return (
    <>
      <h1>Ihre Anfragen</h1>
      {requests.length === 0 ? (
        <p className="muted">Sie haben noch keine Anfragen gestellt.</p>
      ) : (
        <table className="table">
          <caption className="muted">Anfragen, die Sie angemeldet gestellt haben</caption>
          <thead>
            <tr>
              <th scope="col">Datum</th>
              <th scope="col">Leistung</th>
              <th scope="col">Häufigkeit</th>
              <th scope="col">Bearbeitungsstand</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id}>
                <td>{request.createdAt.toLocaleDateString("de-DE")}</td>
                <td>{request.serviceName}</td>
                <td>{FREQUENCY_LABEL[request.frequency] ?? request.frequency}</td>
                <td>
                  {request.status === "LOST"
                    ? "Abgeschlossen"
                    : request.status === "WON"
                      ? "Beauftragt"
                      : "In Bearbeitung"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
