import { createTransport } from "nodemailer";
import type { EmailMessage, EmailSender } from "./index.ts";

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** true = implicit TLS (port 465); false = STARTTLS is required when offered. */
  readonly secure: boolean;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  readonly from: string;
  /** Require TLS even on non-secure ports (always true outside local development). */
  readonly requireTls: boolean;
}

/**
 * Real SMTP delivery (provider-agnostic; most EU e-mail providers offer SMTP).
 * Message bodies are never logged. Delivery errors propagate to the caller.
 */
export function createSmtpEmailSender(config: SmtpConfig): EmailSender {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTls && !config.secure,
    ...(config.user !== undefined && config.password !== undefined
      ? { auth: { user: config.user, pass: config.password } }
      : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(message: EmailMessage): Promise<void> {
      await transport.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        headers: { "X-Isela-Purpose": message.purpose },
      });
    },
  };
}
