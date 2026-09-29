import "server-only";
import { getServices } from "./services";

/** Fails fast on invalid configuration. Only variable names are logged, never values. */
export function verifyStartupConfiguration(): void {
  try {
    getServices();
  } catch (error) {
    const details = (error as { details?: { variables?: unknown } }).details;
    console.error(
      JSON.stringify({
        level: "fatal",
        event: "startup.configuration_invalid",
        variables: Array.isArray(details?.variables) ? details.variables : [],
      }),
    );
    process.exit(1);
  }
}
