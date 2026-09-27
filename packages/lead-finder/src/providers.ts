import { DomainError } from "@isela/shared";

export const LEAD_PROVIDER_KINDS = [
  "BUSINESS_SEARCH",
  "PUBLIC_OPPORTUNITY",
  "WEBSITE_RESEARCH",
  "REFERRAL",
  "INTERNAL_INBOUND",
] as const;
export type LeadProviderKind = (typeof LEAD_PROVIDER_KINDS)[number];

/** Provider kinds that process third-party data and therefore require a terms review. */
export const EXTERNAL_PROVIDER_KINDS: ReadonlySet<LeadProviderKind> = new Set([
  "BUSINESS_SEARCH",
  "PUBLIC_OPPORTUNITY",
  "WEBSITE_RESEARCH",
]);

export type ProcessingLegalBasis =
  "GDPR_ART6_1A_CONSENT" | "GDPR_ART6_1B_CONTRACT" | "GDPR_ART6_1F_LEGITIMATE_INTEREST";

/** Compliance descriptor every provider must declare (docs/DOMAIN_MODEL.md §12). */
export interface LeadProviderDescriptor {
  readonly providerId: string;
  readonly providerKind: LeadProviderKind;
  readonly legalBasis: ProcessingLegalBasis;
  readonly termsReviewedAt: Date | null;
  readonly allowedUse: string | null;
  readonly retentionDays: number;
  readonly rateLimitPerMinute: number;
  readonly enabled: boolean;
  readonly sourceMetadata: Readonly<Record<string, unknown>>;
}

/**
 * Throws unless the provider may be used: it must be enabled, declare its allowed use and –
 * for external providers – have a documented terms review. The database enforces the same
 * rule with a CHECK constraint; this guard protects code paths that use descriptors directly.
 */
export function assertProviderUsable(provider: LeadProviderDescriptor): void {
  if (!provider.enabled) {
    throw new DomainError("POLICY_VIOLATION", "Lead provider is disabled", {
      providerId: provider.providerId,
    });
  }
  if (provider.allowedUse === null || provider.allowedUse.trim() === "") {
    throw new DomainError("POLICY_VIOLATION", "Lead provider has no documented allowed use", {
      providerId: provider.providerId,
    });
  }
  if (EXTERNAL_PROVIDER_KINDS.has(provider.providerKind) && provider.termsReviewedAt === null) {
    throw new DomainError("POLICY_VIOLATION", "External lead provider lacks a terms review", {
      providerId: provider.providerId,
    });
  }
}

/**
 * Highest lead status an automated process may set. Contacting a lead always requires a
 * human decision – there is no automated outreach.
 */
export const MAX_AUTOMATED_LEAD_STATUS = "OUTREACH_DRAFTED";
