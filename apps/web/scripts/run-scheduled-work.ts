/*
 * Scheduled work entry point (day 8): `pnpm --filter @isela/web run jobs:run`.
 * Technology-neutral (ADR-008 open): call it from an external scheduler (e.g. cron every
 * 15 minutes) or later from a worker. Idempotent and protected against overlapping runs.
 *
 * Safety:
 * - runs as the service account JOBS_ACTOR_USER_ID (needs booking:write; audited);
 * - generates appointments only with a configured holiday region and approved holiday data;
 * - delivers e-mails only outside APP_ENVIRONMENT=production until an e-mail provider is
 *   approved (in production reminders are enqueued and stay PENDING);
 * - prints counts only (no addresses, names or content).
 */
import { loadActor } from "@isela/auth";
import { isLoopbackHost, parseServerEnv } from "@isela/config";
import { isEmailSuppressed } from "@isela/crm";
import { createDatabase } from "@isela/database";
import { createSmtpEmailSender } from "@isela/notifications";
import { runScheduledWork } from "@isela/operations";
import { GLOBAL_SCOPE, getEffectiveSetting } from "@isela/settings";
import { systemClock } from "@isela/shared";

const env = parseServerEnv(process.env);
if (env.JOBS_ACTOR_USER_ID === undefined) {
  console.error("JOBS_ACTOR_USER_ID is not set. Refusing to run scheduled work.");
  process.exit(1);
}

// At least two connections: one holds the run lock, the others do the work.
const handle = createDatabase(env.DATABASE_URL, {
  maxConnections: 3,
  applicationName: "isela-scheduled-work",
});
try {
  const db = handle.db;
  const actor = await loadActor(db, env.JOBS_ACTOR_USER_ID);
  if (actor === null) {
    console.error("The service account does not exist or has no roles.");
    process.exitCode = 1;
  } else {
    const now = systemClock.now();
    const [config, recurring, policy] = await Promise.all([
      getEffectiveSetting(db, "operations.assignment", GLOBAL_SCOPE, now),
      getEffectiveSetting(db, "operations.recurring", GLOBAL_SCOPE, now),
      getEffectiveSetting(db, "payment.policy", GLOBAL_SCOPE, now),
    ]);
    const production = env.NODE_ENV === "production";
    const sender = createSmtpEmailSender({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.EMAIL_FROM_ADDRESS,
      requireTls: production && !isLoopbackHost(env.SMTP_HOST),
    });
    const crmConfig = { identityPepper: env.IDENTITY_HASH_PEPPER };
    const result = await runScheduledWork({
      ctx: { db, actor, clock: systemClock, correlationId: crypto.randomUUID() },
      paymentPolicy: { policy: policy.value, version: policy.version },
      config: config.value,
      recurring: recurring.value,
      sender,
      isEmailSuppressed: (email) => isEmailSuppressed(db, crmConfig, email),
      dispatchEnabled: env.APP_ENVIRONMENT !== "production",
    });
    console.log(JSON.stringify({ event: "scheduled_work.result", ...result }));
  }
} finally {
  await handle.close();
}
