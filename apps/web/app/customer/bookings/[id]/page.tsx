import { getCustomerBooking } from "@isela/operations";
import { isDomainError } from "@isela/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatMoney, formatTaxRate } from "@/lib/admin/format";
import {
  BOOKING_STATUS_LABELS,
  PAYMENT_REQUIREMENT_LABELS,
  PAYMENT_STATUS_LABELS,
  SERVICE_UNIT_LABELS,
  label,
} from "@/lib/admin/labels";
import { formatInTimeZone } from "@/lib/admin/time";
import { requireCustomerArea } from "@/lib/server/guards";
import { loadOperationsConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Customer booking view. Only the customer-facing projection is loaded: no staff or partner
 * names, no internal notes, costs or margins. Foreign ids are NOT_FOUND (HTTP 404).
 */
export default async function CustomerBookingPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCustomerArea();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await getServiceContext();
  let booking;
  try {
    booking = await getCustomerBooking(ctx, { bookingId: id });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  const config = await loadOperationsConfig(ctx.db, ctx.clock);
  return (
    <>
      <p>
        <Link href="/customer/jobs">← Alle Termine</Link>
      </p>
      <h1>Buchung für {booking.propertyName}</h1>
      <dl className="facts">
        <dt>Status</dt>
        <dd>{label(BOOKING_STATUS_LABELS, booking.status)}</dd>
        <dt>Termin</dt>
        <dd>
          {formatInTimeZone(booking.windowStart, config.timeZone)} –{" "}
          {formatInTimeZone(booking.windowEnd, config.timeZone)}
        </dd>
        <dt>Dauer</dt>
        <dd>{booking.durationMinutes} Minuten</dd>
        <dt>Adresse</dt>
        <dd>{booking.addressLine}</dd>
        <dt>Zahlungsbedingung</dt>
        <dd>{label(PAYMENT_REQUIREMENT_LABELS, booking.paymentRequirement)}</dd>
        <dt>Zahlungsstatus</dt>
        <dd>
          {booking.paymentStatus === null
            ? "–"
            : label(PAYMENT_STATUS_LABELS, booking.paymentStatus)}
        </dd>
      </dl>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Leistung</th>
            <th scope="col">Menge</th>
            <th scope="col">USt.</th>
            <th scope="col">Netto</th>
          </tr>
        </thead>
        <tbody>
          {booking.items.map((item) => (
            <tr key={item.position}>
              <td>{item.description}</td>
              <td>
                {item.quantity.toLocaleString("de-DE")} {label(SERVICE_UNIT_LABELS, item.unit)}
              </td>
              <td>{formatTaxRate(item.taxRateBasisPoints)}</td>
              <td>{formatMoney(item.netCents, booking.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="facts">
        <dt>Summe netto</dt>
        <dd>{formatMoney(booking.netCents, booking.currency)}</dd>
        <dt>Umsatzsteuer</dt>
        <dd>{formatMoney(booking.taxCents, booking.currency)}</dd>
        <dt>Summe brutto</dt>
        <dd>
          <strong>{formatMoney(booking.grossCents, booking.currency)}</strong>
        </dd>
      </dl>
    </>
  );
}
