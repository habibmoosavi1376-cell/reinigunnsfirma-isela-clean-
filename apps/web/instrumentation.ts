/**
 * Runs once when the server starts. Validates the environment and wires the services so a
 * misconfigured deployment (missing secrets, unsupported providers) stops with exit code 1
 * instead of serving requests. The Node-only part lives in lib/server/startup.ts.
 */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    const { verifyStartupConfiguration } = await import("./lib/server/startup");
    verifyStartupConfiguration();
  }
}
