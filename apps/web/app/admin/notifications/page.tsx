import { hasGlobalPermission } from "@isela/auth";
import {
  NOTIFICATION_REVIEW_STATUSES,
  NOTIFICATION_STATUSES,
  listNotifications,
  notificationListQuerySchema,
} from "@isela/operations";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import { ListPagination } from "@/components/admin/list-pagination";
import { formatDateTime } from "@/lib/admin/format";
import {
  NOTIFICATION_ERROR_LABELS,
  NOTIFICATION_PURPOSE_LABELS,
  NOTIFICATION_STATUS_LABELS,
  label,
} from "@/lib/admin/labels";
import { parseListParams, type SearchParams } from "@/lib/admin/list-params";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";
import { reviewNotificationAction } from "./actions";

export const metadata: Metadata = { title: "Benachrichtigungen" };

type NotificationQuery = ReturnType<typeof notificationListQuerySchema.parse>;

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "booking:read")) forbidden();
  const params = await searchParams;
  const { query, raw } = parseListParams<NotificationQuery>(
    params,
    ["status"],
    notificationListQuerySchema,
  );
  const ctx = await getServiceContext();
  const page = await listNotifications(ctx, query ?? {});
  const filters = query === null ? {} : raw;
  const canReview = hasGlobalPermission(actor, "booking:write");
  const reviewCount = NOTIFICATION_REVIEW_STATUSES.reduce(
    (sum, s) => sum + (page.counts[s] ?? 0),
    0,
  );

  return (
    <>
      <h1>Benachrichtigungen</h1>
      <ActionResult query={params} />
      <p className="hint">
        Terminerinnerungen an verifizierte Kundenkonten. Der Versand läuft bis zur Freigabe eines
        Versanddienstes ausschließlich im Testmodus. Adressen und Inhalte werden hier nicht
        angezeigt.
      </p>
      <p>
        Manuelle Prüfung erforderlich: <strong>{reviewCount}</strong>
      </p>
      <ul className="inline-list" aria-label="Anzahl je Status">
        {NOTIFICATION_STATUSES.map((s) => (
          <li key={s}>
            <Link href={`/admin/notifications?status=${s}`}>
              {label(NOTIFICATION_STATUS_LABELS, s)}: {page.counts[s] ?? 0}
            </Link>
          </li>
        ))}
      </ul>
      {query === null ? (
        <p className="alert alert--error" role="alert">
          Die Filter waren ungültig und wurden zurückgesetzt.
        </p>
      ) : null}
      {page.items.length === 0 ? (
        <p className="muted">Keine Benachrichtigungen.</p>
      ) : (
        <table className="table">
          <caption className="visually-hidden">Benachrichtigungen</caption>
          <thead>
            <tr>
              <th scope="col">Erstellt</th>
              <th scope="col">Art</th>
              <th scope="col">Kunde</th>
              <th scope="col">Status</th>
              <th scope="col">Versuche</th>
              <th scope="col">Hinweis</th>
              <th scope="col">Prüfung</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((n) => (
              <tr key={n.id}>
                <td>{formatDateTime(n.createdAt)}</td>
                <td>
                  {label(NOTIFICATION_PURPOSE_LABELS, n.purpose)}
                  {n.bookingId === null ? null : (
                    <>
                      {" "}
                      (<Link href={`/admin/bookings/${n.bookingId}`}>Buchung</Link>)
                    </>
                  )}
                </td>
                <td>
                  <Link href={`/admin/customers/${n.customerId}`}>{n.customerName}</Link>
                </td>
                <td>
                  <span className="badge">{label(NOTIFICATION_STATUS_LABELS, n.status)}</span>
                </td>
                <td>{n.attempts}</td>
                <td>
                  {n.lastErrorCode === null
                    ? "–"
                    : label(NOTIFICATION_ERROR_LABELS, n.lastErrorCode)}
                </td>
                <td>
                  {canReview && NOTIFICATION_REVIEW_STATUSES.includes(n.status) ? (
                    <form
                      action={reviewNotificationAction}
                      className="form"
                      aria-label="Benachrichtigung prüfen"
                    >
                      <input type="hidden" name="notificationId" value={n.id} />
                      <input type="hidden" name="expectedStatus" value={n.status} />
                      <div className="field">
                        <label htmlFor={`action-${n.id}`}>Aktion</label>
                        <select id={`action-${n.id}`} name="action" required>
                          <option value="DISMISS">Schließen</option>
                          <option value="REQUEUE">Erneut versenden</option>
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor={`reason-${n.id}`}>Begründung</label>
                        <input
                          id={`reason-${n.id}`}
                          name="reason"
                          required
                          minLength={3}
                          maxLength={500}
                        />
                      </div>
                      {n.status === "UNCERTAIN" ? (
                        <div className="field">
                          <label>
                            <input type="checkbox" name="confirmPossibleDuplicate" value="yes" />{" "}
                            Zustellung geprüft – eine doppelte Nachricht ist möglich
                          </label>
                        </div>
                      ) : null}
                      <button className="button button--secondary" type="submit">
                        Übernehmen
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ListPagination
        basePath="/admin/notifications"
        filters={filters}
        page={page.page}
        total={page.total}
        pageSize={page.pageSize}
      />
    </>
  );
}
