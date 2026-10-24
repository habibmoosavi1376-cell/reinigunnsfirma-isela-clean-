"use server";

import { reviewNotification } from "@isela/operations";
import { formField, formId, runAdminAction } from "@/lib/server/admin-actions";

/** Manual review of a failed or uncertain notification (booking:write, audited). */
export async function reviewNotificationAction(form: FormData): Promise<void> {
  const notificationId = formId(form, "notificationId");
  const action = formField(form, "action") ?? "";
  await runAdminAction(
    "/admin/notifications",
    action === "REQUEUE" ? "notification_requeued" : "notification_dismissed",
    (ctx) =>
      reviewNotification(ctx, {
        notificationId,
        action,
        expectedStatus: formField(form, "expectedStatus") ?? "",
        reason: formField(form, "reason") ?? "",
        confirmPossibleDuplicate: formField(form, "confirmPossibleDuplicate") === "yes",
      }),
  );
}
