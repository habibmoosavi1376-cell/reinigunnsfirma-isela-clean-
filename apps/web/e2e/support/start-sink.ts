import { startSmtpSink } from "../../tests/support/smtp-sink.ts";

/* TEST-ONLY. Local SMTP sink for E2E runs; never used by the application itself. */

const smtpPort = Number(process.env["E2E_SMTP_PORT"] ?? "2525");
const httpPort = Number(process.env["E2E_SMTP_HTTP_PORT"] ?? "2526");
await startSmtpSink(smtpPort, httpPort);
console.log(`smtp sink listening on ${smtpPort} (http ${httpPort})`);
