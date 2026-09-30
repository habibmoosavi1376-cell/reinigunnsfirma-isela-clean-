import { createHmac, randomUUID } from "node:crypto";
import type {
  PaymentIntent,
  PaymentProvider,
  ProviderPaymentState,
  ProviderPaymentStatus,
} from "@isela/billing";

/**
 * Payment-provider TEST DOUBLE – exists only in the test suite. It never talks to a real
 * provider; tests set the provider-side state explicitly to exercise verification,
 * idempotency and out-of-order handling. Production uses UNCONFIGURED_PAYMENT_PROVIDER.
 */
export class TestPaymentProvider implements PaymentProvider {
  readonly key = "test-psp";
  readonly configured = true;
  readonly states = new Map<string, ProviderPaymentState>();

  createPaymentIntent(input: {
    readonly invoiceId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly idempotencyKey: string;
  }): Promise<PaymentIntent> {
    const providerPaymentId = `pi_test_${randomUUID()}`;
    this.states.set(providerPaymentId, {
      status: "PENDING",
      amountCents: input.amountCents,
      currency: input.currency,
    });
    return Promise.resolve({ providerPaymentId, status: "PENDING" });
  }

  getPaymentStatus(providerPaymentId: string): Promise<ProviderPaymentState> {
    const state = this.states.get(providerPaymentId);
    return state === undefined
      ? Promise.reject(new Error("unknown test payment"))
      : Promise.resolve(state);
  }

  verifyPayment(
    providerPaymentId: string,
    expected: { status: ProviderPaymentStatus; amountCents: number; currency: string },
  ): Promise<boolean> {
    const state = this.states.get(providerPaymentId);
    return Promise.resolve(
      state !== undefined &&
        state.status === expected.status &&
        state.amountCents === expected.amountCents &&
        state.currency === expected.currency,
    );
  }

  refundPayment(providerPaymentId: string): Promise<{ status: ProviderPaymentStatus }> {
    const state = this.states.get(providerPaymentId);
    if (state === undefined) return Promise.reject(new Error("unknown test payment"));
    this.states.set(providerPaymentId, { ...state, status: "REFUNDED" });
    return Promise.resolve({ status: "REFUNDED" });
  }

  set(providerPaymentId: string, status: ProviderPaymentStatus): void {
    const state = this.states.get(providerPaymentId);
    if (state === undefined) throw new Error("unknown test payment");
    this.states.set(providerPaymentId, { ...state, status });
  }
}

export const TEST_WEBHOOK_SECRET = "test-webhook-secret-only-for-tests-0123";

/** Signs a raw body like a provider would (test helper). */
export function signedDelivery(
  body: unknown,
  now: Date,
  secret = TEST_WEBHOOK_SECRET,
): { rawBody: string; signatureHeader: string } {
  const rawBody = JSON.stringify(body);
  const t = String(Math.floor(now.getTime() / 1000));
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return { rawBody, signatureHeader: `t=${t},v1=${v1}` };
}
