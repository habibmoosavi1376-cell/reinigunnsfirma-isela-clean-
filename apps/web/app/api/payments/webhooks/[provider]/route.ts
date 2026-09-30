import { processProviderWebhook } from "@isela/billing";
import { isDomainError } from "@isela/shared";
import { loadFinanceOptions } from "@/lib/server/finance";
import { logServerError } from "@/lib/server/logger";
import { getWebhookProvider } from "@/lib/server/payment-providers";
import { getServices } from "@/lib/server/services";

/*
 * Payment-provider webhook endpoint. Security: fixed provider registry, HMAC signature over
 * timestamp + raw body, timestamp tolerance, strict payload schema, idempotent event storage,
 * server-to-server re-verification (billing `processProviderWebhook`). Responses carry no
 * details. Without a configured provider the endpoint does not exist (404).
 */

const MAX_BODY_BYTES = 64 * 1024;

function json(status: number, body: Record<string, string>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider: key } = await params;
  const config = /^[a-z0-9-]{1,40}$/.test(key) ? getWebhookProvider(key) : null;
  if (config === null) return json(404, { error: "not_found" });
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) {
    return json(413, { error: "payload_too_large" });
  }
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });
  const { database, clock } = getServices();
  try {
    const result = await processProviderWebhook(
      { db: database.db, clock },
      config,
      { rawBody, signatureHeader: request.headers.get("x-signature") },
      await loadFinanceOptions(database.db, clock),
    );
    return json(200, { status: result.outcome });
  } catch (error) {
    if (isDomainError(error, "UNAUTHENTICATED")) return json(401, { error: "unauthorized" });
    if (isDomainError(error, "VALIDATION_FAILED")) return json(400, { error: "invalid" });
    logServerError("payments.webhook_failed", error);
    return json(500, { error: "unexpected" });
  }
}
