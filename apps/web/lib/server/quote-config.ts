import "server-only";
import type { DbExecutor } from "@isela/database";
import type { QuoteConfig } from "@isela/quotes";
import { GLOBAL_SCOPE, getEffectiveSetting } from "@isela/settings";
import type { Clock } from "@isela/shared";

/** Effective quote configuration (versioned setting `quote.defaults`, falls back to defaults). */
export async function loadQuoteConfig(db: DbExecutor, clock: Clock): Promise<QuoteConfig> {
  const setting = await getEffectiveSetting(db, "quote.defaults", GLOBAL_SCOPE, clock.now());
  return setting.value;
}
