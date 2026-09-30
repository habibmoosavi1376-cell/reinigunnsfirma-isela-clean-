import { DomainError } from "@isela/shared";

/*
 * Payment-provider abstraction. NO real provider is active: the provider choice (e.g. an
 * EU payment service provider) is an open owner decision (PRODUCT_SPEC §10). The production
 * default is `UNCONFIGURED_PAYMENT_PROVIDER`, which refuses every call with CONFIG_REQUIRED –
 * it never pretends that a payment succeeded. A test double exists only in the test suite.
 */

export type ProviderPaymentStatus =
  "PENDING" | "AUTHORIZED" | "SUCCEEDED" | "FAILED" | "REFUNDED" | "CHARGED_BACK";

export interface PaymentIntent {
  readonly providerPaymentId: string;
  readonly status: ProviderPaymentStatus;
}

export interface ProviderPaymentState {
  readonly status: ProviderPaymentStatus;
  readonly amountCents: number;
  readonly currency: string;
}

export interface PaymentProvider {
  /** Stable key stored with payments and events, e.g. "example-psp". */
  readonly key: string;
  readonly configured: boolean;
  createPaymentIntent(input: {
    readonly invoiceId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly idempotencyKey: string;
  }): Promise<PaymentIntent>;
  getPaymentStatus(providerPaymentId: string): Promise<ProviderPaymentState>;
  /**
   * Server-to-server confirmation that the payment really has the expected state, amount and
   * currency. Webhook bodies are never trusted on their own.
   */
  verifyPayment(
    providerPaymentId: string,
    expected: {
      readonly status: ProviderPaymentStatus;
      readonly amountCents: number;
      readonly currency: string;
    },
  ): Promise<boolean>;
  refundPayment(
    providerPaymentId: string,
    input: { readonly amountCents: number; readonly idempotencyKey: string },
  ): Promise<{ readonly status: ProviderPaymentStatus }>;
}

function notConfigured(): never {
  throw new DomainError("CONFIG_REQUIRED", "No payment provider is configured");
}

export const UNCONFIGURED_PAYMENT_PROVIDER: PaymentProvider = {
  key: "unconfigured",
  configured: false,
  createPaymentIntent: () =>
    Promise.reject(new DomainError("CONFIG_REQUIRED", "No payment provider is configured")),
  getPaymentStatus: () =>
    Promise.reject(new DomainError("CONFIG_REQUIRED", "No payment provider is configured")),
  verifyPayment: () =>
    Promise.reject(new DomainError("CONFIG_REQUIRED", "No payment provider is configured")),
  refundPayment: () =>
    Promise.reject(new DomainError("CONFIG_REQUIRED", "No payment provider is configured")),
};

/** Guard for code paths that need a real provider. */
export function requireConfiguredProvider(provider: PaymentProvider): PaymentProvider {
  if (!provider.configured) notConfigured();
  return provider;
}
