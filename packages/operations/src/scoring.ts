import type { OperationsConfig, PartnerDocumentKind } from "./config.ts";

/*
 * Assignment candidates (pure, explainable). Hard rules decide eligibility; only eligible
 * candidates are scored. The score is a weighted average of named factors in [0, 1] with the
 * configured weights – every factor, weight and contribution is returned, so a dispatcher can
 * see exactly why a candidate ranks where it does. Factors without data (e.g. reliability
 * before any job history exists) are reported as NO_DATA and excluded from the average.
 * No automatic assignment happens here: a person chooses, the server re-checks.
 */

export type CandidateBlocker =
  | "INACTIVE"
  | "NOT_VERIFIED"
  | "PARTNER_ASSIGNMENT_DISABLED"
  | "MISSING_QUALIFICATION"
  | "SERVICE_NOT_OFFERED"
  | "SERVICE_UNKNOWN"
  | "SERVICE_AREA_UNKNOWN"
  | "OUTSIDE_SERVICE_AREA"
  | "OUTSIDE_WORKING_HOURS"
  | "UNAVAILABLE"
  | "TIME_CONFLICT"
  | "CAPACITY_EXHAUSTED"
  | "CAPACITY_NOT_CONFIGURED"
  | "DOCUMENTS_MISSING";

export interface JobRequirements {
  readonly requiredQualifications: readonly string[];
  /** Catalogue service ids of the booking; NULL entries = items without a catalogue service. */
  readonly serviceIds: readonly (string | null)[];
  /** Service area of the address (NULL = address without coordinates or outside all areas). */
  readonly serviceAreaId: string | null;
  /** Business-local interval; NULL when it spans several days. */
  readonly local: { weekday: number; startMinute: number; endMinute: number } | null;
  /** Business date of the job (YYYY-MM-DD) for document validity. */
  readonly date: string;
}

export interface EmployeeFacts {
  readonly kind: "EMPLOYEE";
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly qualifications: readonly string[];
  readonly serviceAreaIds: readonly string[];
  readonly workingWindows: readonly { startMinute: number; endMinute: number }[];
  readonly unavailable: boolean;
  readonly overlappingAssignments: number;
  readonly jobsThatDay: number;
  readonly maxJobsPerDay: number | null;
  readonly distanceM: number | null;
}

export interface PartnerFacts {
  readonly kind: "PARTNER";
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly verified: boolean;
  readonly offeredServiceIds: readonly string[];
  /** Point within the partner's own service radius. */
  readonly coversAddress: boolean;
  readonly validDocumentKinds: readonly PartnerDocumentKind[];
  readonly overlappingAssignments: number;
  readonly maxConcurrentJobs: number | null;
  readonly distanceM: number | null;
}

export type CandidateFacts = EmployeeFacts | PartnerFacts;

export type FactorKey =
  "distance" | "qualification" | "availability" | "serviceMatch" | "capacity" | "reliability";

export interface ScoreFactor {
  readonly key: FactorKey;
  /** Normalised value in [0, 1]; NULL = no data. */
  readonly value: number | null;
  readonly weight: number;
  /** Points contributed to the 0–100 score (after normalisation over available weights). */
  readonly contribution: number;
}

export interface AssignmentCandidate {
  readonly kind: "EMPLOYEE" | "PARTNER";
  readonly employeeId: string | null;
  readonly partnerId: string | null;
  readonly name: string;
  readonly distanceM: number | null;
  readonly qualificationMatch: boolean;
  readonly availability: boolean;
  readonly serviceMatch: boolean;
  readonly serviceAreaMatch: boolean;
  readonly capacity: { readonly used: number; readonly max: number | null };
  readonly eligible: boolean;
  readonly blockers: readonly CandidateBlocker[];
  readonly score: number | null;
  readonly factors: readonly ScoreFactor[];
}

function evaluateEmployee(
  facts: EmployeeFacts,
  job: JobRequirements,
): { blockers: CandidateBlocker[]; qualification: boolean; availability: boolean; area: boolean } {
  const blockers: CandidateBlocker[] = [];
  if (!facts.active) blockers.push("INACTIVE");
  const qualification = job.requiredQualifications.every((q) => facts.qualifications.includes(q));
  if (!qualification) blockers.push("MISSING_QUALIFICATION");
  let area = false;
  if (job.serviceAreaId === null) {
    blockers.push("SERVICE_AREA_UNKNOWN");
  } else if (facts.serviceAreaIds.includes(job.serviceAreaId)) {
    area = true;
  } else {
    blockers.push("OUTSIDE_SERVICE_AREA");
  }
  const local = job.local;
  const inWindow =
    local !== null &&
    facts.workingWindows.some(
      (w) => w.startMinute <= local.startMinute && w.endMinute >= local.endMinute,
    );
  if (!inWindow) blockers.push("OUTSIDE_WORKING_HOURS");
  if (facts.unavailable) blockers.push("UNAVAILABLE");
  if (facts.overlappingAssignments > 0) blockers.push("TIME_CONFLICT");
  if (facts.maxJobsPerDay !== null && facts.jobsThatDay >= facts.maxJobsPerDay) {
    blockers.push("CAPACITY_EXHAUSTED");
  }
  const availability = inWindow && !facts.unavailable && facts.overlappingAssignments === 0;
  return { blockers, qualification, availability, area };
}

function evaluatePartner(
  facts: PartnerFacts,
  job: JobRequirements,
  config: OperationsConfig,
): {
  blockers: CandidateBlocker[];
  serviceMatch: boolean;
  availability: boolean;
  area: boolean;
} {
  const blockers: CandidateBlocker[] = [];
  if (!config.partnerAssignmentEnabled) blockers.push("PARTNER_ASSIGNMENT_DISABLED");
  if (!facts.active) blockers.push("INACTIVE");
  if (!facts.verified) blockers.push("NOT_VERIFIED");
  const missingDocuments = config.requiredPartnerDocumentKinds.some(
    (kind) => !facts.validDocumentKinds.includes(kind),
  );
  if (missingDocuments) blockers.push("DOCUMENTS_MISSING");
  let serviceMatch = false;
  if (job.serviceIds.length === 0 || job.serviceIds.some((id) => id === null)) {
    blockers.push("SERVICE_UNKNOWN");
  } else if (job.serviceIds.every((id) => id !== null && facts.offeredServiceIds.includes(id))) {
    serviceMatch = true;
  } else {
    blockers.push("SERVICE_NOT_OFFERED");
  }
  if (job.serviceAreaId === null) blockers.push("SERVICE_AREA_UNKNOWN");
  if (!facts.coversAddress) blockers.push("OUTSIDE_SERVICE_AREA");
  if (facts.maxConcurrentJobs === null) {
    blockers.push("CAPACITY_NOT_CONFIGURED");
  } else if (facts.overlappingAssignments >= facts.maxConcurrentJobs) {
    blockers.push("CAPACITY_EXHAUSTED");
  }
  const availability =
    facts.maxConcurrentJobs !== null && facts.overlappingAssignments < facts.maxConcurrentJobs;
  return {
    blockers,
    serviceMatch,
    availability,
    area: job.serviceAreaId !== null && facts.coversAddress,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Weighted score over the factors that have data (0–100, integer). */
export function scoreFactors(
  values: Readonly<Record<FactorKey, number | null>>,
  weights: OperationsConfig["scoringWeights"],
): { score: number; factors: ScoreFactor[] } {
  const keys = Object.keys(weights) as FactorKey[];
  const available = keys.filter((k) => values[k] !== null && weights[k] > 0);
  const totalWeight = available.reduce((sum, k) => sum + weights[k], 0);
  const factors = keys.map((key) => {
    const value = values[key];
    const contribution =
      value === null || totalWeight === 0 ? 0 : (100 * weights[key] * value) / totalWeight;
    return {
      key,
      value: value === null ? null : round(value),
      weight: weights[key],
      contribution: round(contribution),
    };
  });
  const score =
    totalWeight === 0 ? 0 : Math.round(factors.reduce((sum, f) => sum + f.contribution, 0));
  return { score: Math.min(100, Math.max(0, score)), factors };
}

export function evaluateCandidate(
  facts: CandidateFacts,
  job: JobRequirements,
  config: OperationsConfig,
): AssignmentCandidate {
  const distanceValue =
    facts.distanceM === null ? null : Math.max(0, 1 - facts.distanceM / config.distanceReferenceM);
  let blockers: CandidateBlocker[];
  let qualificationMatch: boolean;
  let serviceMatch: boolean;
  let availability: boolean;
  let serviceAreaMatch: boolean;
  let capacityValue: number | null;
  let capacity: { used: number; max: number | null };
  if (facts.kind === "EMPLOYEE") {
    const e = evaluateEmployee(facts, job);
    blockers = e.blockers;
    qualificationMatch = e.qualification;
    // Employees match a service through their qualifications.
    serviceMatch = e.qualification;
    availability = e.availability;
    serviceAreaMatch = e.area;
    capacity = { used: facts.jobsThatDay, max: facts.maxJobsPerDay };
    capacityValue =
      facts.maxJobsPerDay === null
        ? null
        : Math.max(0, 1 - facts.jobsThatDay / facts.maxJobsPerDay);
  } else {
    const p = evaluatePartner(facts, job, config);
    blockers = p.blockers;
    serviceMatch = p.serviceMatch;
    // Partners qualify through the services they offer and their verification.
    qualificationMatch = p.serviceMatch && facts.verified;
    availability = p.availability;
    serviceAreaMatch = p.area;
    capacity = { used: facts.overlappingAssignments, max: facts.maxConcurrentJobs };
    capacityValue =
      facts.maxConcurrentJobs === null
        ? null
        : Math.max(0, 1 - facts.overlappingAssignments / facts.maxConcurrentJobs);
  }
  const eligible = blockers.length === 0;
  const base = {
    kind: facts.kind,
    employeeId: facts.kind === "EMPLOYEE" ? facts.id : null,
    partnerId: facts.kind === "PARTNER" ? facts.id : null,
    name: facts.name,
    distanceM: facts.distanceM,
    qualificationMatch,
    availability,
    serviceMatch,
    serviceAreaMatch,
    capacity,
    eligible,
    blockers,
  };
  if (!eligible) {
    return { ...base, score: null, factors: [] };
  }
  const { score, factors } = scoreFactors(
    {
      distance: distanceValue,
      qualification: qualificationMatch ? 1 : 0,
      availability: availability ? 1 : 0,
      serviceMatch: serviceMatch ? 1 : 0,
      capacity: capacityValue,
      // No reliability data is recorded yet (quality module follows); never guessed.
      reliability: null,
    },
    config.scoringWeights,
  );
  return { ...base, score, factors };
}

/** Eligible candidates first (highest score, then shortest distance, then name). */
export function rankCandidates(candidates: readonly AssignmentCandidate[]): AssignmentCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    const scoreDiff = (b.score ?? -1) - (a.score ?? -1);
    if (scoreDiff !== 0) return scoreDiff;
    const da = a.distanceM ?? Number.MAX_SAFE_INTEGER;
    const db = b.distanceM ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name, "de");
  });
}
