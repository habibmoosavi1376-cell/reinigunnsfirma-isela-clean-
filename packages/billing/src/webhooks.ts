import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { recordAudit, type AuditActor } from "@isela/audit";
import { auditActorOf, requireActor, type ServiceContext } from "@isela/auth";
import { and, eq, schema, type Database } from "@isela/database";
import { lockCustomerFinance } from "@isela/payment-risk";
import type { Clock } from "@isela/shared";
import { DomainError } from "@isela/shared";
import { parseInput, z } from "@isela/validation";
import { reevaluateCustomer } from "./evaluation.ts";
import {
  applyPaymentChange,
  lockBookingRow,
  lockInvoice,
  lockPayment,
  requireGlobal,
  type FinanceOptions,
} from "./internal.ts";
import { MAX_AMOUNT_CENTS } from "./money.ts";
import { applyChargeback, applyConfirmation, applyRefundCompleted } from "./payments.ts";
import {
  requireConfiguredProvider,
  type PaymentProvider,
  type ProviderPaymentStatus,
} from "./provider.ts";
import { PAYABLE_INVOICE_STATUSES, PAYMENT_METHODS } from "./state-machines.ts";

/*
 * Webhook security architecture (provider-neutral):
 * 1. fixed provider configuration on the server (key + signing secret; never from the request),
 * 2. signature over "<timestamp>.<raw body>" (HMAC-SHA256), compared in constant time,
 * 3. timestamp tolerance (default 300 s) against replays of old deliveries,
 * 4. strict payload schema (unknown fields rejected),
 * 5. idempotency: unique (provider, provider_event_id) – duplicates and replays are recognised
 *    and never applied twice,
 * 6. the body is never trusted alone: success is re-verified server-to-server
 *    (`provider.verifyPayment`), amounts/currency must match the recorded payment,
 * 7. out-of-order events that the state machine does not allow are stored as IGNORED.
 */

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface WebhookProviderConfig {
  readonly provider: PaymentProvider;
  /** Signing secret from the server environment (never logged, never from the request). */
  readonly signingSecret: string;
  readonly toleranceSeconds?: number;
}

/** Verifies `t=<unix seconds>,v1=<hex hmac>`; throws UNAUTHENTICATED on any mismatch. */
export function verifyWebhookSignature(input: {
  readonly secret: string;
  readonly rawBody: string;
  readonly signatureHeader: string | null;
  readonly now: Date;
  readonly toleranceSeconds?: number;
}): { readonly timestamp: number } {
  if (input.secret.length < 16) {
    throw new DomainError("CONFIG_REQUIRED", "Webhook signing secret is not configured");
  }
  const header = input.signatureHeader ?? "";
  const parts = new Map<string, string[]>();
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === undefined || value === undefined) continue;
    parts.set(key.trim(), [...(parts.get(key.trim()) ?? []), value.trim()]);
  }
  const timestampText = parts.get("t")?.[0] ?? "";
  const signatures = parts.get("v1") ?? [];
  if (!/^\d{1,12}$/.test(timestampText) || signatures.length === 0) {
    throw new DomainError("UNAUTHENTICATED", "Invalid webhook signature");
  }
  const timestamp = Number(timestampText);
  const tolerance = input.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(input.now.getTime() / 1000 - timestamp) > tolerance) {
    throw new DomainError("UNAUTHENTICATED", "Webhook timestamp outside the tolerance");
  }
  const expected = createHmac("sha256", input.secret)
    .update(`${timestampText}.${input.rawBody}`)
    .digest();
  const valid = signatures.some((signature) => {
    if (!/^[0-9a-f]{64}$/.test(signature)) return false;
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) throw new DomainError("UNAUTHENTICATED", "Invalid webhook signature");
  return { timestamp };
}

export const PROVIDER_EVENT_TYPES = [
  "payment.authorized",
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
  "payment.charged_back",
] as const;

export const providerEventSchema = z.strictObject({
  id: z.string().min(1).max(200),
  type: z.enum(PROVIDER_EVENT_TYPES),
  occurredAt: z.iso.datetime({ offset: true }),
  data: z.strictObject({
    providerPaymentId: z.string().min(1).max(200),
    amountCents: z.number().int().min(1).max(MAX_AMOUNT_CENTS),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
});

export type ProviderEvent = z.infer<typeof providerEventSchema>;

export type ProviderEventOutcome =
  | "PROCESSED"
  | "DUPLICATE"
  | "IGNORED_UNKNOWN_PAYMENT"
  | "IGNORED_OUT_OF_ORDER"
  | "REJECTED_MISMATCH"
  | "REJECTED_UNVERIFIED";

const EXPECTED_STATUS: Record<ProviderEvent["type"], ProviderPaymentStatus> = {
  "payment.authorized": "AUTHORIZED",
  "payment.succeeded": "SUCCEEDED",
  "payment.failed": "FAILED",
  "payment.refunded": "REFUNDED",
  "payment.charged_back": "CHARGED_BACK",
};

/**
 * Verifies and processes one webhook delivery. Returns the outcome; throws only for
 * unauthenticated/malformed deliveries (the route answers 400/401 without details).
 */
export async function processProviderWebhook(
  deps: { readonly db: Database; readonly clock: Clock; readonly correlationId?: string },
  config: WebhookProviderConfig,
  delivery: { readonly rawBody: string; readonly signatureHeader: string | null },
  options: FinanceOptions,
): Promise<{ outcome: ProviderEventOutcome; eventId: string | null }> {
  const provider = requireConfiguredProvider(config.provider);
  const now = deps.clock.now();
  verifyWebhookSignature({
    secret: config.signingSecret,
    rawBody: delivery.rawBody,
    signatureHeader: delivery.signatureHeader,
    now,
    ...(config.toleranceSeconds === undefined ? {} : { toleranceSeconds: config.toleranceSeconds }),
  });
  let json: unknown;
  try {
    json = JSON.parse(delivery.rawBody);
  } catch {
    throw new DomainError("VALIDATION_FAILED", "Malformed webhook payload");
  }
  const event = parseInput(providerEventSchema, json);
  const payloadSha256 = createHash("sha256").update(delivery.rawBody).digest("hex");
  const system: AuditActor = { type: "SYSTEM" };

  return deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.paymentProviderEvent)
      .values({
        provider: provider.key,
        providerEventId: event.id,
        eventType: event.type,
        payloadSha256,
        occurredAt: new Date(event.occurredAt),
        receivedAt: now,
      })
      .onConflictDoNothing({
        target: [schema.paymentProviderEvent.provider, schema.paymentProviderEvent.providerEventId],
      })
      .returning({ id: schema.paymentProviderEvent.id });
    const stored = inserted[0];
    if (stored === undefined) return { outcome: "DUPLICATE" as const, eventId: null };

    const finish = async (
      outcome: ProviderEventOutcome,
      status: "PROCESSED" | "IGNORED" | "REJECTED",
      paymentId: string | null,
    ) => {
      await tx
        .update(schema.paymentProviderEvent)
        .set({ status, processedAt: now, paymentId, outcome })
        .where(eq(schema.paymentProviderEvent.id, stored.id));
      return { outcome, eventId: stored.id };
    };

    const [ref] = await tx
      .select({
        id: schema.payment.id,
        customerId: schema.payment.customerId,
        invoiceId: schema.payment.invoiceId,
        bookingId: schema.invoice.bookingId,
      })
      .from(schema.payment)
      .innerJoin(schema.invoice, eq(schema.invoice.id, schema.payment.invoiceId))
      .where(
        and(
          eq(schema.payment.provider, provider.key),
          eq(schema.payment.providerPaymentId, event.data.providerPaymentId),
        ),
      )
      .limit(1);
    if (ref === undefined) return finish("IGNORED_UNKNOWN_PAYMENT", "IGNORED", null);

    await lockCustomerFinance(tx, ref.customerId);
    await lockBookingRow(tx, ref.bookingId);
    const invoice = await lockInvoice(tx, ref.invoiceId);
    const payment = await lockPayment(tx, ref.id);
    if (
      payment.amountCents !== event.data.amountCents ||
      payment.currency !== event.data.currency
    ) {
      return finish("REJECTED_MISMATCH", "REJECTED", payment.id);
    }
    const target = {
      "payment.authorized": "AUTHORIZED",
      "payment.succeeded": "CONFIRMED",
      "payment.failed": "FAILED",
      "payment.refunded": "REFUNDED",
      "payment.charged_back": "CHARGED_BACK",
    } as const;
    const to = target[event.type];
    const allowed: Record<string, readonly string[]> = {
      AUTHORIZED: ["PENDING"],
      CONFIRMED: ["PENDING", "AUTHORIZED"],
      FAILED: ["PENDING", "AUTHORIZED"],
      REFUNDED: ["REFUND_PENDING"],
      CHARGED_BACK: ["CONFIRMED"],
    };
    if (!(allowed[to] ?? []).includes(payment.status)) {
      // Replay of an older state or an event overtaken by a later one: never regress.
      return finish("IGNORED_OUT_OF_ORDER", "IGNORED", payment.id);
    }
    const verified = await provider.verifyPayment(event.data.providerPaymentId, {
      status: EXPECTED_STATUS[event.type],
      amountCents: payment.amountCents,
      currency: payment.currency,
    });
    if (!verified) return finish("REJECTED_UNVERIFIED", "REJECTED", payment.id);

    const audit = {
      actor: system,
      actorUserId: null,
      now,
      correlationId: deps.correlationId,
      providerEventId: stored.id,
    };
    switch (to) {
      case "CONFIRMED":
        await applyConfirmation(tx, invoice, payment, options, { ...audit, reason: event.type });
        break;
      case "CHARGED_BACK":
        await applyChargeback(tx, invoice, payment, event.type, options, audit);
        break;
      case "FAILED":
        await applyPaymentChange(
          tx,
          payment,
          "FAILED",
          { failedAt: now, statusReason: event.type },
          { ...audit, reason: event.type },
        );
        break;
      case "AUTHORIZED":
        await applyPaymentChange(tx, payment, "AUTHORIZED", {}, { ...audit, reason: null });
        break;
      case "REFUNDED":
        await applyRefundCompleted(tx, invoice, payment, event.id, options, audit);
        break;
    }
    if (to !== "AUTHORIZED" && to !== "CHARGED_BACK") {
      await reevaluateCustomer(tx, invoice.customerId, "PAYMENT", options, audit);
    }
    return finish("PROCESSED", "PROCESSED", payment.id);
  });
}

const startInput = z.strictObject({
  invoiceId: z.uuid(),
  method: z.enum(PAYMENT_METHODS),
  idempotencyKey: z
    .string()
    .min(8)
    .max(200)
    .regex(/^[A-Za-z0-9:._-]+$/),
});

/**
 * Starts a provider payment for the outstanding amount (finance). With the unconfigured
 * default provider this fails with CONFIG_REQUIRED – no payment record is created.
 */
export async function startProviderPayment(
  ctx: ServiceContext,
  input: unknown,
  providerInput: PaymentProvider,
): Promise<{ paymentId: string }> {
  const actor = requireActor(ctx.actor);
  requireGlobal(actor, "payment:manage");
  const data = parseInput(startInput, input);
  const provider = requireConfiguredProvider(providerInput);
  const now = ctx.clock.now();
  return ctx.db.transaction(async (tx) => {
    const invoice = await lockInvoice(tx, data.invoiceId);
    if (!PAYABLE_INVOICE_STATUSES.includes(invoice.status)) {
      throw new DomainError("POLICY_VIOLATION", "The invoice does not accept payments");
    }
    const amountCents = invoice.grossCents - invoice.paidCents;
    const intent = await provider.createPaymentIntent({
      invoiceId: invoice.id,
      amountCents,
      currency: invoice.currency,
      idempotencyKey: data.idempotencyKey,
    });
    const [payment] = await tx
      .insert(schema.payment)
      .values({
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        status: "PENDING",
        method: data.method,
        provider: provider.key,
        providerPaymentId: intent.providerPaymentId,
        amountCents,
        currency: invoice.currency,
        idempotencyKey: data.idempotencyKey,
        receivedAt: now,
        recordedByUserId: actor.userId,
      })
      .returning({ id: schema.payment.id });
    if (payment === undefined) throw new DomainError("CONFLICT", "Payment not recorded");
    await tx.insert(schema.paymentTransition).values({
      paymentId: payment.id,
      fromStatus: null,
      toStatus: "PENDING",
      actorUserId: actor.userId,
      reason: "PROVIDER_INTENT",
    });
    await recordAudit(tx, {
      actor: auditActorOf(actor),
      action: "payment.created",
      entityType: "payment",
      entityId: payment.id,
      after: { invoiceId: invoice.id, provider: provider.key, amountCents },
      correlationId: ctx.correlationId,
    });
    return { paymentId: payment.id };
  });
}
