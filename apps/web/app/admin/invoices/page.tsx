import { hasGlobalPermission } from "@isela/auth";
import {
  INVOICE_KINDS,
  INVOICE_STATUSES,
  invoiceListQuerySchema,
  listInvoices,
} from "@isela/billing";
import { businessDateOf } from "@isela/payment-risk";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { ListPagination } from "@/components/admin/list-pagination";
import { formatDate, formatMoney, parseMoneyToCents } from "@/lib/admin/format";
import { INVOICE_KIND_LABELS, INVOICE_STATUS_LABELS, label } from "@/lib/admin/labels";
import { firstParam, type SearchParams } from "@/lib/admin/list-params";
import { requireAdminArea } from "@/lib/server/guards";
import { loadOperationsConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Rechnungen" };

const FILTER_KEYS = [
  "status",
  "kind",
  "number",
  "customerId",
  "overdue",
  "dueFrom",
  "dueTo",
  "minGross",
  "maxGross",
] as const;

/** Pre-shapes the filters (amounts in € → cents); the domain schema validates everything. */
function parseFilters(params: SearchParams) {
  const raw: Record<string, string> = {};
  const input: Record<string, unknown> = {};
  let valid = true;
  for (const key of FILTER_KEYS) {
    const value = firstParam(params[key]);
    if (value === undefined) continue;
    raw[key] = value;
    if (key === "overdue") {
      input["overdue"] = value === "1";
    } else if (key === "minGross" || key === "maxGross") {
      const cents = parseMoneyToCents(value);
      if (cents === null) valid = false;
      else input[key === "minGross" ? "minGrossCents" : "maxGrossCents"] = cents;
    } else {
      input[key] = key === "number" ? value.toUpperCase() : value;
    }
  }
  const page = firstParam(params["page"]);
  if (page !== undefined) input["page"] = /^\d{1,6}$/.test(page) ? Number(page) : Number.NaN;
  const parsed = invoiceListQuerySchema.safeParse(input);
  return { query: valid && parsed.success ? parsed.data : null, raw };
}

export default async function InvoiceListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "invoice:read")) forbidden();
  const { query, raw } = parseFilters(await searchParams);
  const ctx = await getServiceContext();
  const config = await loadOperationsConfig(ctx.db, ctx.clock);
  const today = businessDateOf(ctx.clock.now(), config.timeZone);
  const page = await listInvoices(ctx, query ?? {}, today);
  const filters = query === null ? {} : raw;

  return (
    <>
      <h1>Rechnungen</h1>
      <p className="hint">
        Rechnungen entstehen nur serverseitig aus Buchungen (Buchungsdetail → „Rechnung erzeugen“).
        Nummern vergibt das System beim Ausstellen; bezahlt ist eine Rechnung erst nach bestätigtem
        Zahlungseingang.
      </p>
      {query === null ? (
        <p className="alert alert--error" role="alert">
          Die Filter waren ungültig und wurden zurückgesetzt.
        </p>
      ) : null}
      <form className="filters" method="get" aria-label="Rechnungen filtern">
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">Alle</option>
            {INVOICE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {label(INVOICE_STATUS_LABELS, status)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="kind">Art</label>
          <select id="kind" name="kind" defaultValue={filters.kind ?? ""}>
            <option value="">Alle</option>
            {INVOICE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {label(INVOICE_KIND_LABELS, kind)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="number">Rechnungsnummer (Anfang)</label>
          <input id="number" name="number" maxLength={40} defaultValue={filters.number ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="dueFrom">Fällig ab</label>
          <input id="dueFrom" name="dueFrom" type="date" defaultValue={filters.dueFrom ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="dueTo">Fällig bis</label>
          <input id="dueTo" name="dueTo" type="date" defaultValue={filters.dueTo ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="minGross">Betrag ab (€)</label>
          <input
            id="minGross"
            name="minGross"
            inputMode="decimal"
            maxLength={14}
            defaultValue={filters.minGross ?? ""}
          />
        </div>
        <div className="field">
          <label htmlFor="maxGross">Betrag bis (€)</label>
          <input
            id="maxGross"
            name="maxGross"
            inputMode="decimal"
            maxLength={14}
            defaultValue={filters.maxGross ?? ""}
          />
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            name="overdue"
            value="1"
            defaultChecked={filters.overdue === "1"}
          />{" "}
          Nur überfällige
        </label>
        {filters.customerId === undefined ? null : (
          <input type="hidden" name="customerId" value={filters.customerId} />
        )}
        <div className="cta-row">
          <button className="button" type="submit">
            Filtern
          </button>
          <Link href="/admin/invoices">Zurücksetzen</Link>
        </div>
      </form>
      <p className="muted" aria-live="polite">
        {page.total === 0
          ? "Keine Rechnungen gefunden."
          : `${String(page.total)} Rechnung(en) gefunden.`}
      </p>
      {page.items.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Nummer</th>
                <th scope="col">Kunde</th>
                <th scope="col">Art</th>
                <th scope="col">Status</th>
                <th scope="col">Fällig</th>
                <th scope="col">Brutto</th>
                <th scope="col">Offen</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((invoice) => (
                <tr key={invoice.id}>
                  <td>
                    <Link href={`/admin/invoices/${invoice.id}`}>
                      {invoice.invoiceNumber ?? "Entwurf"}
                    </Link>
                  </td>
                  <td>{invoice.customerName}</td>
                  <td>{label(INVOICE_KIND_LABELS, invoice.kind)}</td>
                  <td>{label(INVOICE_STATUS_LABELS, invoice.status)}</td>
                  <td>{formatDate(invoice.dueDate)}</td>
                  <td>{formatMoney(invoice.grossCents, invoice.currency)}</td>
                  <td>
                    {invoice.status === "VOID" || invoice.status === "CANCELLED"
                      ? "–"
                      : formatMoney(invoice.grossCents - invoice.paidCents, invoice.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ListPagination
        basePath="/admin/invoices"
        filters={filters}
        page={page.page}
        total={page.total}
        pageSize={page.pageSize}
      />
    </>
  );
}
