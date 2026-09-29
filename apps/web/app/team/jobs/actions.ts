"use server";

import { transitionJob } from "@isela/operations";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";

/** Start/complete an own job. The service checks the assignment and the payment guard. */
export async function transitionOwnJobAction(form: FormData): Promise<void> {
  const jobId = formId(form, "jobId");
  await runAdminAction("/team/jobs", "job_transitioned", (ctx) =>
    transitionJob(ctx, { jobId, to: formField(form, "to") }),
  );
}
