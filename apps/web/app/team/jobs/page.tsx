import { listOwnJobs } from "@isela/operations";
import Link from "next/link";
import { ActionResult } from "@/components/admin/action-result";
import { JOB_STATUS_LABELS, JOB_TRANSITION_LABELS, label } from "@/lib/admin/labels";
import { formatInTimeZone } from "@/lib/admin/time";
import { requireTeamArea } from "@/lib/server/guards";
import { loadOperationsConfig } from "@/lib/server/operations-config";
import { getServiceContext } from "@/lib/server/session";
import { transitionOwnJobAction } from "./actions";

const NEXT: Readonly<Record<string, "IN_PROGRESS" | "COMPLETED" | undefined>> = {
  ASSIGNED: "IN_PROGRESS",
  IN_PROGRESS: "COMPLETED",
};

/** Own assigned jobs of the signed-in employee or partner – no prices, no customer contacts. */
export default async function TeamJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireTeamArea();
  const ctx = await getServiceContext();
  const [jobs, config] = await Promise.all([
    listOwnJobs(ctx, {}),
    loadOperationsConfig(ctx.db, ctx.clock),
  ]);
  const query = await searchParams;
  return (
    <>
      <h1>Meine Einsätze</h1>
      <ActionResult query={query} />
      {jobs.length === 0 ? (
        <p className="muted">Ihnen sind derzeit keine Einsätze zugewiesen.</p>
      ) : (
        jobs.map((job) => {
          const next = NEXT[job.status];
          return (
            <section key={job.id} className="panel" aria-labelledby={`job-${job.id}`}>
              <h2 id={`job-${job.id}`}>
                {formatInTimeZone(job.scheduledStart, config.timeZone)}{" "}
                <span className="badge">{label(JOB_STATUS_LABELS, job.status)}</span>
              </h2>
              <dl className="facts">
                <dt>Objekt</dt>
                <dd>{job.propertyName}</dd>
                <dt>Adresse</dt>
                <dd>{job.addressLine}</dd>
                <dt>Leistungen</dt>
                <dd>{job.services.join(", ")}</dd>
                <dt>Ende geplant</dt>
                <dd>{formatInTimeZone(job.scheduledEnd, config.timeZone)}</dd>
                <dt>Hinweise</dt>
                <dd>{job.operationalNotes ?? "–"}</dd>
              </dl>
              {next === undefined ? null : (
                <form action={transitionOwnJobAction} className="form">
                  <input type="hidden" name="jobId" value={job.id} />
                  <input type="hidden" name="to" value={next} />
                  <button className="button" type="submit">
                    {label(JOB_TRANSITION_LABELS, next)}
                  </button>
                </form>
              )}
            </section>
          );
        })
      )}
      <p className="hint">
        Ein Einsatz kann erst beginnen, wenn die Buchung bestätigt und eine erforderliche Vorkasse
        eingegangen ist. <Link href="/">Zur Startseite</Link>
      </p>
    </>
  );
}
