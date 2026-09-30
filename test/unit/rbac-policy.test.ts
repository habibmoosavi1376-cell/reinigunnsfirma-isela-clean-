import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  assertCanGrantRole,
  authorize,
  isAuthorized,
  scopeFilterFor,
  type Actor,
  type Permission,
  type Role,
  type RoleAssignment,
} from "@isela/auth";
import { expectDomainErrorSync } from "../support/assertions.ts";

const CUSTOMER_A = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_B = "22222222-2222-4222-8222-222222222222";
const PARTNER_A = "33333333-3333-4333-8333-333333333333";

function actor(role: Role, options: Partial<RoleAssignment> & { mfa?: boolean } = {}): Actor {
  return {
    userId: `user-${role}`,
    mfaEnabled: options.mfa ?? true,
    roles: [
      {
        role,
        customerId: options.customerId ?? null,
        partnerId: options.partnerId ?? null,
        isScopeAdmin: options.isScopeAdmin ?? false,
      },
    ],
  };
}

describe("RBAC catalogue", () => {
  it("only references known permissions and grants no permission to unknown roles", () => {
    for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
      expect(Object.hasOwn(ROLES, role)).toBe(true);
      for (const permission of Object.keys(grants)) {
        expect(Object.hasOwn(PERMISSIONS, permission), permission).toBe(true);
      }
    }
  });

  it("gives payment policy management only to SUPER_ADMIN and FINANCE", () => {
    const holders = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter(
      (role) => ROLE_PERMISSIONS[role]["payment_policy:manage"] !== undefined,
    );
    expect(holders.sort()).toEqual(["FINANCE", "SUPER_ADMIN"]);
  });

  it("gives credit-terms approval only to SUPER_ADMIN and FINANCE (not ADMIN)", () => {
    const holders = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter(
      (role) => ROLE_PERMISSIONS[role]["credit_terms:approve"] !== undefined,
    );
    expect(holders.sort()).toEqual(["FINANCE", "SUPER_ADMIN"]);
  });

  it.each<[Permission, Role[]]>([
    ["invoice:write", ["ADMIN", "FINANCE", "SUPER_ADMIN"]],
    ["payment:manage", ["ADMIN", "FINANCE", "SUPER_ADMIN"]],
    ["payment_risk:read", ["ADMIN", "FINANCE", "SUPER_ADMIN"]],
    ["credit_terms:request", ["ADMIN", "FINANCE", "SUPER_ADMIN"]],
    ["invoice:read", ["ADMIN", "CUSTOMER", "FINANCE", "SUPER_ADMIN"]],
  ])("limits the finance permission %s to %j", (permission, roles) => {
    const holders = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter(
      (role) => ROLE_PERMISSIONS[role][permission] !== undefined,
    );
    expect(holders.sort()).toEqual(roles);
    // Dispatchers, staff and partners never see invoices, payments or risk data.
    for (const role of ["DISPATCHER", "STAFF", "PARTNER"] as const) {
      expect(ROLE_PERMISSIONS[role][permission], `${role} ${permission}`).toBeUndefined();
    }
  });

  it("scopes customer invoice access to OWN", () => {
    expect(ROLE_PERMISSIONS.CUSTOMER["invoice:read"]).toBe("OWN");
    expect(scopeFilterFor(actor("CUSTOMER", { customerId: CUSTOMER_A }), "invoice:read")).toEqual({
      kind: "RESTRICTED",
      customerIds: [CUSTOMER_A],
      partnerIds: [],
    });
  });

  it("denies all finance permissions to FINANCE without MFA", () => {
    expectDomainErrorSync(() => {
      authorize(actor("FINANCE", { mfa: false }), "credit_terms:approve");
    }, "MFA_REQUIRED");
  });

  it("scopes all CUSTOMER and PARTNER data permissions to OWN", () => {
    for (const role of ["CUSTOMER", "PARTNER"] as const) {
      for (const [permission, scope] of Object.entries(ROLE_PERMISSIONS[role])) {
        if (permission !== "catalog:read") {
          expect(scope, `${role} ${permission}`).toBe("OWN");
        }
      }
    }
  });
});

describe("authorize", () => {
  it("rejects anonymous requests", () => {
    expectDomainErrorSync(() => {
      authorize(null, "catalog:read");
    }, "UNAUTHENTICATED");
  });

  it("allows a customer to access its own customer record only (IDOR)", () => {
    const customer = actor("CUSTOMER", { customerId: CUSTOMER_A });
    expect(isAuthorized(customer, "customer:read", { customerId: CUSTOMER_A })).toBe(true);
    expectDomainErrorSync(() => {
      authorize(customer, "customer:read", { customerId: CUSTOMER_B });
    }, "FORBIDDEN");
    expectDomainErrorSync(() => {
      authorize(customer, "customer:read");
    }, "FORBIDDEN");
  });

  it("does not let a customer use a partner-scoped resource", () => {
    const customer = actor("CUSTOMER", { customerId: CUSTOMER_A });
    expect(isAuthorized(customer, "customer:read", { partnerId: CUSTOMER_A })).toBe(false);
  });

  it("requires MFA for privileged roles", () => {
    expectDomainErrorSync(() => {
      authorize(actor("ADMIN", { mfa: false }), "customer:read");
    }, "MFA_REQUIRED");
    expectDomainErrorSync(() => {
      authorize(actor("FINANCE", { mfa: false }), "payment_policy:manage");
    }, "MFA_REQUIRED");
    expect(() => {
      authorize(actor("ADMIN", { mfa: true }), "customer:read");
    }).not.toThrow();
  });

  it("does not require MFA for non-privileged roles", () => {
    expect(isAuthorized(actor("DISPATCHER", { mfa: false }), "customer:read")).toBe(true);
  });

  it("denies ADMIN the payment policy and STAFF customer data", () => {
    expectDomainErrorSync(() => {
      authorize(actor("ADMIN"), "payment_policy:manage");
    }, "FORBIDDEN");
    expectDomainErrorSync(() => {
      authorize(actor("STAFF"), "customer:read");
    }, "FORBIDDEN");
  });

  it("builds list filters from OWN scopes", () => {
    expect(scopeFilterFor(actor("DISPATCHER"), "customer:read")).toEqual({ kind: "ALL" });
    expect(scopeFilterFor(actor("CUSTOMER", { customerId: CUSTOMER_A }), "customer:read")).toEqual({
      kind: "RESTRICTED",
      customerIds: [CUSTOMER_A],
      partnerIds: [],
    });
  });

  it.each(Object.keys(PERMISSIONS) as Permission[])(
    "never grants %s to an actor without roles",
    (permission) => {
      const nobody: Actor = { userId: "u", mfaEnabled: true, roles: [] };
      expect(isAuthorized(nobody, permission, { customerId: CUSTOMER_A })).toBe(false);
    },
  );
});

describe("role grants (privilege escalation)", () => {
  const plain = (
    role: Role,
    scope: { customerId?: string; partnerId?: string } = {},
    isScopeAdmin = false,
  ) => ({
    role,
    customerId: scope.customerId ?? null,
    partnerId: scope.partnerId ?? null,
    isScopeAdmin,
  });

  it("lets ADMIN grant operational roles but not ADMIN or SUPER_ADMIN", () => {
    const admin = actor("ADMIN");
    expect(() => {
      assertCanGrantRole(admin, plain("DISPATCHER"));
    }).not.toThrow();
    expect(() => {
      assertCanGrantRole(admin, plain("CUSTOMER", { customerId: CUSTOMER_A }, true));
    }).not.toThrow();
    expectDomainErrorSync(() => {
      assertCanGrantRole(admin, plain("ADMIN"));
    }, "FORBIDDEN");
    expectDomainErrorSync(() => {
      assertCanGrantRole(admin, plain("SUPER_ADMIN"));
    }, "FORBIDDEN");
  });

  it("lets SUPER_ADMIN grant ADMIN", () => {
    expect(() => {
      assertCanGrantRole(actor("SUPER_ADMIN"), plain("ADMIN"));
    }).not.toThrow();
  });

  it("lets a B2B scope admin invite plain users into the own customer only", () => {
    const scopeAdmin = actor("CUSTOMER", { customerId: CUSTOMER_A, isScopeAdmin: true });
    expect(() => {
      assertCanGrantRole(scopeAdmin, plain("CUSTOMER", { customerId: CUSTOMER_A }));
    }).not.toThrow();
    expectDomainErrorSync(() => {
      assertCanGrantRole(scopeAdmin, plain("CUSTOMER", { customerId: CUSTOMER_B }));
    }, "FORBIDDEN");
    expectDomainErrorSync(() => {
      assertCanGrantRole(scopeAdmin, plain("CUSTOMER", { customerId: CUSTOMER_A }, true));
    }, "FORBIDDEN");
    expectDomainErrorSync(() => {
      assertCanGrantRole(scopeAdmin, plain("ADMIN"));
    }, "FORBIDDEN");
    expectDomainErrorSync(() => {
      assertCanGrantRole(scopeAdmin, plain("DISPATCHER"));
    }, "FORBIDDEN");
  });

  it("does not let a plain customer user invite anyone", () => {
    const user = actor("CUSTOMER", { customerId: CUSTOMER_A });
    expectDomainErrorSync(() => {
      assertCanGrantRole(user, plain("CUSTOMER", { customerId: CUSTOMER_A }));
    }, "FORBIDDEN");
  });

  it("lets a partner owner invite staff of the own partner only", () => {
    const owner = actor("PARTNER", { partnerId: PARTNER_A, isScopeAdmin: true });
    expect(() => {
      assertCanGrantRole(owner, plain("PARTNER", { partnerId: PARTNER_A }));
    }).not.toThrow();
    expectDomainErrorSync(() => {
      assertCanGrantRole(owner, plain("CUSTOMER", { customerId: CUSTOMER_A }));
    }, "FORBIDDEN");
  });

  it("rejects role/scope mismatches", () => {
    expectDomainErrorSync(() => {
      assertCanGrantRole(actor("SUPER_ADMIN"), plain("CUSTOMER"));
    }, "VALIDATION_FAILED");
    expectDomainErrorSync(() => {
      assertCanGrantRole(actor("SUPER_ADMIN"), plain("ADMIN", { customerId: CUSTOMER_A }));
    }, "VALIDATION_FAILED");
    expectDomainErrorSync(() => {
      assertCanGrantRole(actor("SUPER_ADMIN"), plain("DISPATCHER", {}, true));
    }, "VALIDATION_FAILED");
  });

  it("requires MFA for administrators granting roles", () => {
    expectDomainErrorSync(() => {
      assertCanGrantRole(actor("ADMIN", { mfa: false }), plain("STAFF"));
    }, "MFA_REQUIRED");
  });
});
