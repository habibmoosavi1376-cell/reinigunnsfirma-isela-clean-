import { createHmac } from "node:crypto";
import { DomainError } from "@isela/shared";
import { normalizeEmail, normalizePhone } from "@isela/validation";

export type IdentityKind = "EMAIL" | "PHONE" | "TAX_ID" | "PAYMENT_REFERENCE" | "ADDRESS";

/** Kinds that identify exactly one customer system-wide. */
export const UNIQUE_IDENTITY_KINDS: ReadonlySet<IdentityKind> = new Set([
  "EMAIL",
  "TAX_ID",
  "PAYMENT_REFERENCE",
]);

export interface CrmConfig {
  /** Secret pepper (≥ 32 characters) for identity hashes. Never stored in the database. */
  readonly identityPepper: string;
}

export function assertCrmConfig(config: CrmConfig): void {
  if (config.identityPepper.length < 32) {
    throw new DomainError(
      "CONFIGURATION_ERROR",
      "IDENTITY_HASH_PEPPER must be at least 32 characters",
    );
  }
}

/** Keyed hash (HMAC-SHA-256) of a normalised identity value; no plain text is stored. */
export function hashIdentity(
  config: CrmConfig,
  kind: IdentityKind,
  normalizedValue: string,
): string {
  assertCrmConfig(config);
  return createHmac("sha256", config.identityPepper)
    .update(`${kind}:${normalizedValue}`)
    .digest("hex");
}

/** Keyed hash for non-identity purposes (e.g. rate-limit keys), namespaced to avoid reuse. */
export function keyedHash(config: CrmConfig, namespace: string, value: string): string {
  assertCrmConfig(config);
  return createHmac("sha256", config.identityPepper).update(`${namespace}:${value}`).digest("hex");
}

export function normalizeTaxId(raw: string): string {
  return raw.replace(/[\s.-]/g, "").toUpperCase();
}

/** Payment references (e.g. IBAN, mandate reference): spaces/dots/dashes removed, upper case. */
export function normalizePaymentReference(raw: string): string {
  return raw.replace(/[\s.-]/g, "").toUpperCase();
}

export function normalizeAddress(address: {
  street: string;
  houseNumber: string;
  postalCode: string;
  country: string;
}): string {
  const compact = (value: string) =>
    value
      .toLowerCase()
      .replace(/[\s.,-]/g, "")
      .replace(/straße$|strasse$|str$/, "str");
  return [
    compact(address.street),
    compact(address.houseNumber),
    address.postalCode.replace(/\s/g, "").toUpperCase(),
    address.country.toUpperCase(),
  ].join("|");
}

export interface IdentityInput {
  readonly email?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly taxId?: string | null | undefined;
  readonly paymentReference?: string | null | undefined;
}

export interface IdentityHash {
  readonly kind: IdentityKind;
  readonly valueHash: string;
}

export function identityHashesFor(config: CrmConfig, input: IdentityInput): IdentityHash[] {
  const hashes: IdentityHash[] = [];
  if (input.email != null) {
    hashes.push({
      kind: "EMAIL",
      valueHash: hashIdentity(config, "EMAIL", normalizeEmail(input.email)),
    });
  }
  if (input.taxId != null) {
    hashes.push({
      kind: "TAX_ID",
      valueHash: hashIdentity(config, "TAX_ID", normalizeTaxId(input.taxId)),
    });
  }
  if (input.paymentReference != null) {
    hashes.push({
      kind: "PAYMENT_REFERENCE",
      valueHash: hashIdentity(
        config,
        "PAYMENT_REFERENCE",
        normalizePaymentReference(input.paymentReference),
      ),
    });
  }
  if (input.phone != null) {
    const phone = normalizePhone(input.phone);
    if (phone !== null) {
      hashes.push({ kind: "PHONE", valueHash: hashIdentity(config, "PHONE", phone) });
    }
  }
  return hashes;
}
