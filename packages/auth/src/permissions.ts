/**
 * Permission catalogue and role matrix. This file is the single source of truth for
 * authorization; the `role`/`permission` tables are synchronised from it
 * (`syncRbacCatalog`). Changes require review and an update of the RBAC matrix tests.
 */

export const PERMISSIONS = {
  "customer:read": "Kundendaten lesen",
  "customer:create": "Kunden anlegen",
  "customer:update": "Kundenstammdaten ändern",
  "customer:link_account": "Nutzerkonto mit Kundendatensatz verknüpfen",
  "customer_address:write": "Kundenadressen anlegen/ändern",
  "property:read": "Objekte lesen",
  "property:write": "Objekte anlegen/ändern",
  "lead:read": "Leads lesen",
  "lead:create": "Leads anlegen",
  "lead:transition": "Lead-Status ändern",
  "lead:update": "Lead-Anfrage bearbeiten (Adresse, Geocoding-Prüfung)",
  "lead_contact:read": "Lead-Kontakte lesen",
  "lead_contact:write": "Lead-Kontakte anlegen",
  "lead_contact:suppress": "Widerspruch/Sperre für Kontakte erfassen",
  "lead_source:manage": "Lead-Quellen verwalten",
  "catalog:read": "Leistungen und Einsatzgebiete lesen",
  "catalog:manage": "Leistungen und Einsatzgebiete verwalten",
  "partner:read": "Partner lesen",
  "partner:manage": "Partner anlegen, prüfen und freischalten",
  "settings:read": "Einstellungen lesen",
  "settings:manage": "Einstellungen ändern",
  "payment_policy:manage": "Zahlungsrichtlinie ändern",
  "quote:read": "Angebote lesen",
  "quote:write": "Angebotsentwürfe anlegen/bearbeiten",
  "quote:approve": "Angebote freigeben/versenden",
  "pricing:read": "Preisregeln lesen",
  "pricing:manage": "Preisregel-Entwürfe anlegen",
  "pricing:approve": "Preisregeln aktivieren",
  "pricing:override": "Berechnete Preise begründet übersteuern",
  "finance:internal_read": "Interne Kosten und Deckungsbeiträge lesen",
  "booking:read": "Buchungen lesen",
  "booking:write": "Buchungen aus Angeboten anlegen/stornieren",
  "payment:manage": "Zahlungsstatus von Buchungen pflegen",
  "job:read": "Einsätze lesen",
  "job:write": "Einsätze anlegen und Status pflegen",
  "job:assign": "Einsätze Mitarbeitenden/Partnern zuweisen",
  "job:execute_own": "Eigene zugewiesene Einsätze sehen und durchführen",
  "employee:read": "Mitarbeitende lesen",
  "employee:manage": "Mitarbeitende, Verfügbarkeiten und Qualifikationen pflegen",
  "consent:read": "Einwilligungen lesen",
  "consent:record": "Einwilligungen erfassen",
  "audit:read": "Audit-Log lesen",
  "user:invite": "Nutzer einladen",
  "session:revoke_any": "Sessions beliebiger Nutzer widerrufen",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ROLES = {
  SUPER_ADMIN: "Inhaber/Geschäftsführung – Vollzugriff",
  ADMIN: "Administration und Vertrieb",
  DISPATCHER: "Disposition und Kundenpflege",
  FINANCE: "Finanzen und Zahlungsrichtlinie",
  STAFF: "Eigene Reinigungskräfte",
  PARTNER: "Partnerbetrieb (eigener Partner)",
  CUSTOMER: "Kunde (eigener Kunde)",
} as const;

export type Role = keyof typeof ROLES;

/** GLOBAL = any resource; OWN = only resources of the assignment's customer/partner scope. */
export type PermissionScope = "GLOBAL" | "OWN";

const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

function grant(scope: PermissionScope, permissions: readonly Permission[]) {
  return Object.fromEntries(permissions.map((p) => [p, scope])) as Partial<
    Record<Permission, PermissionScope>
  >;
}

export const ROLE_PERMISSIONS: Readonly<
  Record<Role, Partial<Record<Permission, PermissionScope>>>
> = {
  SUPER_ADMIN: grant("GLOBAL", ALL_PERMISSIONS),
  ADMIN: grant(
    "GLOBAL",
    ALL_PERMISSIONS.filter((p) => p !== "payment_policy:manage"),
  ),
  DISPATCHER: grant("GLOBAL", [
    "customer:read",
    "customer:create",
    "customer:update",
    "customer_address:write",
    "property:read",
    "property:write",
    "lead:read",
    "lead:create",
    "lead:transition",
    "lead:update",
    "lead_contact:read",
    "lead_contact:write",
    "lead_contact:suppress",
    "catalog:read",
    "partner:read",
    "consent:read",
    "consent:record",
    "quote:read",
    "quote:write",
    "booking:read",
    "booking:write",
    "job:read",
    "job:write",
    "job:assign",
    "employee:read",
  ]),
  FINANCE: grant("GLOBAL", [
    "customer:read",
    "quote:read",
    "catalog:read",
    "settings:read",
    "payment_policy:manage",
    "consent:read",
    "audit:read",
    "pricing:read",
    "pricing:manage",
    "finance:internal_read",
    "booking:read",
    "payment:manage",
    "job:read",
  ]),
  /*
   * STAFF: `job:execute_own` is granted GLOBAL because staff accounts carry no scope id; the
   * operations services always restrict it to jobs assigned to the employee linked to the
   * acting user (never "all jobs").
   */
  STAFF: grant("GLOBAL", ["catalog:read", "job:execute_own"]),
  PARTNER: {
    ...grant("GLOBAL", ["catalog:read"]),
    ...grant("OWN", ["partner:read", "user:invite", "job:execute_own"]),
  },
  CUSTOMER: {
    ...grant("GLOBAL", ["catalog:read"]),
    ...grant("OWN", [
      "customer:read",
      "customer:update",
      "customer_address:write",
      "property:read",
      "property:write",
      "quote:read",
      "booking:read",
      "consent:read",
      "consent:record",
      "user:invite",
    ]),
  },
};

/** Accounts with these roles receive no permission at all without active MFA. */
export const MFA_REQUIRED_ROLES: ReadonlySet<Role> = new Set(["SUPER_ADMIN", "ADMIN", "FINANCE"]);

/** Roles that a holder of the given role may assign via invitation (global roles only). */
export const ASSIGNABLE_ROLES: Readonly<Partial<Record<Role, readonly Role[]>>> = {
  SUPER_ADMIN: ["SUPER_ADMIN", "ADMIN", "DISPATCHER", "FINANCE", "STAFF", "PARTNER", "CUSTOMER"],
  ADMIN: ["DISPATCHER", "FINANCE", "STAFF", "PARTNER", "CUSTOMER"],
};

export function isRole(value: string): value is Role {
  return Object.hasOwn(ROLES, value);
}

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}
