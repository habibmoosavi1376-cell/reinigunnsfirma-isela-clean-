import { crmErrorText, crmNoticeText } from "@/lib/admin/crm-actions";

/** Shows the whitelisted result of a server action (?notice= / ?error=). */
export function ActionResult({ query }: { query: Record<string, string | string[] | undefined> }) {
  const notice = crmNoticeText(query["notice"]);
  const error = crmErrorText(query["error"]);
  return (
    <>
      {notice === null ? null : (
        <p className="alert alert--success" role="status">
          {notice}
        </p>
      )}
      {error === null ? null : (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
