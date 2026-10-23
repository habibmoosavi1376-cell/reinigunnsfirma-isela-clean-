import Link from "next/link";
import { listQueryString } from "@/lib/admin/list-params";

/** Pagination links for back-office lists (only validated filter values are carried over). */
export function ListPagination({
  basePath,
  filters,
  page,
  total,
  pageSize,
}: {
  basePath: string;
  filters: Record<string, string>;
  page: number;
  total: number;
  pageSize: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="pagination" aria-label="Seiten">
      {page > 1 ? (
        <Link href={`${basePath}?${listQueryString(filters, page - 1)}`}>← Zurück</Link>
      ) : null}
      <span>
        Seite {page} von {pages}
      </span>
      {page < pages ? (
        <Link href={`${basePath}?${listQueryString(filters, page + 1)}`}>Weiter →</Link>
      ) : null}
    </nav>
  );
}
