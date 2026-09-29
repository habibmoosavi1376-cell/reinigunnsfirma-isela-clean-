import type { AuditActor } from "@isela/audit";
import type { Database } from "@isela/database";
import type { Clock, DomainLogger } from "@isela/shared";
import type { Actor } from "./policy.ts";

/** Per-request context passed to every application service. */
export interface ServiceContext {
  readonly db: Database;
  /** `null` = unauthenticated request. Always derived from the server-side session. */
  readonly actor: Actor | null;
  readonly clock: Clock;
  readonly correlationId?: string | undefined;
  /** Structured, PII-free operational log (optional; ids and codes only). */
  readonly logger?: DomainLogger | undefined;
}

export function auditActorOf(actor: Actor): AuditActor {
  return { type: "USER", id: actor.userId };
}
