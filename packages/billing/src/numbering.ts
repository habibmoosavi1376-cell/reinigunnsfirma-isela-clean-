import { sql, type Transaction } from "@isela/database";
import { DomainError } from "@isela/shared";

/*
 * Invoice numbers: `<PREFIX>-<YEAR>-<SEQUENCE>` (sequence zero-padded to six digits).
 * - assigned only on the server, inside the issuing transaction;
 * - per series (prefix) and calendar year of the issue date (business time zone), so a new
 *   year starts a new sequence without colliding with the previous one;
 * - taken with an atomic UPSERT on `invoice_number_counter`: concurrent issuers queue on the
 *   counter row, a rollback also rolls the counter back (no gaps from failed issuances,
 *   no reuse, never `count + 1`);
 * - `invoice_number_uq` is the final guard against any collision.
 */

export function formatInvoiceNumber(prefix: string, year: number, sequence: number): string {
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(prefix)) {
    throw new DomainError("VALIDATION_FAILED", "Invalid invoice number prefix");
  }
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new DomainError("VALIDATION_FAILED", "Invalid invoice year");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new DomainError("VALIDATION_FAILED", "Invalid invoice sequence");
  }
  return `${prefix}-${String(year)}-${String(sequence).padStart(6, "0")}`;
}

export async function nextInvoiceNumber(
  tx: Transaction,
  prefix: string,
  issueDate: string,
): Promise<string> {
  const year = Number(issueDate.slice(0, 4));
  const result = await tx.execute(sql`
    INSERT INTO "invoice_number_counter" ("series_key", "year", "last_value", "updated_at")
    VALUES (${prefix}, ${year}, 1, now())
    ON CONFLICT ("series_key", "year")
    DO UPDATE SET "last_value" = "invoice_number_counter"."last_value" + 1, "updated_at" = now()
    RETURNING "last_value"
  `);
  const value = Number((result.rows[0] as { last_value?: unknown } | undefined)?.last_value);
  return formatInvoiceNumber(prefix, year, value);
}
