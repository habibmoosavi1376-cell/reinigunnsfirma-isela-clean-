import { hasGlobalPermission } from "@isela/auth";
import { getPriceRuleSet, listPriceRuleSets } from "@isela/pricing";
import { isDomainError } from "@isela/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import { formatDateTime } from "@/lib/admin/format";
import { RULE_SET_STATUS_LABELS, label } from "@/lib/admin/labels";
import { firstParam } from "@/lib/admin/list-params";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";
import { activateAction, createDraftAction, updateDraftAction } from "./actions";

export const metadata: Metadata = { title: "Preisregeln" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "pricing:read")) forbidden();
  const ctx = await getServiceContext();
  const query = await searchParams;
  const selectedId = firstParam(query["ruleSet"]);
  const ruleSets = await listPriceRuleSets(ctx);
  let selected = null;
  if (selectedId !== undefined && UUID.test(selectedId)) {
    try {
      selected = await getPriceRuleSet(ctx, { ruleSetId: selectedId });
    } catch (error) {
      if (!isDomainError(error, "NOT_FOUND")) throw error;
    }
  }
  const canManage = hasGlobalPermission(actor, "pricing:manage");
  const canApprove = hasGlobalPermission(actor, "pricing:approve");

  return (
    <>
      <h1>Preisregeln</h1>
      <ActionResult query={query} />
      <p className="hint">
        Preisregeln sind versionierte Geschäftsdaten. Werte, die der Inhaber noch nicht festgelegt
        hat, bleiben „CONFIG_REQUIRED“ – die Pricing Engine liefert dann keinen Preis. Eine
        aktivierte Version ist unveränderlich; bestehende Angebote behalten ihre Version.
      </p>
      {ruleSets.length === 0 ? (
        <p className="muted">
          Noch keine Preisregeln angelegt. Ohne aktive Preisregeln werden alle Preise manuell
          erfasst.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Status</th>
                <th scope="col">Geltungsbereich</th>
                <th scope="col">Offene Werte</th>
                <th scope="col">Aktiviert</th>
                <th scope="col">Änderungsgrund</th>
              </tr>
            </thead>
            <tbody>
              {ruleSets.map((ruleSet) => (
                <tr key={ruleSet.id}>
                  <td>
                    <Link href={`/admin/pricing?ruleSet=${ruleSet.id}`}>r{ruleSet.version}</Link>
                  </td>
                  <td>
                    <span className="badge">{label(RULE_SET_STATUS_LABELS, ruleSet.status)}</span>
                  </td>
                  <td>{ruleSet.serviceAreaName ?? "Standard"}</td>
                  <td>{ruleSet.configRequired.length}</td>
                  <td>{formatDateTime(ruleSet.activatedAt)}</td>
                  <td>{ruleSet.changeReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected === null ? null : (
        <section className="panel" aria-labelledby="rule-set-title">
          <h2 id="rule-set-title">
            Version r{selected.version} ({label(RULE_SET_STATUS_LABELS, selected.status)})
          </h2>
          {selected.configRequired.length === 0 ? null : (
            <details>
              <summary>{selected.configRequired.length} offene Werte (CONFIG_REQUIRED)</summary>
              <ul>
                {selected.configRequired.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {selected.status === "DRAFT" && canManage ? (
            <form action={updateDraftAction} className="form">
              <input type="hidden" name="ruleSetId" value={selected.id} />
              <div className="field">
                <label htmlFor="rules-json">
                  Regeldokument (JSON, Beträge in Cent, Anpassungen in Basispunkten)
                </label>
                <textarea
                  id="rules-json"
                  name="rules"
                  rows={24}
                  spellCheck={false}
                  defaultValue={JSON.stringify(selected.rules, null, 2)}
                />
              </div>
              <div className="field">
                <label htmlFor="rules-reason">Änderungsgrund</label>
                <input
                  id="rules-reason"
                  name="changeReason"
                  required
                  minLength={3}
                  maxLength={1000}
                />
              </div>
              <button className="button" type="submit">
                Entwurf speichern
              </button>
            </form>
          ) : (
            <pre className="code-block">{JSON.stringify(selected.rules, null, 2)}</pre>
          )}
          {selected.status === "DRAFT" && canApprove ? (
            <form action={activateAction} className="form">
              <input type="hidden" name="ruleSetId" value={selected.id} />
              <button className="button" type="submit">
                Version aktivieren
              </button>
              <p className="hint">
                Ersetzt die aktive Version desselben Geltungsbereichs. Die Aktivierung ist eine
                Geschäftsentscheidung und wird auditiert.
              </p>
            </form>
          ) : null}
        </section>
      )}

      {canManage ? (
        <section className="panel" aria-labelledby="new-rule-set">
          <h2 id="new-rule-set">Neuen Entwurf anlegen</h2>
          <form action={createDraftAction} className="form">
            <div className="field">
              <label htmlFor="draft-source">Grundlage</label>
              <select id="draft-source" name="source" defaultValue="empty">
                <option value="empty">Leere Vorlage (alle Werte CONFIG_REQUIRED)</option>
                <option value="active">Kopie der aktiven Standardversion</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="draft-reason">Änderungsgrund</label>
              <input
                id="draft-reason"
                name="changeReason"
                required
                minLength={3}
                maxLength={1000}
              />
            </div>
            <button className="button" type="submit">
              Entwurf anlegen
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}
