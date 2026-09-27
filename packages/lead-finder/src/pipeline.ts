import type { LeadProviderDescriptor, LeadProviderKind } from "./providers.ts";
import { EXTERNAL_PROVIDER_KINDS } from "./providers.ts";
import type { LeadScoringConfig } from "./scoring.ts";

/*
 * LeadFinder architecture (no provider is implemented yet – no scraping, no outreach):
 *
 *   Provider → RawOpportunity → Compliance check → Normalize → Deduplicate → Score
 *            → Human review → CRM lead (createLead, requires a person with lead:create)
 *
 * Every stage is a pure function so that it can be tested and audited independently.
 */

/** Terms-of-service status of a provider (documented per provider, reviewed by a person). */
export type TermsStatus = "REVIEWED_ALLOWED" | "NOT_REVIEWED" | "PROHIBITED";

/**
 * Techniques that are never allowed. Typed as the literal `false`: a provider declaring any
 * of them does not compile, and the runtime check rejects forged objects as well.
 */
export interface ProhibitedTechniques {
  readonly captchaBypass: false;
  readonly loginBypass: false;
  readonly termsCircumvention: false;
  readonly automatedOutreach: false;
  readonly massScraping: false;
}

export const NO_PROHIBITED_TECHNIQUES: ProhibitedTechniques = {
  captchaBypass: false,
  loginBypass: false,
  termsCircumvention: false,
  automatedOutreach: false,
  massScraping: false,
};

/** Full provider contract: compliance descriptor + source + terms status. */
export interface LeadProviderContract<
  K extends LeadProviderKind = LeadProviderKind,
> extends LeadProviderDescriptor {
  readonly providerKind: K;
  /** Where the data comes from (human-readable, e.g. API name or "Empfehlung durch Kunden"). */
  readonly source: string;
  readonly termsStatus: TermsStatus;
  readonly prohibited: ProhibitedTechniques;
}

export interface DiscoveryQuery {
  /** Search area and segment are data (service areas/categories), never code constants. */
  readonly serviceAreaKey: string;
  readonly segment: string;
  readonly limit: number;
}

export interface RawOpportunity {
  readonly providerId: string;
  readonly providerKind: LeadProviderKind;
  readonly externalReference: string;
  readonly collectedAt: Date;
  readonly companyName: string;
  readonly website?: string;
  readonly street?: string;
  readonly houseNumber?: string;
  readonly postalCode?: string;
  readonly city?: string;
  readonly category?: string;
  /** Observed demand/fit signals, e.g. "tender:cleaning", "new-office" (explainable). */
  readonly signals: readonly string[];
}

export interface LeadDiscoveryProvider<K extends LeadProviderKind> {
  readonly contract: LeadProviderContract<K>;
  discover(query: DiscoveryQuery, signal?: AbortSignal): Promise<readonly RawOpportunity[]>;
}

export type BusinessSearchProvider = LeadDiscoveryProvider<"BUSINESS_SEARCH">;
export type PublicOpportunityProvider = LeadDiscoveryProvider<"PUBLIC_OPPORTUNITY">;
export type WebsiteResearchProvider = LeadDiscoveryProvider<"WEBSITE_RESEARCH">;
export type ReferralProvider = LeadDiscoveryProvider<"REFERRAL">;
export type InternalInboundProvider = LeadDiscoveryProvider<"INTERNAL_INBOUND">;

export type ComplianceViolation =
  | "PROVIDER_DISABLED"
  | "NO_ALLOWED_USE"
  | "TERMS_NOT_REVIEWED"
  | "TERMS_PROHIBIT_USE"
  | "PROHIBITED_TECHNIQUE"
  | "KIND_MISMATCH"
  | "RETENTION_EXPIRED"
  | "INVALID_RETENTION"
  | "INVALID_RATE_LIMIT";

/** Stage 1: may this opportunity from this provider be processed at all? */
export function checkCompliance(
  contract: LeadProviderContract,
  opportunity: RawOpportunity,
  now: Date,
): { readonly allowed: boolean; readonly violations: readonly ComplianceViolation[] } {
  const violations: ComplianceViolation[] = [];
  if (!contract.enabled) violations.push("PROVIDER_DISABLED");
  if (contract.allowedUse === null || contract.allowedUse.trim() === "") {
    violations.push("NO_ALLOWED_USE");
  }
  if (contract.termsStatus === "PROHIBITED") violations.push("TERMS_PROHIBIT_USE");
  if (
    EXTERNAL_PROVIDER_KINDS.has(contract.providerKind) &&
    (contract.termsStatus !== "REVIEWED_ALLOWED" || contract.termsReviewedAt === null)
  ) {
    violations.push("TERMS_NOT_REVIEWED");
  }
  const techniques = contract.prohibited as unknown as Record<string, unknown>;
  if (Object.values(techniques).some((value) => value !== false)) {
    violations.push("PROHIBITED_TECHNIQUE");
  }
  if (
    opportunity.providerId !== contract.providerId ||
    opportunity.providerKind !== contract.providerKind
  ) {
    violations.push("KIND_MISMATCH");
  }
  if (
    !Number.isInteger(contract.retentionDays) ||
    contract.retentionDays < 1 ||
    contract.retentionDays > 1095
  ) {
    violations.push("INVALID_RETENTION");
  } else if (
    now.getTime() - opportunity.collectedAt.getTime() >
    contract.retentionDays * 24 * 3600 * 1000
  ) {
    violations.push("RETENTION_EXPIRED");
  }
  if (
    !Number.isInteger(contract.rateLimitPerMinute) ||
    contract.rateLimitPerMinute < 1 ||
    contract.rateLimitPerMinute > 600
  ) {
    violations.push("INVALID_RATE_LIMIT");
  }
  return { allowed: violations.length === 0, violations };
}

export interface NormalizedOpportunity {
  readonly providerId: string;
  readonly externalReference: string;
  readonly companyName: string;
  readonly websiteHost: string | null;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly street: string | null;
  readonly houseNumber: string | null;
  readonly category: string | null;
  readonly signals: readonly string[];
}

function clean(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const collapsed = value.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, max);
  return collapsed === "" ? null : collapsed;
}

function hostOf(website: string | undefined): string | null {
  if (website === undefined) return null;
  try {
    const url = new URL(website);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Stage 2: normalisation (no enrichment, no network access). */
export function normalizeOpportunity(raw: RawOpportunity): NormalizedOpportunity {
  return {
    providerId: raw.providerId,
    externalReference: raw.externalReference,
    companyName: clean(raw.companyName, 200) ?? "",
    websiteHost: hostOf(raw.website),
    postalCode: clean(raw.postalCode, 10)?.replace(/\s/g, "") ?? null,
    city: clean(raw.city, 120),
    street: clean(raw.street, 200),
    houseNumber: clean(raw.houseNumber, 20),
    category: clean(raw.category, 100),
    signals: [
      ...new Set(raw.signals.map((s) => s.trim().toLowerCase()).filter((s) => s !== "")),
    ].slice(0, 20),
  };
}

/** Stage 3: deduplication key – website host, else company name + postal code. */
export function deduplicationKey(opportunity: NormalizedOpportunity): string {
  if (opportunity.websiteHost !== null) return `host:${opportunity.websiteHost}`;
  const name = opportunity.companyName
    .toLowerCase()
    .replace(/\b(gmbh|ug|ag|kg|ohg|gbr|e\.?\s?k\.?|mbh|co)\b/g, "")
    .replace(/[^a-z0-9äöüß]/g, "");
  return `name:${name}|${opportunity.postalCode ?? ""}`;
}

export function deduplicate(
  opportunities: readonly NormalizedOpportunity[],
  existingKeys: ReadonlySet<string>,
): { readonly unique: NormalizedOpportunity[]; readonly duplicates: NormalizedOpportunity[] } {
  const seen = new Set(existingKeys);
  const unique: NormalizedOpportunity[] = [];
  const duplicates: NormalizedOpportunity[] = [];
  for (const opportunity of opportunities) {
    const key = deduplicationKey(opportunity);
    if (seen.has(key)) {
      duplicates.push(opportunity);
    } else {
      seen.add(key);
      unique.push(opportunity);
    }
  }
  return { unique, duplicates };
}

/** Factor values 0..1, determined by explainable rules (e.g. PostGIS area fit). */
export type ScoringFactors = Readonly<Record<keyof LeadScoringConfig["weights"], number>>;

/** Stage 4: explainable score 0..100 from configured weights (setting `lead.scoring`). */
export function scoreOpportunity(
  factors: ScoringFactors,
  config: LeadScoringConfig,
): { readonly score: number; readonly breakdown: Readonly<Record<string, number>> } {
  const breakdown: Record<string, number> = {};
  let score = 0;
  for (const [name, weight] of Object.entries(config.weights) as [keyof ScoringFactors, number][]) {
    const factor = Math.min(1, Math.max(0, Number.isFinite(factors[name]) ? factors[name] : 0));
    const points = Math.round(weight * factor * 100) / 100;
    breakdown[name] = points;
    score += points;
  }
  return { score: Math.round(score), breakdown };
}

export interface ReviewItem {
  readonly status: "PENDING_HUMAN_REVIEW";
  readonly opportunity: NormalizedOpportunity;
  readonly deduplicationKey: string;
  readonly score: number;
  readonly scoreBreakdown: Readonly<Record<string, number>>;
}

/**
 * Stage 5: every opportunity ends in human review. Creating a CRM lead is a separate,
 * authorised action by a person; contacting it requires another human decision.
 */
export function toReviewItem(
  opportunity: NormalizedOpportunity,
  scored: { score: number; breakdown: Readonly<Record<string, number>> },
): ReviewItem {
  return {
    status: "PENDING_HUMAN_REVIEW",
    opportunity,
    deduplicationKey: deduplicationKey(opportunity),
    score: scored.score,
    scoreBreakdown: scored.breakdown,
  };
}
