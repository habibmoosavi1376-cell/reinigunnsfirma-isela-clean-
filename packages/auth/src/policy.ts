import { DomainError } from "@isela/shared";
import {
  ASSIGNABLE_ROLES,
  MFA_REQUIRED_ROLES,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from "./permissions.ts";

export interface RoleAssignment {
  readonly role: Role;
  readonly customerId: string | null;
  readonly partnerId: string | null;
  readonly isScopeAdmin: boolean;
}

/** Authenticated principal, always loaded server-side from the session – never from input. */
export interface Actor {
  readonly userId: string;
  readonly mfaEnabled: boolean;
  readonly roles: readonly RoleAssignment[];
}

/** The resource an action targets. Needed for OWN-scoped permissions (IDOR protection). */
export interface ResourceScope {
  readonly customerId?: string | null;
  readonly partnerId?: string | null;
}

export type ScopeFilter =
  | { readonly kind: "ALL" }
  | {
      readonly kind: "RESTRICTED";
      readonly customerIds: readonly string[];
      readonly partnerIds: readonly string[];
    };

function effectiveAssignments(actor: Actor): { usable: RoleAssignment[]; mfaBlocked: boolean } {
  const usable: RoleAssignment[] = [];
  let mfaBlocked = false;
  for (const assignment of actor.roles) {
    if (MFA_REQUIRED_ROLES.has(assignment.role) && !actor.mfaEnabled) {
      mfaBlocked = true;
      continue;
    }
    usable.push(assignment);
  }
  return { usable, mfaBlocked };
}

function matchesOwnScope(assignment: RoleAssignment, resource: ResourceScope | undefined): boolean {
  if (resource === undefined) {
    return false;
  }
  if (assignment.role === "CUSTOMER") {
    return assignment.customerId !== null && resource.customerId === assignment.customerId;
  }
  if (assignment.role === "PARTNER") {
    return assignment.partnerId !== null && resource.partnerId === assignment.partnerId;
  }
  return false;
}

/** Throws UNAUTHENTICATED for anonymous requests. */
export function requireActor(actor: Actor | null): Actor {
  if (actor === null) {
    throw new DomainError("UNAUTHENTICATED", "Authentication required");
  }
  return actor;
}

/** Returns whether the actor holds the permission for the given resource. */
export function isAuthorized(
  actor: Actor | null,
  permission: Permission,
  resource?: ResourceScope,
): boolean {
  if (actor === null) {
    return false;
  }
  const { usable } = effectiveAssignments(actor);
  return usable.some((assignment) => {
    const scope = ROLE_PERMISSIONS[assignment.role][permission];
    if (scope === "GLOBAL") return true;
    if (scope === "OWN") return matchesOwnScope(assignment, resource);
    return false;
  });
}

/**
 * Central authorization check. Throws UNAUTHENTICATED, MFA_REQUIRED or FORBIDDEN.
 * OWN-scoped permissions require the target resource so that one customer can never access
 * another customer's data by guessing identifiers.
 */
export function authorize(
  actor: Actor | null,
  permission: Permission,
  resource?: ResourceScope,
): asserts actor is Actor {
  if (actor === null) {
    throw new DomainError("UNAUTHENTICATED", "Authentication required");
  }
  if (isAuthorized(actor, permission, resource)) {
    return;
  }
  const { mfaBlocked } = effectiveAssignments(actor);
  if (mfaBlocked) {
    throw new DomainError("MFA_REQUIRED", "Multi-factor authentication required for this account");
  }
  throw new DomainError("FORBIDDEN", "Not allowed", { permission });
}

/** For list queries: which customers/partners the actor may see for a permission. */
export function scopeFilterFor(actor: Actor | null, permission: Permission): ScopeFilter {
  authorizeAny(actor, permission);
  const { usable } = effectiveAssignments(actor);
  const customerIds: string[] = [];
  const partnerIds: string[] = [];
  for (const assignment of usable) {
    const scope = ROLE_PERMISSIONS[assignment.role][permission];
    if (scope === "GLOBAL") return { kind: "ALL" };
    if (scope === "OWN") {
      if (assignment.customerId !== null) customerIds.push(assignment.customerId);
      if (assignment.partnerId !== null) partnerIds.push(assignment.partnerId);
    }
  }
  return { kind: "RESTRICTED", customerIds, partnerIds };
}

/** Throws unless the actor holds the permission in at least one (possibly OWN) scope. */
function authorizeAny(actor: Actor | null, permission: Permission): asserts actor is Actor {
  if (actor === null) {
    throw new DomainError("UNAUTHENTICATED", "Authentication required");
  }
  const { usable, mfaBlocked } = effectiveAssignments(actor);
  if (usable.some((a) => ROLE_PERMISSIONS[a.role][permission] !== undefined)) {
    return;
  }
  if (mfaBlocked) {
    throw new DomainError("MFA_REQUIRED", "Multi-factor authentication required for this account");
  }
  throw new DomainError("FORBIDDEN", "Not allowed", { permission });
}

export function hasGlobalPermission(actor: Actor | null, permission: Permission): boolean {
  if (actor === null) return false;
  return effectiveAssignments(actor).usable.some(
    (a) => ROLE_PERMISSIONS[a.role][permission] === "GLOBAL",
  );
}

export interface RoleGrantRequest {
  readonly role: Role;
  readonly customerId: string | null;
  readonly partnerId: string | null;
  readonly isScopeAdmin: boolean;
}

/**
 * Privilege-escalation guard for invitations and role assignments.
 * - Global admins may only grant roles listed in ASSIGNABLE_ROLES for their role.
 * - Scope admins (B2B/partner owners) may only invite plain users into their own scope.
 */
export function assertCanGrantRole(actor: Actor | null, request: RoleGrantRequest): void {
  authorizeAny(actor, "user:invite");
  const { usable } = effectiveAssignments(actor);

  const scopeValid =
    (request.role === "CUSTOMER" && request.customerId !== null && request.partnerId === null) ||
    (request.role === "PARTNER" && request.partnerId !== null && request.customerId === null) ||
    (request.role !== "CUSTOMER" &&
      request.role !== "PARTNER" &&
      request.customerId === null &&
      request.partnerId === null);
  if (
    !scopeValid ||
    (request.isScopeAdmin && request.role !== "CUSTOMER" && request.role !== "PARTNER")
  ) {
    throw new DomainError("VALIDATION_FAILED", "Role scope does not match role");
  }

  const allowed = usable.some((assignment) => {
    const globallyAssignable = ASSIGNABLE_ROLES[assignment.role];
    if (
      globallyAssignable !== undefined &&
      ROLE_PERMISSIONS[assignment.role]["user:invite"] === "GLOBAL"
    ) {
      return globallyAssignable.includes(request.role);
    }
    if (!assignment.isScopeAdmin || request.isScopeAdmin) {
      return false;
    }
    if (assignment.role === "CUSTOMER") {
      return request.role === "CUSTOMER" && request.customerId === assignment.customerId;
    }
    if (assignment.role === "PARTNER") {
      return request.role === "PARTNER" && request.partnerId === assignment.partnerId;
    }
    return false;
  });

  if (!allowed) {
    throw new DomainError("FORBIDDEN", "Not allowed to grant this role", { role: request.role });
  }
}
