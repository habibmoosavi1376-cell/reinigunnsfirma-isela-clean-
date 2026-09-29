import { recordAudit, type AuditActor } from "@isela/audit";
import { auditActorOf, authorize, requireActor, type ServiceContext } from "@isela/auth";
import { checkServiceAvailability } from "@isela/catalog";
import {
  and,
  consumeRateLimit,
  desc,
  eq,
  schema,
  type Database,
  type Transaction,
} from "@isela/database";
import {
  DEFAULT_ACCEPTANCE_POLICY,
  assessGeocodeResult,
  normalizeAddressQuery,
  type GeocodeAcceptancePolicy,
  type GeocodeAssessment,
  type GeocodeCandidate,
  type GeocodeResult,
  type GeocodingProvider,
} from "@isela/geocoding";
import { DomainError, type Clock } from "@isela/shared";
import { isValidPostalCode, parseInput, trimmedText, z } from "@isela/validation";

/*
 * Address pipeline for service requests:
 *   stored user input → normalisation → provider (outside any DB transaction) →
 *   assessment (quality/confidence) → append-only geocoding_attempt →
 *   trusted coordinates only → PostGIS service-area check → audit.
 * The browser never supplies coordinates, service areas or statuses.
 */

export interface GeocodingDeps {
  /** null = no provider configured: nothing is geocoded, status stays PENDING/UNKNOWN. */
  readonly provider: GeocodingProvider | null;
  readonly policy?: GeocodeAcceptancePolicy;
  /** Global provider budget (protects quota and the provider). */
  readonly maxRequestsPerMinute: number;
}

export type GeocodingRunStatus =
  "NOT_CONFIGURED" | "ACCEPTED" | "NEEDS_REVIEW" | "NO_MATCH" | "UNAVAILABLE";

export interface GeocodingRunResult {
  readonly status: GeocodingRunStatus;
  readonly serviceAvailability: "AVAILABLE" | "NOT_AVAILABLE" | "UNKNOWN";
}

interface Runtime {
  readonly db: Database;
  readonly clock: Clock;
  readonly actor: AuditActor;
  readonly correlationId?: string | undefined;
}

interface StoredAddress {
  readonly street: string;
  readonly houseNumber: string;
  readonly postalCode: string;
  readonly city: string;
  readonly country: string;
}

async function loadAddress(db: Database, serviceRequestId: string): Promise<StoredAddress> {
  const r = schema.serviceRequest;
  const [row] = await db
    .select({
      street: r.street,
      houseNumber: r.houseNumber,
      postalCode: r.postalCode,
      city: r.city,
      country: r.country,
    })
    .from(r)
    .where(eq(r.id, serviceRequestId))
    .limit(1);
  if (row === undefined) {
    throw new DomainError("NOT_FOUND", "Service request not found");
  }
  return row;
}

/** Same address as when geocoding started (optimistic concurrency against edits). */
function addressUnchanged(serviceRequestId: string, address: StoredAddress) {
  const r = schema.serviceRequest;
  return and(
    eq(r.id, serviceRequestId),
    eq(r.street, address.street),
    eq(r.houseNumber, address.houseNumber),
    eq(r.postalCode, address.postalCode),
    eq(r.city, address.city),
  );
}

function attemptValues(
  serviceRequestId: string,
  provider: string,
  assessment: GeocodeAssessment,
): typeof schema.geocodingAttempt.$inferInsert {
  const base = { serviceRequestId, provider };
  switch (assessment.outcome) {
    case "ACCEPTED":
    case "NEEDS_REVIEW":
      return {
        ...base,
        outcome: assessment.outcome,
        ...candidateColumns(assessment.candidate),
        reasons: assessment.outcome === "NEEDS_REVIEW" ? [...assessment.reasons] : [],
      };
    case "NO_MATCH":
      return { ...base, outcome: "NO_MATCH", reasons: [...assessment.reasons] };
    case "UNAVAILABLE":
      return { ...base, outcome: "UNAVAILABLE", reasons: [assessment.reason] };
  }
}

function candidateColumns(candidate: GeocodeCandidate) {
  return {
    precision: candidate.precision,
    confidence: Math.round(candidate.confidence * 1000) / 1000,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    street: candidate.street,
    houseNumber: candidate.houseNumber,
    postalCode: candidate.postalCode,
    city: candidate.city,
    region: candidate.region,
    country: candidate.country,
  };
}

/**
 * Applies trusted coordinates (or none) to the request and recomputes availability with the
 * generic PostGIS lookup. Audits geocoding and, when it changed, the service-area result.
 */
async function applyResult(
  rt: Runtime,
  tx: Transaction,
  serviceRequestId: string,
  address: StoredAddress | null,
  outcome: {
    readonly geocodingStatus: "PENDING" | "SUCCEEDED" | "FAILED" | "MANUAL" | "NEEDS_REVIEW";
    readonly point: { latitude: number; longitude: number } | null;
    readonly attemptId: string | null;
    readonly auditAction: string;
    readonly auditDetails: Record<string, unknown>;
  },
): Promise<GeocodingRunResult["serviceAvailability"]> {
  const r = schema.serviceRequest;
  const [before] = await tx
    .select({ status: r.serviceAreaStatus, areaId: r.serviceAreaId })
    .from(r)
    .where(eq(r.id, serviceRequestId))
    .for("update")
    .limit(1);
  if (before === undefined) {
    throw new DomainError("NOT_FOUND", "Service request not found");
  }
  const availability = await checkServiceAvailability(tx, outcome.point);
  const now = rt.clock.now();
  const updated = await tx
    .update(r)
    .set({
      latitude: outcome.point?.latitude ?? null,
      longitude: outcome.point?.longitude ?? null,
      geocodingStatus: outcome.geocodingStatus,
      serviceAreaStatus: availability.status,
      serviceAreaId: availability.serviceArea?.id ?? null,
      serviceAreaCheckedAt: outcome.point === null ? null : now,
    })
    .where(
      address === null ? eq(r.id, serviceRequestId) : addressUnchanged(serviceRequestId, address),
    )
    .returning({ id: r.id });
  if (updated.length === 0) {
    throw new DomainError("CONFLICT", "The address was changed while geocoding; please retry");
  }
  await recordAudit(tx, {
    actor: rt.actor,
    action: outcome.auditAction,
    entityType: "service_request",
    entityId: serviceRequestId,
    after: {
      ...outcome.auditDetails,
      attemptId: outcome.attemptId,
      geocodingStatus: outcome.geocodingStatus,
    },
    correlationId: rt.correlationId,
  });
  const newAreaId = availability.serviceArea?.id ?? null;
  if (before.status !== availability.status || before.areaId !== newAreaId) {
    await recordAudit(tx, {
      actor: rt.actor,
      action: "service_request.service_area_changed",
      entityType: "service_request",
      entityId: serviceRequestId,
      before: { serviceAreaStatus: before.status, serviceAreaId: before.areaId },
      after: { serviceAreaStatus: availability.status, serviceAreaId: newAreaId },
      correlationId: rt.correlationId,
    });
  }
  return availability.status;
}

/** Runs the provider for a stored request and records the outcome. Never trusts the browser. */
async function runGeocoding(
  rt: Runtime,
  serviceRequestId: string,
  deps: GeocodingDeps,
): Promise<GeocodingRunResult> {
  if (deps.provider === null) {
    return { status: "NOT_CONFIGURED", serviceAvailability: "UNKNOWN" };
  }
  const provider = deps.provider;
  const address = await loadAddress(rt.db, serviceRequestId);
  const query = normalizeAddressQuery(address);

  const budget = await consumeRateLimit(
    rt.db,
    `geocoding:provider:${provider.id}`,
    deps.maxRequestsPerMinute,
    60,
    rt.clock.now(),
  );
  let result: GeocodeResult;
  if (!budget.allowed) {
    result = { status: "UNAVAILABLE", provider: provider.id, reason: "RATE_LIMITED" };
  } else {
    try {
      result = await provider.geocode(query);
    } catch {
      // Providers must not throw; if one does, it is treated as unavailable.
      result = { status: "UNAVAILABLE", provider: provider.id, reason: "PROVIDER_ERROR" };
    }
  }
  const assessment = assessGeocodeResult(query, result, deps.policy ?? DEFAULT_ACCEPTANCE_POLICY);

  return rt.db.transaction(async (tx) => {
    const [attempt] = await tx
      .insert(schema.geocodingAttempt)
      .values(attemptValues(serviceRequestId, provider.id, assessment))
      .returning({ id: schema.geocodingAttempt.id });
    const accepted = assessment.outcome === "ACCEPTED" ? assessment.candidate : null;
    const geocodingStatus =
      assessment.outcome === "ACCEPTED"
        ? "SUCCEEDED"
        : assessment.outcome === "NEEDS_REVIEW"
          ? "NEEDS_REVIEW"
          : assessment.outcome === "NO_MATCH"
            ? "FAILED"
            : "PENDING";
    const availability = await applyResult(rt, tx, serviceRequestId, address, {
      geocodingStatus,
      point:
        accepted === null ? null : { latitude: accepted.latitude, longitude: accepted.longitude },
      attemptId: attempt?.id ?? null,
      auditAction: "service_request.geocoded",
      auditDetails: {
        provider: provider.id,
        outcome: assessment.outcome,
        reasons:
          assessment.outcome === "NEEDS_REVIEW" || assessment.outcome === "NO_MATCH"
            ? assessment.reasons
            : assessment.outcome === "UNAVAILABLE"
              ? [assessment.reason]
              : [],
      },
    });
    return { status: assessment.outcome, serviceAvailability: availability };
  });
}

/** Called by the public request flow right after the request was stored (SYSTEM actor). */
export async function geocodeSubmittedRequest(
  runtime: { db: Database; clock: Clock; actor: AuditActor; correlationId?: string | undefined },
  serviceRequestId: string,
  deps: GeocodingDeps,
): Promise<GeocodingRunResult> {
  return runGeocoding(runtime, serviceRequestId, deps);
}

const requestIdInput = z.strictObject({ serviceRequestId: z.uuid() });

function staffRuntime(ctx: ServiceContext): Runtime & { userId: string } {
  const actor = requireActor(ctx.actor);
  authorize(actor, "lead:update");
  return {
    db: ctx.db,
    clock: ctx.clock,
    actor: auditActorOf(actor),
    correlationId: ctx.correlationId,
    userId: actor.userId,
  };
}

/** Staff: re-run geocoding (e.g. after a provider outage). */
export async function rerunRequestGeocoding(
  ctx: ServiceContext,
  input: unknown,
  deps: GeocodingDeps,
): Promise<GeocodingRunResult> {
  const rt = staffRuntime(ctx);
  const { serviceRequestId } = parseInput(requestIdInput, input);
  return runGeocoding(rt, serviceRequestId, deps);
}

const reviewInput = z.strictObject({
  serviceRequestId: z.uuid(),
  attemptId: z.uuid(),
  decision: z.enum(["CONFIRM", "REJECT"]),
});

/**
 * Staff: human review of an uncertain match. Only the LATEST attempt of the same request can
 * be decided, and only if it is NEEDS_REVIEW – coordinates come from the stored provider
 * candidate, never from the browser.
 */
export async function reviewGeocodingCandidate(
  ctx: ServiceContext,
  input: unknown,
): Promise<GeocodingRunResult> {
  const rt = staffRuntime(ctx);
  const data = parseInput(reviewInput, input);
  return rt.db.transaction(async (tx) => {
    const a = schema.geocodingAttempt;
    const [latest] = await tx
      .select()
      .from(a)
      .where(eq(a.serviceRequestId, data.serviceRequestId))
      .orderBy(desc(a.createdAt), desc(a.id))
      .limit(1);
    if (latest?.id !== data.attemptId) {
      throw new DomainError("CONFLICT", "Only the latest geocoding result can be reviewed");
    }
    if (
      latest.outcome !== "NEEDS_REVIEW" ||
      latest.latitude === null ||
      latest.longitude === null
    ) {
      throw new DomainError("INVALID_STATE_TRANSITION", "This geocoding result needs no review");
    }
    const confirm = data.decision === "CONFIRM";
    const [attempt] = await tx
      .insert(a)
      .values({
        serviceRequestId: data.serviceRequestId,
        provider: latest.provider,
        outcome: confirm ? "MANUAL_CONFIRMED" : "MANUAL_REJECTED",
        precision: confirm ? latest.precision : null,
        confidence: confirm ? latest.confidence : null,
        latitude: confirm ? latest.latitude : null,
        longitude: confirm ? latest.longitude : null,
        street: latest.street,
        houseNumber: latest.houseNumber,
        postalCode: latest.postalCode,
        city: latest.city,
        region: latest.region,
        country: latest.country,
        reasons: latest.reasons,
        performedByUserId: rt.userId,
      })
      .returning({ id: a.id });
    const availability = await applyResult(rt, tx, data.serviceRequestId, null, {
      geocodingStatus: confirm ? "MANUAL" : "FAILED",
      point: confirm ? { latitude: latest.latitude, longitude: latest.longitude } : null,
      attemptId: attempt?.id ?? null,
      auditAction: confirm
        ? "service_request.geocoding_confirmed"
        : "service_request.geocoding_rejected",
      auditDetails: { reviewedAttemptId: latest.id },
    });
    return { status: confirm ? "ACCEPTED" : "NO_MATCH", serviceAvailability: availability };
  });
}

const correctAddressInput = z
  .strictObject({
    serviceRequestId: z.uuid(),
    street: trimmedText(200),
    houseNumber: trimmedText(20),
    postalCode: trimmedText(10),
    city: trimmedText(120),
  })
  .refine((a) => isValidPostalCode(a.postalCode, "DE"), {
    message: "Invalid postal code",
    path: ["postalCode"],
  });

/**
 * Staff: corrects the service address (e.g. after a phone call). Clears coordinates and the
 * availability result, audits which fields changed (no values), then geocodes again.
 */
export async function correctRequestAddress(
  ctx: ServiceContext,
  input: unknown,
  deps: GeocodingDeps,
): Promise<GeocodingRunResult> {
  const rt = staffRuntime(ctx);
  const data = parseInput(correctAddressInput, input);
  await rt.db.transaction(async (tx) => {
    const r = schema.serviceRequest;
    const [before] = await tx
      .select({
        street: r.street,
        houseNumber: r.houseNumber,
        postalCode: r.postalCode,
        city: r.city,
        country: r.country,
        serviceAreaStatus: r.serviceAreaStatus,
        serviceAreaId: r.serviceAreaId,
      })
      .from(r)
      .where(eq(r.id, data.serviceRequestId))
      .for("update")
      .limit(1);
    if (before === undefined) {
      throw new DomainError("NOT_FOUND", "Service request not found");
    }
    if (before.country !== "DE") {
      throw new DomainError("VALIDATION_FAILED", "Only German addresses can be corrected here");
    }
    const changed = (["street", "houseNumber", "postalCode", "city"] as const).filter(
      (field) => before[field] !== data[field],
    );
    if (changed.length === 0) {
      throw new DomainError("VALIDATION_FAILED", "Nothing to update");
    }
    await tx
      .update(r)
      .set({
        street: data.street,
        houseNumber: data.houseNumber,
        postalCode: data.postalCode,
        city: data.city,
        latitude: null,
        longitude: null,
        geocodingStatus: "PENDING",
        serviceAreaStatus: "UNKNOWN",
        serviceAreaId: null,
        serviceAreaCheckedAt: null,
      })
      .where(eq(r.id, data.serviceRequestId));
    await recordAudit(tx, {
      actor: rt.actor,
      action: "service_request.address_changed",
      entityType: "service_request",
      entityId: data.serviceRequestId,
      // Field names only (no address values); the availability result is reset with it.
      before: { serviceAreaStatus: before.serviceAreaStatus, serviceAreaId: before.serviceAreaId },
      after: { changedFields: changed, serviceAreaStatus: "UNKNOWN", serviceAreaId: null },
      correlationId: rt.correlationId,
    });
  });
  return runGeocoding(rt, data.serviceRequestId, deps);
}
