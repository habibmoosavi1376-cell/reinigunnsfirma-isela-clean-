import { isAuthorized, type Actor, type Permission } from "@isela/auth";

/**
 * Back-office modules. Only implemented modules are links; everything else is shown as
 * "kommt später" (no placeholder pages, no fake data). Visibility follows the permission
 * matrix – hiding is convenience only, every page and action authorises on the server.
 */
export interface AdminModule {
  readonly key: string;
  readonly label: string;
  readonly href: string | null;
  readonly permission: Permission | null;
}

export const ADMIN_MODULES: readonly AdminModule[] = [
  { key: "dashboard", label: "Dashboard", href: "/admin/dashboard", permission: null },
  { key: "leads", label: "Leads", href: "/admin/leads", permission: "lead:read" },
  { key: "customers", label: "Kunden", href: "/admin/customers", permission: "customer:read" },
  { key: "properties", label: "Objekte", href: "/admin/properties", permission: "property:read" },
  { key: "quotes", label: "Angebote", href: "/admin/quotes", permission: "quote:read" },
  { key: "services", label: "Leistungen", href: "/admin/services", permission: "catalog:manage" },
  { key: "pricing", label: "Preisregeln", href: "/admin/pricing", permission: "pricing:read" },
  { key: "bookings", label: "Buchungen", href: "/admin/bookings", permission: "booking:read" },
  { key: "jobs", label: "Einsätze", href: "/admin/jobs", permission: "job:read" },
  { key: "calendar", label: "Kalender", href: null, permission: null },
  {
    key: "employees",
    label: "Mitarbeitende",
    href: "/admin/employees",
    permission: "employee:read",
  },
  { key: "partners", label: "Partner", href: "/admin/partners", permission: "partner:read" },
  { key: "invoices", label: "Rechnungen", href: null, permission: null },
  { key: "payments", label: "Zahlungen", href: null, permission: null },
  { key: "reviews", label: "Bewertungen", href: null, permission: null },
  { key: "complaints", label: "Reklamationen", href: null, permission: null },
  { key: "seo", label: "SEO", href: null, permission: "catalog:manage" },
  { key: "marketing", label: "Marketing", href: null, permission: null },
  { key: "reports", label: "Berichte", href: null, permission: null },
  { key: "settings", label: "Einstellungen", href: null, permission: "settings:read" },
  { key: "audit", label: "Audit-Log", href: null, permission: "audit:read" },
];

export interface VisibleModule extends AdminModule {
  readonly active: boolean;
}

export function visibleModules(actor: Actor): VisibleModule[] {
  return ADMIN_MODULES.filter(
    (m) => m.permission === null || isAuthorized(actor, m.permission),
  ).map((m) => ({ ...m, active: m.href !== null }));
}
