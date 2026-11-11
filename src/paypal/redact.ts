/**
 * Redaction helpers for anything that might be logged, stored or shown.
 * Tokens, assertions, cookies, emails and long opaque strings are removed.
 */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\b/g;
const LONG_OPAQUE_RE = /\b[A-Za-z0-9_-]{40,}\b/g;
const BASIC_RE = /Basic\s+[A-Za-z0-9+/=]+/gi;

export function redactText(input: string, maxLength = 600): string {
  const out = input
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(BASIC_RE, "Basic [redacted]")
    .replace(JWT_RE, "[redacted-jwt]")
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(LONG_OPAQUE_RE, "[redacted-opaque]");
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

/** Keep only known-safe keys from a provider error body. */
export function summarizeProviderError(body: unknown): {
  name: string | null;
  message: string | null;
  issues: string[];
  debugId: string | null;
} {
  if (!body || typeof body !== "object")
    return { name: null, message: null, issues: [], debugId: null };
  const b = body as Record<string, unknown>;
  const details = Array.isArray(b.details) ? (b.details as Record<string, unknown>[]) : [];
  const issues = details
    .map((d) => [d.field, d.issue, d.description].filter((v) => typeof v === "string").join(": "))
    .filter((s) => s.length > 0)
    .map((s) => redactText(s, 200))
    .slice(0, 8);
  return {
    name:
      typeof b.name === "string"
        ? redactText(b.name, 80)
        : typeof b.error === "string"
          ? redactText(b.error, 80)
          : null,
    message:
      typeof b.message === "string"
        ? redactText(b.message, 300)
        : typeof b.error_description === "string"
          ? redactText(b.error_description, 300)
          : null,
    issues,
    debugId: typeof b.debug_id === "string" ? b.debug_id : null,
  };
}

/** Mask a provider identifier for recording mode: keeps the shape, hides most characters. */
export function maskId(id: string | null): string | null {
  if (!id) return id;
  if (id.length <= 6) return `${id[0] ?? ""}***`;
  return `${id.slice(0, 3)}…${id.slice(-3)}`;
}
