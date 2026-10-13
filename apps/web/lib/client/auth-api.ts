/**
 * Thin browser client for the Better Auth endpoints under /api/auth (same origin).
 * No authorization decisions are made in the browser.
 */

export interface AuthResponse {
  readonly status: number;
  readonly data: Record<string, unknown>;
}

export async function postAuth(path: string, body: Record<string, unknown>): Promise<AuthResponse> {
  const response = await fetch(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { status: response.status, data };
}

/** Text value of a form field ("" for missing fields or file uploads). */
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** Generic, enumeration-safe messages for auth errors. */
export function authErrorMessage(status: number): string {
  if (status === 429)
    return "Zu viele Versuche. Bitte warten Sie einige Minuten und versuchen Sie es erneut.";
  if (status === 401) return "E-Mail-Adresse oder Passwort ist nicht korrekt.";
  if (status === 403)
    return "Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse. Den Link finden Sie in Ihrem Postfach.";
  if (status === 400 || status === 422) return "Bitte prüfen Sie Ihre Eingaben.";
  return "Die Aktion ist gerade nicht möglich. Bitte versuchen Sie es später erneut.";
}
