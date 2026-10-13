import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, Role } from "@isela/auth";

const current: { actor: Actor | null } = { actor: null };

vi.mock("@/lib/server/session", () => ({
  getCurrentActor: () => Promise.resolve(current.actor),
}));

const { requireAdminArea, requireCustomerArea, requireSignedIn } =
  await import("@/lib/server/guards");

function actor(role: Role, options: { customerId?: string; mfa?: boolean } = {}): Actor {
  return {
    userId: `user-${role}`,
    mfaEnabled: options.mfa ?? true,
    roles: [{ role, customerId: options.customerId ?? null, partnerId: null, isScopeAdmin: false }],
  };
}

async function digestOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { digest?: string }).digest;
  }
  return undefined;
}

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

describe("route guards (server-side authorization of areas)", () => {
  beforeEach(() => {
    current.actor = null;
  });

  it("responds 401 to anonymous visitors", async () => {
    expect(await digestOf(requireSignedIn())).toBe("NEXT_HTTP_ERROR_FALLBACK;401");
    expect(await digestOf(requireCustomerArea())).toBe("NEXT_HTTP_ERROR_FALLBACK;401");
    expect(await digestOf(requireAdminArea())).toBe("NEXT_HTTP_ERROR_FALLBACK;401");
  });

  it("lets only CUSTOMER users with a customer scope into the customer area", async () => {
    current.actor = actor("CUSTOMER", { customerId: CUSTOMER_ID });
    await expect(requireCustomerArea()).resolves.toMatchObject({ customerId: CUSTOMER_ID });
    for (const role of ["STAFF", "PARTNER", "DISPATCHER", "ADMIN"] as const) {
      current.actor = actor(role);
      expect(await digestOf(requireCustomerArea()), role).toBe("NEXT_HTTP_ERROR_FALLBACK;403");
    }
  });

  it("keeps customers, staff and partners out of the admin area", async () => {
    for (const role of ["CUSTOMER", "STAFF", "PARTNER"] as const) {
      current.actor = actor(role, { customerId: CUSTOMER_ID });
      expect(await digestOf(requireAdminArea()), role).toBe("NEXT_HTTP_ERROR_FALLBACK;403");
    }
  });

  it("admits staff roles with the required permissions", async () => {
    for (const role of ["DISPATCHER", "ADMIN", "SUPER_ADMIN", "FINANCE"] as const) {
      current.actor = actor(role);
      await expect(requireAdminArea(), role).resolves.toBeDefined();
    }
  });

  it("sends privileged roles without MFA to the MFA setup instead of granting access", async () => {
    current.actor = actor("ADMIN", { mfa: false });
    const digest = await digestOf(requireAdminArea());
    expect(digest).toMatch(/^NEXT_REDIRECT;.*\/account\/security\?reason=mfa-required/);
  });
});
