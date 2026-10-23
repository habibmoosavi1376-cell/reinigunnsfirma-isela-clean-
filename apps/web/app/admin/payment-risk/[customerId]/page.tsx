import { hasGlobalPermission } from "@isela/auth";
import { getCustomerRiskProfile } from "@isela/billing";
import { isDomainError } from "@isela/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import { formatDate, formatDateTime, formatMoney } from "@/lib/admin/format";
import {
  CREDIT_TERMS_STATUS_LABELS,
  PAYMENT_OUTCOME_LABELS,
  PAYMENT_REASON_LABELS,
  label,
} from "@/lib/admin/labels";
import { loadFinanceOptions } from "@/lib/server/finance";
import { requireAdminArea } from "@/lib/server/guards";
import { getServiceContext } from "@/lib/server/session";
import {
  approveCreditAction,
  denyCreditAction,
  reevaluateAction,
  requestCreditAction,
  revokeCreditAction,
} from "../actions";

export const metadata: Metadata = { title: "Zahlungsrisiko Kunde" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CustomerRiskPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "payment_risk:read")) forbidden();
  const { customerId } = await params;
  if (!UUID.test(customerId)) notFound();
  const ctx = await getServiceContext();
  const options = await loadFinanceOptions(ctx.db, ctx.clock);
  let profile;
  try {
    profile = await getCustomerRiskProfile(ctx, { customerId }, options);
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  const query = await searchParams;
  const canRequest = hasGlobalPermission(actor, "credit_terms:request");
  const canApprove = hasGlobalPermission(actor, "credit_terms:approve");
  const open = profile.approvals.find((a) => a.status === "REQUESTED");
  const active = profile.approvals.find((a) => a.status === "APPROVED");
  const { decision, facts } = profile;
  const policy = options.paymentPolicy.policy;
  const eur = (cents: number) => formatMoney(cents, "EUR");

  return (
    <>
      <p>
        <Link href="/admin/payment-risk">← Zahlungsrisiko</Link> ·{" "}
        <Link href={`/admin/customers/${profile.customerId}`}>Kundenakte</Link> ·{" "}
        <Link href={`/admin/invoices?customerId=${profile.customerId}`}>Rechnungen</Link>
      </p>
      <h1>
        Zahlungsrisiko: {profile.customerName}{" "}
        <span className="badge">{label(PAYMENT_OUTCOME_LABELS, decision.outcome)}</span>
      </h1>
      <ActionResult query={query} />

      <div className="detail-grid">
        <section className="panel" aria-labelledby="decision-title">
          <h2 id="decision-title">Aktuelle Zahlungsbedingung</h2>
          <p>
            <strong>{label(PAYMENT_OUTCOME_LABELS, decision.outcome)}</strong>
          </p>
          <ul>
            {decision.reasons.map((reason) => (
              <li key={reason}>{label(PAYMENT_REASON_LABELS, reason)}</li>
            ))}
          </ul>
          <dl className="facts">
            <dt>Kreditrahmen</dt>
            <dd>
              {decision.creditLimitCents === null ? "keiner" : eur(decision.creditLimitCents)}
            </dd>
            <dt>Verfügbar</dt>
            <dd>
              {decision.availableCreditCents === null ? "–" : eur(decision.availableCreditCents)}
            </dd>
            <dt>Richtlinie</dt>
            <dd>
              {profile.policyVersion === null ? "Standard" : `Version ${profile.policyVersion}`}
              {` (mind. ${String(policy.minSuccessfulPaidOrders)} bezahlte Aufträge)`}
            </dd>
            <dt>Letzte Bewertung</dt>
            <dd>
              {profile.lastEvaluation === null
                ? "noch keine gespeichert"
                : `${formatDateTime(profile.lastEvaluation.evaluatedAt)} (${label(
                    PAYMENT_OUTCOME_LABELS,
                    profile.lastEvaluation.outcome,
                  )})`}
            </dd>
          </dl>
          {canRequest ? (
            <form action={reevaluateAction} className="form">
              <input type="hidden" name="customerId" value={profile.customerId} />
              <button className="button button--secondary" type="submit">
                Neu bewerten
              </button>
            </form>
          ) : null}
        </section>

        <section className="panel" aria-labelledby="facts-title">
          <h2 id="facts-title">Zahlungshistorie</h2>
          <dl className="facts">
            <dt>Abgeschlossene Aufträge</dt>
            <dd>{facts.completedJobs}</dd>
            <dt>Davon vollständig bezahlt</dt>
            <dd>{facts.completedPaidJobs}</dd>
            <dt>Fehlgeschlagene Zahlungen</dt>
            <dd>{facts.failedPayments}</dd>
            <dt>Rückbuchungen</dt>
            <dd>{facts.chargebacks}</dd>
            <dt>Verspätete Zahlungen</dt>
            <dd>{facts.latePayments}</dd>
            <dt>Offene Rechnungen</dt>
            <dd>
              {facts.openInvoices} ({eur(facts.openAmountCents)})
            </dd>
            <dt>Überfällig</dt>
            <dd>
              {facts.overdueInvoices} ({eur(facts.overdueAmountCents)})
            </dd>
            <dt>Offenes Obligo</dt>
            <dd>{eur(facts.exposureCents)}</dd>
            <dt>Termine in Zahlungsprüfung</dt>
            <dd>{profile.pendingReviewBookings}</dd>
          </dl>
          <p className="hint">
            Betrachtungszeitraum {policy.lookbackDays} Tage. „Bezahlt“ zählt erst nach Ablauf der
            Rückbuchungsfrist des Zahlungsmittels; Teilzahlungen zählen nie.
          </p>
        </section>
      </div>

      <section className="panel" aria-labelledby="credit-title">
        <h2 id="credit-title">Rechnungskauf (Kreditfreigabe)</h2>
        {canRequest && open === undefined && active === undefined ? (
          decision.invoiceReviewEligible ? (
            <form action={requestCreditAction} className="form">
              <input type="hidden" name="customerId" value={profile.customerId} />
              <div className="field">
                <label htmlFor="request-reason">Begründung des Antrags</label>
                <input id="request-reason" name="reason" required minLength={3} maxLength={1000} />
              </div>
              <button className="button" type="submit">
                Rechnungskauf beantragen
              </button>
            </form>
          ) : (
            <p className="muted">
              Die Mindestvoraussetzungen sind nicht erfüllt – ein Antrag ist nicht möglich.
            </p>
          )
        ) : null}
        {open !== undefined && canApprove ? (
          <div className="detail-grid">
            <form
              action={approveCreditAction}
              className="form"
              aria-label="Rechnungskauf freigeben"
            >
              <input type="hidden" name="customerId" value={profile.customerId} />
              <input type="hidden" name="approvalId" value={open.id} />
              <div className="field">
                <label htmlFor="credit-limit">
                  Kreditrahmen in € (max. {eur(policy.defaultCreditLimitCents)})
                </label>
                <input
                  id="credit-limit"
                  name="creditLimit"
                  inputMode="decimal"
                  required
                  maxLength={14}
                />
              </div>
              <div className="field">
                <label htmlFor="trust-score">
                  Interne Vertrauensbewertung 0–100 (mind. {policy.minTrustScore})
                </label>
                <input
                  id="trust-score"
                  name="trustScore"
                  inputMode="numeric"
                  required
                  maxLength={3}
                />
              </div>
              <div className="field">
                <label htmlFor="valid-until">Gültig bis (optional)</label>
                <input id="valid-until" name="validUntil" type="date" />
              </div>
              <div className="field">
                <label htmlFor="approve-reason">Begründung der Freigabe</label>
                <input id="approve-reason" name="reason" required minLength={3} maxLength={1000} />
              </div>
              <button className="button" type="submit">
                Rechnungskauf freigeben
              </button>
              <p className="hint">
                Vier-Augen-Prinzip: Antragsteller und Freigebende müssen verschieden sein.
              </p>
            </form>
            <form action={denyCreditAction} className="form" aria-label="Antrag ablehnen">
              <input type="hidden" name="customerId" value={profile.customerId} />
              <input type="hidden" name="approvalId" value={open.id} />
              <div className="field">
                <label htmlFor="deny-reason">Ablehnungsgrund</label>
                <input id="deny-reason" name="reason" required minLength={3} maxLength={1000} />
              </div>
              <button className="button button--secondary" type="submit">
                Antrag ablehnen
              </button>
            </form>
          </div>
        ) : null}
        {active !== undefined && canRequest ? (
          <form action={revokeCreditAction} className="form">
            <input type="hidden" name="customerId" value={profile.customerId} />
            <input type="hidden" name="approvalId" value={active.id} />
            <div className="field">
              <label htmlFor="revoke-reason">Widerrufsgrund</label>
              <input id="revoke-reason" name="reason" required minLength={3} maxLength={1000} />
            </div>
            <button className="button button--secondary" type="submit">
              Rechnungskauf widerrufen
            </button>
          </form>
        ) : null}
        {profile.approvals.length === 0 ? (
          <p className="muted">Noch keine Kreditentscheidungen.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Beantragt</th>
                  <th scope="col">Kreditrahmen</th>
                  <th scope="col">Gültig bis</th>
                  <th scope="col">Entscheidung</th>
                </tr>
              </thead>
              <tbody>
                {profile.approvals.map((approval) => (
                  <tr key={approval.id}>
                    <td>{label(CREDIT_TERMS_STATUS_LABELS, approval.status)}</td>
                    <td>
                      {formatDateTime(approval.requestedAt)}
                      {approval.requestedByName === null
                        ? ""
                        : ` (${approval.requestedByName})`} – {approval.requestReason}
                    </td>
                    <td>
                      {approval.creditLimitCents === null ? "–" : eur(approval.creditLimitCents)}
                    </td>
                    <td>{formatDate(approval.validUntil)}</td>
                    <td>
                      {approval.decidedAt === null
                        ? "offen"
                        : `${formatDateTime(approval.decidedAt)} – ${approval.decisionReason ?? ""}`}
                      {approval.revokedAt === null
                        ? null
                        : ` · widerrufen ${formatDateTime(approval.revokedAt)} – ${approval.revokeReason ?? ""}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
