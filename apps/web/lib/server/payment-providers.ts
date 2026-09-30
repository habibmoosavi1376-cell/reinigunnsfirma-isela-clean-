import "server-only";
import type { WebhookProviderConfig } from "@isela/billing";

/**
 * Registry of configured payment providers (fixed server configuration – the provider and its
 * signing secret are never taken from a request). It is intentionally EMPTY: choosing and
 * contracting a payment provider is an open owner decision (PRODUCT_SPEC §10). Until an
 * adapter and its secret are added here, every webhook call answers 404 and no payment can be
 * confirmed by a provider.
 */
const PROVIDERS: ReadonlyMap<string, WebhookProviderConfig> = new Map();

export function getWebhookProvider(key: string): WebhookProviderConfig | null {
  return PROVIDERS.get(key) ?? null;
}
