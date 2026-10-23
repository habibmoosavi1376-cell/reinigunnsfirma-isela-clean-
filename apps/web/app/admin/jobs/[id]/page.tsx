import { hasGlobalPermission } from "@isela/auth";
import {
  JOB_TRANSITIONS,
  getJob,
  listAssignmentCandidates,
  type JobStatus,
} from "@isela/operations";
import { isDomainError } from "@isela/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { ActionResult } from "@/components/admin/action-result";
import { formatDateTime, formatMoney } from "@/lib/admin/format";
import {
  BOOKING_STATUS_LABELS,
  CANDIDATE_BLOCKER_LABELS,
  FULFILLMENT_LABELS,
  JOB_STATUS_LABELS,
  JOB_TRANSITION_LABELS,
  PAYMENT_REQUIREMENT_LABELS,
  PAYMENT_STATUS_LABELS,
  PROPERTY_TYPE_LABELS,
  SCORE_FACTOR_LABELS,
  label,
} from "@/lib/admin/labels";
import { formatInTimeZone } from "@/lib/admin/time";
import { requireAdminArea } from "@/lib/server/guards";
import { loadOperationsConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";
import { assignJobAction, releaseAssignmentAction, transitionJobAction } from "./actions";

export const metadata: Metadata = { title: "Einsatz" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Manual transitions offered to dispatch (assignment and cancellation have own flows). */
const MANUAL: readonly JobStatus[] = [
  "ASSIGNMENT_PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "QUALITY_CHECK",
  "CLOSED",
];

function formatDistance(meters: number | null): string {
  return meters === null
    ? "–"
    : `${(meters / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km`;
}

export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdminArea();
  if (!hasGlobalPermission(actor, "job:read")) forbidden();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await getServiceContext();
  let job;
  try {
    job = await getJob(ctx, { jobId: id });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
  const config = await loadOperationsConfig(ctx.db, ctx.clock);
  const canAssign = hasGlobalPermission(actor, "job:assign");
  const canWrite = hasGlobalPermission(actor, "job:write");
  const assignable = job.status === "ASSIGNMENT_PENDING" || job.status === "ASSIGNED";
  const candidates =
    canAssign && assignable ? await listAssignmentCandidates(ctx, { jobId: job.id }, config) : [];
  const transitions = canWrite
    ? JOB_TRANSITIONS[job.status].filter(
        (to) => MANUAL.includes(to) && !(to === "ASSIGNMENT_PENDING" && job.status === "ASSIGNED"),
      )
    : [];
  const query = await searchParams;

  return (
    <>
      <p>
        <Link href="/admin/jobs">← Alle Einsätze</Link> ·{" "}
        <Link href={`/admin/bookings/${job.booking.id}`}>Buchung</Link>
        {job.booking.quoteId === null ? null : (
          <>
            {" "}
            · <Link href={`/admin/quotes/${job.booking.quoteId}`}>Angebot</Link>
          </>
        )}
      </p>
      <h1>
        Einsatz {job.id.slice(0, 8)}{" "}
        <span className="badge">{label(JOB_STATUS_LABELS, job.status)}</span>
      </h1>
      <ActionResult query={query} />

      <div className="detail-grid">
        <section className="panel" aria-labelledby="job-facts">
          <h2 id="job-facts">Einsatzdaten</h2>
          <dl className="facts">
            <dt>Kunde</dt>
            <dd>
              <Link href={`/admin/customers/${job.customer.id}`}>{job.customer.name}</Link>
            </dd>
            <dt>Objekt</dt>
            <dd>
              {job.property.name} ({label(PROPERTY_TYPE_LABELS, job.property.type)})
            </dd>
            <dt>Adresse</dt>
            <dd>{job.addressLine}</dd>
            <dt>Leistung</dt>
            <dd>{job.services.join(", ")}</dd>
            <dt>Termin</dt>
            <dd>
              {formatInTimeZone(job.scheduledStart, config.timeZone)} –{" "}
              {formatInTimeZone(job.scheduledEnd, config.timeZone)}
            </dd>
            <dt>Dauer</dt>
            <dd>{job.durationMinutes} min</dd>
            <dt>Servicegebiet</dt>
            <dd>{job.serviceAreaName ?? "unbekannt (Adresse ohne Koordinaten)"}</dd>
            <dt>Qualifikationen</dt>
            <dd>
              {job.requiredQualifications.length === 0
                ? "keine"
                : job.requiredQualifications.join(", ")}
            </dd>
            <dt>Ausführung</dt>
            <dd>
              {job.assignment === null
                ? "nicht zugewiesen"
                : `${job.assignment.name} (${label(FULFILLMENT_LABELS, job.fulfillmentType)})`}
            </dd>
            <dt>Operative Hinweise</dt>
            <dd>{job.operationalNotes ?? "–"}</dd>
          </dl>
        </section>

        <section className="panel" aria-labelledby="job-booking">
          <h2 id="job-booking">Buchung und Zahlung</h2>
          <dl className="facts">
            <dt>Buchung</dt>
            <dd>{label(BOOKING_STATUS_LABELS, job.booking.status)}</dd>
            <dt>Zahlungsbedingung</dt>
            <dd>{label(PAYMENT_REQUIREMENT_LABELS, job.booking.paymentRequirement)}</dd>
            <dt>Zahlungsstatus</dt>
            <dd>
              {job.booking.paymentStatus === null
                ? "–"
                : label(PAYMENT_STATUS_LABELS, job.booking.paymentStatus)}
            </dd>
            <dt>Brutto</dt>
            <dd>{formatMoney(job.booking.grossCents, job.booking.currency)}</dd>
          </dl>
          {job.internalFinance === null ? null : (
            <>
              <h3>Intern: Kosten und Deckungsbeitrag</h3>
              <dl className="facts">
                <dt>Interne Kosten</dt>
                <dd>
                  {job.internalFinance.internalCostCents === null
                    ? "nicht vollständig berechnet"
                    : formatMoney(job.internalFinance.internalCostCents, job.booking.currency)}
                </dd>
                <dt>Deckungsbeitrag</dt>
                <dd>
                  {job.internalFinance.contributionMarginCents === null
                    ? "–"
                    : formatMoney(
                        job.internalFinance.contributionMarginCents,
                        job.booking.currency,
                      )}
                </dd>
                <dt>Positionen</dt>
                <dd>
                  {job.internalFinance.pricedItems} berechnet, {job.internalFinance.manualItems}{" "}
                  manuell
                </dd>
              </dl>
            </>
          )}
          {transitions.map((to) => (
            <form key={to} action={transitionJobAction} className="form">
              <input type="hidden" name="jobId" value={job.id} />
              <input type="hidden" name="to" value={to} />
              <button className="button" type="submit">
                {label(JOB_TRANSITION_LABELS, to)}
              </button>
            </form>
          ))}
          {job.status === "ASSIGNED" &&
          job.booking.paymentStatus !== null &&
          job.booking.paymentStatus !== "PAYMENT_CONFIRMED" ? (
            <p className="hint">Der Einsatz kann erst nach bestätigter Vorkasse beginnen.</p>
          ) : null}
        </section>
      </div>

      {canAssign && assignable ? (
        <section className="panel" aria-labelledby="candidates-title">
          <h2 id="candidates-title">Zuweisung – Kandidaten</h2>
          <p className="hint">
            Harte Regeln (aktiv, verifiziert, Qualifikation, Gebiet, Arbeitszeit, Abwesenheit,
            Überschneidung, Kapazität, Nachweise) entscheiden über die Eignung. Der Score ist ein
            gewichteter Durchschnitt der angezeigten Faktoren; Faktoren ohne Daten zählen nicht.
            Partner werden nur vorgeschlagen, wenn die Partnerzuweisung vom Inhaber freigegeben ist.
          </p>
          {job.status === "ASSIGNED" ? (
            <form action={releaseAssignmentAction} className="form">
              <input type="hidden" name="jobId" value={job.id} />
              <div className="field">
                <label htmlFor="release-reason">Zuweisung aufheben – Grund</label>
                <input id="release-reason" name="reason" required minLength={3} maxLength={1000} />
              </div>
              <button className="button button--secondary" type="submit">
                Zuweisung aufheben
              </button>
            </form>
          ) : null}
          {candidates.length === 0 ? (
            <p className="muted">Keine Mitarbeitenden oder Partner erfasst.</p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Kandidat</th>
                    <th scope="col">Score</th>
                    <th scope="col">Entfernung</th>
                    <th scope="col">Faktoren / Ausschlussgründe</th>
                    <th scope="col">Aktion</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((candidate) => {
                    const candidateId = candidate.employeeId ?? candidate.partnerId ?? "";
                    const current = job.assignment?.id === candidateId;
                    return (
                      <tr key={`${candidate.kind}-${candidateId}`}>
                        <td>
                          {candidate.name}
                          <br />
                          <span className="muted">
                            {candidate.kind === "EMPLOYEE" ? "Mitarbeitende/r" : "Partner"}
                          </span>
                        </td>
                        <td>{candidate.score ?? "–"}</td>
                        <td>{formatDistance(candidate.distanceM)}</td>
                        <td>
                          {candidate.eligible ? (
                            <ul className="compact">
                              {candidate.factors.map((factor) => (
                                <li key={factor.key}>
                                  {label(SCORE_FACTOR_LABELS, factor.key)}:{" "}
                                  {factor.value === null
                                    ? "keine Daten"
                                    : `${String(factor.value)} × ${String(factor.weight)} → ${String(factor.contribution)}`}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            candidate.blockers
                              .map((b) => label(CANDIDATE_BLOCKER_LABELS, b))
                              .join(", ")
                          )}
                        </td>
                        <td>
                          {candidate.eligible && !current ? (
                            <form action={assignJobAction} className="inline-form">
                              <input type="hidden" name="jobId" value={job.id} />
                              <input type="hidden" name="kind" value={candidate.kind} />
                              <input type="hidden" name="candidateId" value={candidateId} />
                              {job.status === "ASSIGNED" ? (
                                <input
                                  name="reason"
                                  aria-label={`Grund der Neuzuweisung an ${candidate.name}`}
                                  placeholder="Grund der Neuzuweisung"
                                  required
                                  minLength={3}
                                  maxLength={1000}
                                />
                              ) : null}
                              <button className="button" type="submit">
                                {job.status === "ASSIGNED" ? "Neu zuweisen" : "Zuweisen"}
                              </button>
                            </form>
                          ) : current ? (
                            "aktuell"
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      <section className="panel" aria-labelledby="job-history">
        <h2 id="job-history">Verlauf</h2>
        <ul>
          {job.history.map((entry) => (
            <li key={`${entry.createdAt.toISOString()}-${entry.toStatus}`}>
              {formatDateTime(entry.createdAt)}:{" "}
              {entry.fromStatus === null ? "" : `${label(JOB_STATUS_LABELS, entry.fromStatus)} → `}
              {label(JOB_STATUS_LABELS, entry.toStatus)}
              {entry.actorName === null ? "" : ` (${entry.actorName})`}
              {entry.reason === null ? null : ` – ${entry.reason}`}
            </li>
          ))}
        </ul>
        {job.assignmentHistory.length === 0 ? null : (
          <>
            <h3>Zuweisungen</h3>
            <ul>
              {job.assignmentHistory.map((entry) => (
                <li key={`${entry.assignedAt.toISOString()}-${entry.name}`}>
                  {formatDateTime(entry.assignedAt)}: {entry.name} (
                  {entry.status === "ACTIVE" ? "aktiv" : "aufgehoben"}
                  {entry.releaseReason === null ? "" : ` – ${entry.releaseReason}`})
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {job.audit === null ? null : (
        <section className="panel" aria-labelledby="job-audit">
          <h2 id="job-audit">Audit</h2>
          <ul>
            {job.audit.map((entry) => (
              <li key={`${entry.occurredAt.toISOString()}-${entry.action}`}>
                {formatDateTime(entry.occurredAt)}: {entry.action}
                {entry.actorName === null ? " (System)" : ` (${entry.actorName})`}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
