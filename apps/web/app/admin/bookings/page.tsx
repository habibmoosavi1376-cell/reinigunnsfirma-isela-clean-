import { hasGlobalPermission } from "@isela/auth";
import { BOOKING_STATUSES, bookingListQuerySchema, listBookings } from "@isela/operations";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { ListPagination } from "@/components/admin/list-pagination";
import { formatMoney } from "@/lib/admin/format";
import {
  BOOKING_STATUS_LABELS,
  PAYMENT_REQUIREMENT_LABELS,
  PAYMENT_STATUS_LABELS,
  label,
} from "@/lib/admin/labels";
import { parseListParams, type SearchParams } from "@/lib/admin/list-params";
import { formatInTimeZone } from "@/lib/admin/time";
import { requireAdminArea } from "@/lib/server/guards";
import { loadOperationsConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Buchungen" };

type BookingQuery = ReturnType<typeof bookingListQuerySchema.parse>;

export default async function BookingListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "booking:read")) forbidden();
  const { query, raw } = parseListParams<BookingQuery>(
    await searchParams,
    ["status", "customerId"],
    bookingListQuerySchema,
  );
  const ctx = await getServiceContext();
  const [page, config] = await Promise.all([
    listBookings(ctx, query ?? {}),
    loadOperationsConfig(ctx.db, ctx.clock),
  ]);
  const filters = query === null ? {} : raw;

  return (
    <>
      <h1>Buchungen</h1>
      <p className="hint">
        Buchungen entstehen ausschließlich aus angenommenen Angeboten (Angebotsdetail → „Buchung
        anlegen“). Ohne freigegebene Kreditbedingungen gilt Vorkasse.
      </p>
      {query === null ? (
        <p className="alert alert--error" role="alert">
          Die Filter waren ungültig und wurden zurückgesetzt.
        </p>
      ) : null}
      <form className="filters" method="get" aria-label="Buchungen filtern">
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">Alle</option>
            {BOOKING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {label(BOOKING_STATUS_LABELS, status)}
              </option>
            ))}
          </select>
        </div>
        <div className="cta-row">
          <button className="button" type="submit">
            Filtern
          </button>
          <Link href="/admin/bookings">Zurücksetzen</Link>
        </div>
      </form>
      <p className="muted" aria-live="polite">
        {page.total === 0
          ? "Keine Buchungen gefunden."
          : `${String(page.total)} Buchung(en) gefunden.`}
      </p>
      {page.items.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <caption className="muted">Buchungen, späteste Termine zuerst</caption>
            <thead>
              <tr>
                <th scope="col">Termin</th>
                <th scope="col">Kunde</th>
                <th scope="col">Objekt</th>
                <th scope="col">Status</th>
                <th scope="col">Zahlung</th>
                <th scope="col">Brutto</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((booking) => (
                <tr key={booking.id}>
                  <td>
                    <Link href={`/admin/bookings/${booking.id}`}>
                      {formatInTimeZone(booking.windowStart, config.timeZone)}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/admin/customers/${booking.customerId}`}>
                      {booking.customerName}
                    </Link>
                  </td>
                  <td>{booking.propertyName}</td>
                  <td>
                    <span className="badge">{label(BOOKING_STATUS_LABELS, booking.status)}</span>
                  </td>
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
        </div>
      ) : null}
      <ListPagination
        basePath="/admin/bookings"
        filters={filters}
        page={page.page}
        total={page.total}
        pageSize={page.pageSize}
      />
    </>
  );
}
