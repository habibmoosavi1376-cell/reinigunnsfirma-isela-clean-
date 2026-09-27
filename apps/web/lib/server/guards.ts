import "server-only";
import { forbidden, redirect, unauthorized } from "next/navigation";
import { MFA_REQUIRED_ROLES, isAuthorized, type Actor, type Permission } from "@isela/auth";
import { getCurrentActor } from "./session";

/** Permissions that grant access to the internal admin area (any one suffices). */
export const ADMIN_AREA_PERMISSIONS: readonly Permission[] = [
  "lead:read",
  "settings:read",
  "audit:read",
];

export async function requireSignedIn(): Promise<Actor> {
  const actor = await getCurrentActor();
  if (actor === null) {
    unauthorized();
  }
  return actor;
}

function blockedOnlyByMissingMfa(actor: Actor): boolean {
  return !actor.mfaEnabled && actor.roles.some((r) => MFA_REQUIRED_ROLES.has(r.role));
}

/** Customer area: signed-in user with a CUSTOMER assignment (own customer only). */
export async function requireCustomerArea(): Promise<{ actor: Actor; customerId: string }> {
  const actor = await requireSignedIn();
  const assignment = actor.roles.find((r) => r.role === "CUSTOMER" && r.customerId !== null);
  if (assignment?.customerId == null) {
    forbidden();
  }
  return { actor, customerId: assignment.customerId };
}

/** Admin area: at least one staff permission; privileged roles without MFA are sent to setup. */
export async function requireAdminArea(): Promise<Actor> {
  const actor = await requireSignedIn();
  if (ADMIN_AREA_PERMISSIONS.some((permission) => isAuthorized(actor, permission))) {
    return actor;
  }
  if (blockedOnlyByMissingMfa(actor)) {
    redirect("/account/security?reason=mfa-required");
  }
  forbidden();
}
