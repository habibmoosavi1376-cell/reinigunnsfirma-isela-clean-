import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { loadActor, type Actor, type ServiceContext } from "@isela/auth";
import { domainLogger } from "./logger";
import { getServices } from "./services";

/** Resolves the RBAC actor from the Better Auth session (once per request). */
export const getCurrentActor = cache(async (): Promise<Actor | null> => {
  const { auth, database } = getServices();
  const session = await auth.api.getSession({ headers: await headers() });
  if (session === null) {
    return null;
  }
  return loadActor(database.db, session.user.id);
});

export interface SessionUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly twoFactorEnabled: boolean;
}

export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const { auth } = getServices();
  const session = await auth.api.getSession({ headers: await headers() });
  if (session === null) return null;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    twoFactorEnabled: session.user.twoFactorEnabled === true,
  };
});

/** Service context for domain calls, derived exclusively from the server-side session. */
export async function getServiceContext(): Promise<ServiceContext> {
  const { database, clock } = getServices();
  const requestHeaders = await headers();
  return {
    db: database.db,
    actor: await getCurrentActor(),
    clock,
    correlationId: requestHeaders.get("x-request-id") ?? crypto.randomUUID(),
    logger: domainLogger,
  };
}
