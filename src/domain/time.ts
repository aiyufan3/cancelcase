/**
 * Time handling. All instants are compared as UTC epoch milliseconds so that
 * "2026-11-07T12:00:00Z" and "2026-11-07T07:00:00-05:00" are the same instant.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  const fixed = new Date(iso);
  if (Number.isNaN(fixed.getTime())) throw new Error(`fixedClock: invalid instant ${iso}`);
  return { now: () => new Date(fixed.getTime()) };
}

const ISO_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse an ISO-8601 instant that carries an explicit UTC offset or Z.
 * Returns epoch milliseconds, or null when the string is missing, has no offset,
 * or does not parse. A timestamp without an offset is ambiguous and is rejected.
 */
export function parseInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!ISO_WITH_OFFSET_RE.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

export function isValidInstant(value: string | null | undefined): boolean {
  return parseInstant(value) !== null;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function nowIso(clock: Clock = systemClock): string {
  return clock.now().toISOString();
}

export function addMinutes(iso: string, minutes: number): string {
  const ms = parseInstant(iso);
  if (ms === null) throw new Error(`addMinutes: invalid instant ${iso}`);
  return toIso(ms + minutes * 60_000);
}

export type InstantComparison = "before" | "equal" | "after" | "unknown";

export function compareInstants(
  a: string | null | undefined,
  b: string | null | undefined,
): InstantComparison {
  const ma = parseInstant(a);
  const mb = parseInstant(b);
  if (ma === null || mb === null) return "unknown";
  if (ma < mb) return "before";
  if (ma > mb) return "after";
  return "equal";
}

export function isExpired(expiresAt: string, clock: Clock): boolean {
  const ms = parseInstant(expiresAt);
  if (ms === null) return true;
  return clock.now().getTime() >= ms;
}

export const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * An instant as people read it: "Nov 10, 2026", or "Nov 10, 2026 at 4:31 PM UTC" where the time
 * matters. Always in UTC, whatever the machine's time zone, so the words name the same calendar
 * day the validator compares. A bare "YYYY-MM-DD" is read as that UTC day. Returns null for a
 * value that is not an instant with an explicit offset.
 */
export function formatUtc(
  value: string | null | undefined,
  options: { time?: boolean } = {},
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? Date.parse(`${trimmed}T00:00:00Z`)
    : parseInstant(trimmed);
  if (ms === null || Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const date = `${MONTH_ABBREVIATIONS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  if (!options.time) return date;
  const hours = d.getUTCHours();
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  return `${date} at ${hours % 12 === 0 ? 12 : hours % 12}:${minutes} ${hours < 12 ? "AM" : "PM"} UTC`;
}

/** True when both instants fall on the same UTC calendar day. */
export function sameUtcDay(a: string | null | undefined, b: string | null | undefined): boolean {
  const ma = parseInstant(a);
  const mb = parseInstant(b);
  if (ma === null || mb === null) return false;
  return new Date(ma).toISOString().slice(0, 10) === new Date(mb).toISOString().slice(0, 10);
}
