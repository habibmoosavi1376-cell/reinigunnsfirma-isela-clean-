import { listCustomerContracts } from "@isela/operations";
import Link from "next/link";
import {
  CONTRACT_STATUS_LABELS,
  OCCURRENCE_STATUS_LABELS,
  RECURRENCE_FREQUENCY_LABELS,
  label,
} from "@/lib/admin/labels";
import { requireCustomerArea } from "@/lib/server/guards";
import { loadOperationsConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";

const formatDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-DE");
const formatMinute = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export default async function CustomerContractsPage() {
  await requireCustomerArea();
  const ctx = await getServiceContext();
  const config = await loadOperationsConfig(ctx.db, ctx.clock);
  // The domain service restricts the list to the customer's own contracts (OWN scope).
  const contracts = await listCustomerContracts(ctx, { timeZone: config.timeZone });
  return (
    <>
      <h1>Wiederkehrende Aufträge</h1>
      {contracts.length === 0 ? (
        <p className="muted">Sie haben keine wiederkehrenden Aufträge.</p>
      ) : (
        contracts.map((contract) => (
          <article
            key={contract.id}
            className="card"
            aria-label={`Auftrag ${contract.propertyName}`}
          >
            <h2>
              {contract.propertyName} – {label(CONTRACT_STATUS_LABELS, contract.status)}
            </h2>
            <dl>
              <dt>Intervall</dt>
              <dd>{label(RECURRENCE_FREQUENCY_LABELS, contract.frequency)}</dd>
              <dt>Zeitraum</dt>
              <dd>
                ab {formatDate(contract.startDate)}
                {contract.endDate === null ? "" : ` bis ${formatDate(contract.endDate)}`}
              </dd>
              <dt>Zeitfenster je Termin</dt>
              <dd>
                {formatMinute(contract.windowStartMinute)}–{formatMinute(contract.windowEndMinute)}{" "}
                Uhr
              </dd>
              {contract.pauses.length > 0 && (
                <>
                  <dt>Pausen</dt>
                  <dd>
                    {contract.pauses
                      .map((p) => `${formatDate(p.fromDate)}–${formatDate(p.toDate)}`)
                      .join(", ")}
                  </dd>
                </>
              )}
            </dl>
            {contract.upcoming.length === 0 ? (
              <p className="muted">Noch keine kommenden Termine eingeplant.</p>
            ) : (
              <ul>
                {contract.upcoming.map((o) => (
                  <li key={o.date}>
                    {formatDate(o.date)}:{" "}
                    {o.bookingId === null ? (
                      label(OCCURRENCE_STATUS_LABELS, o.status)
                    ) : (
                      <Link href={`/customer/bookings/${o.bookingId}`}>
                        {label(OCCURRENCE_STATUS_LABELS, o.status)}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))
      )}
      <p className="hint">
        Änderungen, Pausen oder Kündigung bitte direkt mit uns abstimmen. Jeder Termin wird bei
        Vorkasse erst nach bestätigtem Zahlungseingang verbindlich.
      </p>
    </>
  );
}
