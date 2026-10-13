import { listCustomerBookings } from "@isela/operations";
import Link from "next/link";
import { formatMoney } from "@/lib/admin/format";
import {
  BOOKING_STATUS_LABELS,
  PAYMENT_REQUIREMENT_LABELS,
  PAYMENT_STATUS_LABELS,
  label,
} from "@/lib/admin/labels";
import { formatInTimeZone } from "@/lib/admin/time";
import { requireCustomerArea } from "@/lib/server/guards";
import { loadOperationsConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";

export default async function CustomerTerminePage() {
  await requireCustomerArea();
  const ctx = await getServiceContext();
  // The domain service restricts the list to the customer's own bookings (OWN scope).
  const [page, config] = await Promise.all([
    listCustomerBookings(ctx, {}),
    loadOperationsConfig(ctx.db, ctx.clock),
  ]);
  return (
    <>
      <h1>Termine und Buchungen</h1>
      {page.items.length === 0 ? (
        <p className="muted">Sie haben noch keine Buchungen.</p>
      ) : (
        <table className="table">
          <caption className="muted">Ihre Buchungen</caption>
          <thead>
            <tr>
              <th scope="col">Termin</th>
              <th scope="col">Objekt</th>
              <th scope="col">Status</th>
              <th scope="col">Zahlung</th>
              <th scope="col">Betrag (brutto)</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((booking) => (
              <tr key={booking.id}>
                <td>
                  <Link href={`/customer/bookings/${booking.id}`}>
                    {formatInTimeZone(booking.windowStart, config.timeZone)}
                  </Link>
                </td>
                <td>{booking.propertyName}</td>
                <td>{label(BOOKING_STATUS_LABELS, booking.status)}</td>
                <td>
                  {booking.paymentStatus === null
                    ? label(PAYMENT_REQUIREMENT_LABELS, booking.paymentRequirement)
                    : label(PAYMENT_STATUS_LABELS, booking.paymentStatus)}
                </td>
                <td>{formatMoney(booking.grossCents, booking.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">
        Bei Vorkasse wird Ihr Termin verbindlich eingeplant, sobald der Zahlungseingang bestätigt
        ist. Eine Online-Zahlung ist noch nicht verfügbar.
      </p>
    </>
  );
}
