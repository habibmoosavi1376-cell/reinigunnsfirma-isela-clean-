import "server-only";
import { randomBytes } from "node:crypto";

/**
 * One-time token rendered into public forms (hidden field). The domain stores only a keyed
 * hash of it and treats a repeated submission of the same form as a duplicate.
 */
export function newSubmissionToken(): string {
  return randomBytes(24).toString("base64url");
}
