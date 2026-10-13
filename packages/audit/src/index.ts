import { schema, type DbExecutor } from "@isela/database";
import { redactSensitive } from "@isela/shared";

export type AuditActor =
  { readonly type: "USER"; readonly id: string } | { readonly type: "SYSTEM" };

export interface AuditEntry {
  readonly actor: AuditActor;
  /** Dotted action name, e.g. "customer.created", "lead.status_changed". */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly correlationId?: string | undefined;
}

/**
 * Appends an audit entry. Must be called inside the same transaction as the audited change
 * so that either both or neither are persisted. Sensitive fields are redacted.
 */
export async function recordAudit(db: DbExecutor, entry: AuditEntry): Promise<void> {
  await db.insert(schema.auditLog).values({
    actorType: entry.actor.type,
    actorId: entry.actor.type === "USER" ? entry.actor.id : null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before === undefined ? null : redactSensitive(entry.before),
    after: entry.after === undefined ? null : redactSensitive(entry.after),
    correlationId: entry.correlationId ?? null,
  });
}
