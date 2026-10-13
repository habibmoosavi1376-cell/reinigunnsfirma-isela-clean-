import { hasGlobalPermission } from "@isela/auth";
import {
  PAYMENT_METHODS,
  PAYMENT_RECORD_STATUSES,
  listPayments,
  paymentListQuerySchema,
} from "@isela/billing";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { ListPagination } from "@/components/admin/list-pagination";
import { formatDate, formatMoney } from "@/lib/admin/format";
import { PAYMENT_METHOD_LABELS, PAYMENT_RECORD_STATUS_LABELS, label } from "@/lib/admin/labels";
import { parseListParams, type SearchParams } from "@/lib/admin/list-params";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Zahlungen" };

type PaymentQuery = ReturnType<typeof paymentListQuerySchema.parse>;

export default async function PaymentListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "invoice:read")) forbidden();
  const { query, raw } = parseListParams<PaymentQuery>(
    await searchParams,
    ["status", "method", "customerId", "invoiceId"],
    paymentListQuerySchema,
  );
  const ctx = await getServiceContext();
  const page = await listPayments(ctx, query ?? {});
  const filters = query === null ? {} : raw;

  return (
    <>
      <h1>Zahlungen</h1>
      <p className="hint">
        Kein Zahlungsanbieter ist aktiv. Zahlungseingänge werden an der Rechnung mit eindeutiger
        Referenz erfasst und von der Buchhaltung bestätigt – nichts wird automatisch als bezahlt
        markiert.
      </p>
      {query === null ? (
        <p className="alert alert--error" role="alert">
          Die Filter waren ungültig und wurden zurückgesetzt.
        </p>
      ) : null}
      <form className="filters" method="get" aria-label="Zahlungen filtern">
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">Alle</option>
            {PAYMENT_RECORD_STATUSES.map((status) => (
              <option key={status} value={status}>
                {label(PAYMENT_RECORD_STATUS_LABELS, status)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="method">Zahlungsart</label>
          <select id="method" name="method" defaultValue={filters.method ?? ""}>
            <option value="">Alle</option>
            {PAYMENT_METHODS.map((method) => (
              <option key={method} value={method}>
                {label(PAYMENT_METHOD_LABELS, method)}
              </option>
            ))}
          </select>
        </div>
        <div className="cta-row">
          <button className="button" type="submit">
            Filtern
          </button>
          <Link href="/admin/payments">Zurücksetzen</Link>
        </div>
      </form>
      <p className="muted" aria-live="polite">
        {page.total === 0
          ? "Keine Zahlungen gefunden."
          : `${String(page.total)} Zahlung(en) gefunden.`}
      </p>
      {page.items.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Eingang</th>
                <th scope="col">Rechnung</th>
                <th scope="col">Kunde</th>
                <th scope="col">Art</th>
                <th scope="col">Betrag</th>
                <th scope="col">Zugeordnet</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((payment) => (
                <tr key={payment.id}>
                  <td>{formatDate(payment.receivedAt)}</td>
                  <td>
                    <Link href={`/admin/invoices/${payment.invoiceId}`}>
                      {payment.invoiceNumber ?? "Entwurf"}
                    </Link>
                  </td>
                  <td>{payment.customerName}</td>
                  <td>{label(PAYMENT_METHOD_LABELS, payment.method)}</td>
                  <td>{formatMoney(payment.amountCents, payment.currency)}</td>
                  <td>{formatMoney(payment.appliedCents, payment.currency)}</td>
                  <td>{label(PAYMENT_RECORD_STATUS_LABELS, payment.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ListPagination
        basePath="/admin/payments"
        filters={filters}
        page={page.page}
        total={page.total}
        pageSize={page.pageSize}
      />
    </>
  );
}
