"use server";

import { assignJob, reassignJob, releaseJobAssignment, transitionJob } from "@isela/operations";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";
import { loadJobPaymentContext } from "@/lib/server/finance";
import { loadOperationsConfig } from "@/lib/server/operations-config";

/*
 * Dispatch actions. The form names a candidate (kind + id); the server re-evaluates exactly
 * that candidate against all hard rules inside the transaction – an arbitrary or forged id is
 * rejected. Status changes go through the job state machine.
 */

function pathOf(jobId: string): string {
  return `/admin/jobs/${jobId}`;
}

export async function transitionJobAction(form: FormData): Promise<void> {
  const jobId = formId(form, "jobId");
  await runAdminAction(
    pathOf(jobId),
    "job_transitioned",
    async (ctx) =>
      transitionJob(
        ctx,
        { jobId, to: formField(form, "to") },
        await loadJobPaymentContext(ctx.db, ctx.clock),
      ),
    { revalidate: ["/admin/jobs", "/admin/bookings"] },
  );
}

export async function assignJobAction(form: FormData): Promise<void> {
  const jobId = formId(form, "jobId");
  const candidateId = formId(form, "candidateId");
  const reason = formField(form, "reason");
  await runAdminAction(
    pathOf(jobId),
    reason === undefined ? "job_assigned" : "job_reassigned",
    async (ctx) => {
      const config = await loadOperationsConfig(ctx.db, ctx.clock);
      const input = { jobId, kind: formField(form, "kind"), candidateId };
      return reason === undefined
        ? assignJob(ctx, input, config)
        : reassignJob(ctx, { ...input, reason }, config);
    },
    { revalidate: ["/admin/jobs", "/admin/bookings"] },
  );
}

export async function releaseAssignmentAction(form: FormData): Promise<void> {
  const jobId = formId(form, "jobId");
  await runAdminAction(
    pathOf(jobId),
    "job_released",
    (ctx) => releaseJobAssignment(ctx, { jobId, reason: formField(form, "reason") ?? "" }),
    { revalidate: ["/admin/jobs", "/admin/bookings"] },
  );
}
