import { DomainError } from "@isela/shared";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Machine-readable purpose, e.g. "auth.verify-email". Used for auditing, never content. */
  readonly purpose: string;
}

/**
 * Port for transactional e-mail. Production adapters are added once an e-mail provider
 * has been selected (see docs/ROADMAP.md). There is deliberately no default or no-op
 * implementation: components that need to send e-mail must receive a real sender.
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Guard used at composition time to fail closed when no sender is configured. */
export function requireEmailSender(sender: EmailSender | undefined): EmailSender {
  if (sender === undefined) {
    throw new DomainError(
      "CONFIGURATION_ERROR",
      "No e-mail sender configured. Authentication cannot start without a real e-mail provider.",
    );
  }
  return sender;
}
