import { hasGlobalPermission } from "@isela/auth";
import { listInvoicesForBooking } from "@isela/billing";
import { getBooking } from "@isela/operations";
import { isDomainError } from "@isela/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import { formatDateTime, formatMoney, formatTaxRate } from "@/lib/admin/format";
import {
  BOOKING_STATUS_LABELS,
  JOB_STATUS_LABELS,
  PAYMENT_REASON_LABELS,
  PAYMENT_REQUIREMENT_LABELS,
  INVOICE_KIND_LABELS,
  INVOICE_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  SERVICE_UNIT_LABELS,
  label,
} from "@/lib/admin/labels";
import { formatInTimeZone } from "@/lib/admin/time";
import { requireAdminArea } from "@/lib/server/guards";
import { loadOperationsConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";
import {
  cancelBookingAction,
  clearPaymentReviewAction,
  createInvoiceAction,
  createJobAction,
} from "./actions";

export const metadata: Metadata = { title: "Buchung" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BookingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "booking:read")) forbidden();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await getServiceContext();
  let booking;
  try {
    booking = await getBooking(ctx, { bookingId: id });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  const config = await loadOperationsConfig(ctx.db, ctx.clock);
  const query = await searchParams;
  const canReadInvoices = hasGlobalPermission(actor, "invoice:read");
  const invoices = canReadInvoices ? await listInvoicesForBooking(ctx, { bookingId: id }) : [];
  const hasActiveInvoice = invoices.some((i) => i.status !== "CANCELLED" && i.status !== "VOID");
  const canInvoice = hasGlobalPermission(actor, "invoice:write") && !hasActiveInvoice;
  const invoiceKind =
    booking.paymentRequirement === "VORKASSE_REQUIRED" && booking.status === "PENDING_PAYMENT"
      ? "PREPAYMENT"
      : booking.paymentRequirement === "CREDIT_TERMS_APPROVED" && booking.status === "COMPLETED"
        ? "FINAL"
        : null;
  const canClearReview =
    hasGlobalPermission(actor, "payment:manage") && booking.paymentReviewRequired;
  const canCancel =
    hasGlobalPermission(actor, "booking:write") &&
    booking.status !== "CANCELLED" &&
    booking.status !== "COMPLETED";
  const canPlanJob =
    hasGlobalPermission(actor, "job:write") &&
    booking.job === null &&
    (booking.status === "PENDING_PAYMENT" || booking.status === "CONFIRMED");
  const reasons = Array.isArray(booking.paymentDecision["reasons"])
    ? (booking.paymentDecision["reasons"] as string[])
    : [];

  return (
    <>
      <p>
        <Link href="/admin/bookings">← Alle Buchungen</Link> ·{" "}
        <Link href={`/admin/customers/${booking.customerId}`}>Kunde {booking.customerName}</Link>
        {booking.quoteId === null ? null : (
          <>
            {" "}
            · <Link href={`/admin/quotes/${booking.quoteId}`}>Angebot</Link>
          </>
        )}
      </p>
      <h1>
        Buchung {booking.id.slice(0, 8)}{" "}
        <span className="badge">{label(BOOKING_STATUS_LABELS, booking.status)}</span>
      </h1>
      <ActionResult query={query} />

      <div className="detail-grid">
        <section className="panel" aria-labelledby="booking-summary">
          <h2 id="booking-summary">Termin und Objekt</h2>
          <dl className="facts">
            <dt>Objekt</dt>
            <dd>{booking.propertyName}</dd>
            <dt>Adresse</dt>
            <dd>{booking.addressLine}</dd>
            <dt>Zeitfenster</dt>
            <dd>
              {formatInTimeZone(booking.windowStart, config.timeZone)} –{" "}
              {formatInTimeZone(booking.windowEnd, config.timeZone)}
            </dd>
            <dt>Dauer</dt>
            <dd>{booking.durationMinutes} min</dd>
            <dt>Quelle</dt>
            <dd>Angenommenes Angebot</dd>
            <dt>Operative Hinweise</dt>
            <dd>{booking.operationalNotes ?? "–"}</dd>
            {booking.cancellationReason === null ? null : (
              <>
                <dt>Stornogrund</dt>
                <dd>{booking.cancellationReason}</dd>
              </>
            )}
            <dt>Einsatz</dt>
            <dd>
              {booking.job === null ? (
                "noch nicht geplant"
              ) : (
                <Link href={`/admin/jobs/${booking.job.id}`}>
                  {label(JOB_STATUS_LABELS, booking.job.status)}
                </Link>
              )}
            </dd>
          </dl>
        </section>

        <section className="panel" aria-labelledby="payment-title">
          <h2 id="payment-title">Zahlung</h2>
          <dl className="facts">
            <dt>Bedingung</dt>
            <dd>{label(PAYMENT_REQUIREMENT_LABELS, booking.paymentRequirement)}</dd>
            <dt>Status</dt>
            <dd>
              {booking.paymentStatus === null
                ? "–"
                : label(PAYMENT_STATUS_LABELS, booking.paymentStatus)}
            </dd>
            <dt>Begründung</dt>
            <dd>
              {reasons.length === 0
                ? "–"
                : reasons.map((r) => label(PAYMENT_REASON_LABELS, r)).join("; ")}
            </dd>
          </dl>
          {booking.paymentReviewRequired ? (
            <p className="alert alert--error" role="note">
              Zahlungsprüfung offen (Zahlungsschutz: überfällige Rechnung, Rückbuchung oder
              widerrufener Rechnungskauf). Der Einsatz startet erst nach Abschluss der Prüfung.
            </p>
          ) : null}
          {canReadInvoices ? (
            <>
              <h3>Rechnungen</h3>
              {invoices.length === 0 ? (
                <p className="muted">Noch keine Rechnung.</p>
              ) : (
                <ul>
                  {invoices.map((invoice) => (
                    <li key={invoice.id}>
                      <Link href={`/admin/invoices/${invoice.id}`}>
                        {invoice.invoiceNumber ?? "Entwurf"}
                      </Link>{" "}
                      – {label(INVOICE_KIND_LABELS, invoice.kind)},{" "}
                      {label(INVOICE_STATUS_LABELS, invoice.status)}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
          {canInvoice && invoiceKind !== null ? (
            <form action={createInvoiceAction} className="form">
              <input type="hidden" name="bookingId" value={booking.id} />
              <input type="hidden" name="kind" value={invoiceKind} />
              <button className="button" type="submit">
                {invoiceKind === "PREPAYMENT"
                  ? "Vorkasse-Rechnung erzeugen"
                  : "Rechnung nach Leistung erzeugen"}
              </button>
            </form>
          ) : null}
          {canClearReview ? (
            <form action={clearPaymentReviewAction} className="form">
              <input type="hidden" name="bookingId" value={booking.id} />
              <div className="field">
                <label htmlFor="review-reason">Prüfvermerk (Pflicht)</label>
                <input id="review-reason" name="reason" required minLength={3} maxLength={1000} />
              </div>
              <button className="button button--secondary" type="submit">
                Zahlungsprüfung abschließen
              </button>
            </form>
          ) : null}
          <p className="hint">
            Es ist kein Zahlungsanbieter angebunden. Ein Zahlungseingang wird an der Rechnung
            erfasst und von der Buchhaltung bestätigt; erst eine vollständig bezahlte
            Vorkasse-Rechnung gibt die Buchung frei. Der Einsatz startet erst danach.
          </p>
        </section>
      </div>

      <section className="panel" aria-labelledby="items-title">
        <h2 id="items-title">Positionen (aus dem Angebot)</h2>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Pos.</th>
                <th scope="col">Leistung</th>
                <th scope="col">Menge</th>
                <th scope="col">USt.</th>
                <th scope="col">Netto</th>
              </tr>
            </thead>
            <tbody>
              {booking.items.map((item) => (
                <tr key={item.position}>
                  <td>{item.position}</td>
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
        </div>
        <dl className="facts">
          <dt>Netto</dt>
          <dd>{formatMoney(booking.netCents, booking.currency)}</dd>
          <dt>USt.</dt>
          <dd>{formatMoney(booking.taxCents, booking.currency)}</dd>
          <dt>Brutto</dt>
          <dd>
            <strong>{formatMoney(booking.grossCents, booking.currency)}</strong>
          </dd>
        </dl>
      </section>

      {canPlanJob ? (
        <section className="panel" aria-labelledby="job-title">
          <h2 id="job-title">Einsatz planen</h2>
          <form action={createJobAction} className="form">
            <input type="hidden" name="bookingId" value={booking.id} />
            <div className="field">
              <label htmlFor="job-notes">Operative Hinweise (optional)</label>
              <textarea id="job-notes" name="operationalNotes" rows={2} maxLength={2000} />
            </div>
            <button className="button" type="submit">
              Einsatz planen
            </button>
          </form>
        </section>
      ) : null}

      {canCancel ? (
        <section className="panel" aria-labelledby="cancel-title">
          <h2 id="cancel-title">Stornieren</h2>
          <form action={cancelBookingAction} className="form">
            <input type="hidden" name="bookingId" value={booking.id} />
            <div className="field">
              <label htmlFor="cancel-reason">Grund (Pflicht)</label>
              <input id="cancel-reason" name="reason" required minLength={3} maxLength={1000} />
            </div>
            <button className="button button--secondary" type="submit">
              Buchung stornieren
            </button>
          </form>
          <p className="hint">
            Zahlungen werden nicht automatisch erstattet (separater Schritt der Buchhaltung).
          </p>
        </section>
      ) : null}

      <section className="panel" aria-labelledby="history-title">
        <h2 id="history-title">Verlauf</h2>
        <ul>
          {booking.history.map((entry) => (
            <li key={`${entry.kind}-${entry.createdAt.toISOString()}-${entry.toStatus}`}>
              {formatDateTime(entry.createdAt)}: {entry.kind === "PAYMENT" ? "Zahlung" : "Buchung"}{" "}
              {entry.fromStatus === null
                ? ""
                : `${label(entry.kind === "PAYMENT" ? PAYMENT_STATUS_LABELS : BOOKING_STATUS_LABELS, entry.fromStatus)} → `}
              {label(
                entry.kind === "PAYMENT" ? PAYMENT_STATUS_LABELS : BOOKING_STATUS_LABELS,
                entry.toStatus,
              )}
              {entry.actorName === null ? "" : ` (${entry.actorName})`}
              {entry.note === null ? null : ` – ${entry.note}`}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
