import { headers } from "next/headers";
import { serializeJsonLd } from "@/lib/seo/seo";

/** Structured data with the per-request CSP nonce; content is escaped against `</script>`. */
export async function JsonLd({ data }: { data: Record<string, unknown> }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
