import { z } from "zod";
import type {
  DraftContent,
  DraftIssue,
  DraftValidation,
  NormalizedFact,
  Role,
  RoleSnapshot,
} from "./types";
import { MONTH_ABBREVIATIONS, parseInstant } from "./time";

/**
 * Structured-claims validation. The model (or the fixture template) returns claims that
 * each cite source IDs and fact IDs from an allowlisted, role-filtered snapshot. This
 * validator checks schema, scope, reference existence, required facts, and, in the subject and in
 * every claim, the amounts, dates, times and transaction references written in the supported forms
 * (see the notes on amounts and dates below), a list of unsupported absolutes and outcome promises,
 * and contradiction with a recorded refund. It does not understand free text: a valid citation
 * does not prove that the paraphrase follows from the source, and a number written without a
 * currency is not checked. Human review remains required.
 */

export const claimSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(["fact", "request", "context", "unknown"]),
  text: z.string().min(1).max(1200),
  source_ids: z.array(z.string().min(1).max(128)).max(12),
  fact_ids: z.array(z.string().min(1).max(128)).max(12),
});

export const modelDraftSchema = z.object({
  subject: z.string().min(1).max(200),
  claims: z.array(claimSchema).min(1).max(24),
});

export type ModelDraft = z.infer<typeof modelDraftSchema>;

export function parseModelDraft(
  raw: unknown,
): { ok: true; draft: ModelDraft } | { ok: false; error: string } {
  const result = modelDraftSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  return { ok: true, draft: result.data };
}

const UNSUPPORTED_CERTAINTY_PATTERNS: RegExp[] = [
  /\bguarantee[sd]?\b/i,
  /\bwill (?:be )?(?:refund|reimburse|rule|decide|win)/i,
  /\bentitled to\b/i,
  /\bmust (?:refund|reimburse|return)/i,
  /\bfraud(?:ulent)?\b/i,
  /\billegal(?:ly)?\b/i,
  /\bunlawful(?:ly)?\b/i,
  /\bstole\b|\btheft\b|\bscam\b/i,
  /\bcertain(?:ly)? (?:that )?(?:you|paypal|the merchant)\b/i,
  /\bno doubt\b/i,
];

const OUTCOME_PROMISE_PATTERNS: RegExp[] = [
  /\bpaypal will (?:side|rule|find|decide)\b/i,
  /\byou will (?:receive|get) (?:a |your )?(?:full )?refund\b/i,
  /\brefund is (?:guaranteed|assured|certain)\b/i,
  /\bmoney (?:is|has been) recovered\b/i,
];

/*
 * Amounts in text. An amount is checked when it is written as US dollars: "$19.99", "US$19.99",
 * "USD 19.99", "19.99 USD" or "19.99 dollars", with optional thousands separators. It must have no
 * decimals or exactly two. An amount with another precision, or one written in another currency,
 * cannot be compared with the facts and is refused. A bare number without a currency is not read
 * as an amount.
 */
const NUMBER = "(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d+))?(?![\\d,])";
const USD_AMOUNT_RE = new RegExp(
  `(?:US\\s?\\$|\\$|\\bUSD)\\s?${NUMBER}|(?<![\\d.,$])${NUMBER}\\s?(?:USD\\b|US\\s+dollars?\\b|dollars?\\b)`,
  "gi",
);
const OTHER_CURRENCY = "[€£¥₹]|\\b(?:EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|MXN)\\b";
const OTHER_CURRENCY_RE = new RegExp(
  `(?:${OTHER_CURRENCY})\\s?\\d[\\d,]*(?:\\.\\d+)?|\\d[\\d,]*(?:\\.\\d+)?\\s?(?:${OTHER_CURRENCY})`,
  "gi",
);

interface AmountMention {
  /** Cents, or null when the amount cannot be compared with the facts */
  cents: number | null;
  /** The text as written, for messages */
  text: string;
  problem: "precision" | "currency" | null;
}

/** Every amount a text names with a currency. */
export function mentionedAmounts(text: string): AmountMention[] {
  const out: AmountMention[] = [];
  for (const m of text.matchAll(USD_AMOUNT_RE)) {
    const whole = (m[1] ?? m[3] ?? "0").replace(/,/g, "");
    const fraction = m[1] !== undefined ? m[2] : m[4];
    if (fraction !== undefined && fraction.length !== 2) {
      out.push({ cents: null, text: m[0].trim(), problem: "precision" });
      continue;
    }
    out.push({
      cents: Number.parseInt(whole, 10) * 100 + Number.parseInt(fraction ?? "00", 10),
      text: m[0].trim(),
      problem: null,
    });
  }
  for (const m of text.matchAll(OTHER_CURRENCY_RE))
    out.push({ cents: null, text: m[0].trim(), problem: "currency" });
  return out;
}

/*
 * Dates and times in text. The supported forms are:
 *
 *   - an ISO date (2026-11-07) or an ISO instant (2026-11-07T12:00:00Z, with or without seconds;
 *     an instant without an offset is read as UTC);
 *   - a day in words, in any letter case (Nov 7, 2026 · november 7th, 2026 · 7 Nov 2026), with an
 *     optional time (Nov 7, 2026 at 12:00 PM UTC);
 *   - a day in words without a year (Nov 7 · 7 November), compared by month and day;
 *   - a time on its own, when it carries AM/PM or UTC.
 *
 * Each mention is normalised to a UTC day and, when a time is given, to the UTC minute, and to the
 * second when seconds are written, then compared with the instants of the facts. A date or time
 * that cannot exist (Feb 30, 25:61), a numeric date such as 11/07/2026, whose order is ambiguous,
 * and a time written in a zone other than UTC are refused instead of being skipped.
 */
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const ISO_INSTANT_RE =
  /\b(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g;
const MONTH_NAME =
  "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
/** Zones a written time may not use: the facts are compared in UTC. */
const OTHER_ZONE = "E[SD]?T|C[SD]?T|M[SD]?T|P[SD]?T|BST|CES?T|IST|JST|AE[SD]T";
const TIME_OF_DAY = `(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*([AaPp]\\.?[Mm]\\.?)?(?:\\s*(UTC|GMT|${OTHER_ZONE})\\b)?`;
const MONTH_FIRST_RE = new RegExp(
  `\\b${MONTH_NAME}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b(?:,?\\s+(?:at\\s+)?${TIME_OF_DAY})?`,
  "gi",
);
const DAY_FIRST_RE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_NAME},?\\s+(\\d{4})\\b(?:,?\\s+(?:at\\s+)?${TIME_OF_DAY})?`,
  "gi",
);
/** A day in words without a year. */
const MONTH_FIRST_NO_YEAR_RE = new RegExp(
  `\\b${MONTH_NAME}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
  "gi",
);
const DAY_FIRST_NO_YEAR_RE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_NAME}(?![a-z])`,
  "gi",
);
/** A numeric date: 11/07/2026, 7/11/26, 07.11.2026. Its order is ambiguous, so it is refused. */
const NUMERIC_DATE_RE = /\b\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})\b|\b\d{1,2}\.\d{1,2}\.\d{4}\b/g;
/** A time on its own needs AM/PM or a zone, so that ratios and versions are not read as times. */
const LONE_TIME_RE = new RegExp(
  `\\b(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*(?:([AaPp]\\.?[Mm]\\.?)(?:\\s*(UTC|GMT|${OTHER_ZONE})\\b)?|(UTC|GMT|${OTHER_ZONE})\\b)`,
  "g",
);

interface InstantMention {
  /** UTC day "YYYY-MM-DD", or null when the mention names no full date */
  day: string | null;
  /** "MM-DD" for a day written without a year, otherwise null */
  monthDay: string | null;
  /** Minutes after UTC midnight, or null when no time is named */
  minute: number | null;
  /** Seconds, when the text writes them; otherwise null and seconds are not compared */
  second: number | null;
  /** The text as written, for messages */
  text: string;
  /** Why the mention cannot be compared: it cannot exist, or its form is not supported */
  problem: "invalid" | "unsupported" | null;
}

function monthNumber(name: string): number {
  const index = MONTH_ABBREVIATIONS.findIndex(
    (m) => name.slice(0, 3).toLowerCase() === m.toLowerCase(),
  );
  return index + 1;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Minutes after midnight for a written time, or NaN when the time cannot exist. */
function writtenMinute(hours: string, minutes: string, meridiem: string | undefined): number {
  let h = Number.parseInt(hours, 10);
  const m = Number.parseInt(minutes, 10);
  if (m > 59) return Number.NaN;
  if (meridiem) {
    if (h < 1 || h > 12) return Number.NaN;
    const pm = meridiem.toLowerCase().startsWith("p");
    h = (h % 12) + (pm ? 12 : 0);
  } else if (h > 23) return Number.NaN;
  return h * 60 + m;
}

/** True when the calendar has this day. */
function dayExists(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function isUtcZone(zone: string | undefined): boolean {
  return zone === undefined || /^(?:UTC|GMT)$/i.test(zone);
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function minuteOf(ms: number): number {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Every date and time a text names, normalised to UTC. */
export function mentionedInstants(text: string): InstantMention[] {
  const out: InstantMention[] = [];
  const push = (m: Partial<InstantMention> & { text: string }) =>
    out.push({ day: null, monthDay: null, minute: null, second: null, problem: null, ...m });
  // Matched spans are blanked so that nothing is counted twice.
  let rest = text;
  const blank = (start: number, length: number) => {
    rest = rest.slice(0, start) + " ".repeat(length) + rest.slice(start + length);
  };
  const written = (
    hours: string | undefined,
    minutes: string | undefined,
    seconds: string | undefined,
    meridiem: string | undefined,
    zone: string | undefined,
  ): Pick<InstantMention, "minute" | "second" | "problem"> => {
    if (hours === undefined || minutes === undefined)
      return { minute: null, second: null, problem: null };
    const minute = writtenMinute(hours, minutes, meridiem);
    const second = seconds !== undefined ? Number.parseInt(seconds, 10) : null;
    if (Number.isNaN(minute) || (second !== null && second > 59))
      return { minute: null, second: null, problem: "invalid" };
    if (!isUtcZone(zone)) return { minute: null, second: null, problem: "unsupported" };
    return { minute, second, problem: null };
  };

  for (const m of text.matchAll(ISO_INSTANT_RE)) {
    blank(m.index, m[0].length);
    const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map((v) =>
      Number.parseInt(v!, 10),
    ) as [number, number, number, number, number];
    const second = m[6] !== undefined ? Number.parseInt(m[6], 10) : null;
    const offset = m[7] ?? "Z";
    const ms = Date.parse(
      `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${offset === "Z" ? "Z" : offset.replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2")}`,
    );
    if (
      !dayExists(year, month, day) ||
      hour > 23 ||
      minute > 59 ||
      (second !== null && second > 59) ||
      Number.isNaN(ms)
    ) {
      push({ text: m[0], problem: "invalid" });
      continue;
    }
    push({
      day: dayOf(ms),
      minute: minuteOf(ms),
      second: second === null ? null : new Date(ms).getUTCSeconds(),
      text: m[0],
    });
  }
  for (const m of rest.matchAll(ISO_DATE_RE)) {
    blank(m.index, m[0].length);
    const ok = dayExists(Number(m[1]), Number(m[2]), Number(m[3]));
    push(ok ? { day: `${m[1]}-${m[2]}-${m[3]}`, text: m[0] } : { text: m[0], problem: "invalid" });
  }
  for (const m of rest.matchAll(NUMERIC_DATE_RE)) {
    blank(m.index, m[0].length);
    push({ text: m[0], problem: "unsupported" });
  }
  for (const [re, order] of [
    [MONTH_FIRST_RE, "month-first"],
    [DAY_FIRST_RE, "day-first"],
  ] as const) {
    for (const m of rest.matchAll(re)) {
      blank(m.index, m[0].length);
      const [monthName, dayText] = order === "month-first" ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
      const [year, month, day] = [Number(m[3]), monthNumber(monthName), Number(dayText)];
      const time = written(m[4], m[5], m[6], m[7], m[8]);
      if (!dayExists(year, month, day) || time.problem) {
        push({ text: m[0].trim(), problem: time.problem ?? "invalid" });
        continue;
      }
      push({ day: `${m[3]}-${pad2(month)}-${pad2(day)}`, ...time, text: m[0].trim() });
    }
  }
  for (const [re, order] of [
    [MONTH_FIRST_NO_YEAR_RE, "month-first"],
    [DAY_FIRST_NO_YEAR_RE, "day-first"],
  ] as const) {
    for (const m of rest.matchAll(re)) {
      const [monthName, dayText] = order === "month-first" ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
      // "may" is also a verb: without a year it is read as a month only when capitalised.
      if (/^may/i.test(monthName) && !monthName.startsWith("May")) continue;
      blank(m.index, m[0].length);
      const [month, day] = [monthNumber(monthName), Number(dayText)];
      // 2024 is a leap year, so Feb 29 is accepted as a day that can exist.
      if (!dayExists(2024, month, day)) push({ text: m[0].trim(), problem: "invalid" });
      else push({ monthDay: `${pad2(month)}-${pad2(day)}`, text: m[0].trim() });
    }
  }
  for (const m of rest.matchAll(LONE_TIME_RE)) {
    const time = written(m[1], m[2], m[3], m[4], m[5] ?? m[6]);
    push({ ...time, text: m[0].trim() });
  }
  return out;
}

function knownAmountCents(snapshot: RoleSnapshot): Set<number> {
  const set = new Set<number>();
  for (const f of snapshot.facts) if (f.cents !== null) set.add(f.cents);
  if (snapshot.claimableCents !== null) set.add(snapshot.claimableCents);
  if (snapshot.requestedCents !== null) set.add(snapshot.requestedCents);
  return set;
}

/** The instants a fact states: its time and, for a range, its end (UTC epoch milliseconds). */
function factInstants(f: NormalizedFact): number[] {
  return [f.at, f.until ?? null].flatMap((iso) => {
    const ms = iso ? parseInstant(iso) : null;
    return ms !== null ? [ms] : [];
  });
}

function knownInstants(snapshot: RoleSnapshot): number[] {
  const out = snapshot.facts.flatMap(factInstants);
  for (const c of snapshot.contactHistory) {
    const ms = parseInstant(c.at);
    if (ms !== null) out.push(ms);
  }
  return out;
}

function knownDates(snapshot: RoleSnapshot): Set<string> {
  return new Set(knownInstants(snapshot).map(dayOf));
}

function requiredFactKinds(action: DraftContent["action"]): NormalizedFact["kind"][] {
  switch (action) {
    case "export_refund_request":
    case "buyer_create_dispute":
      return ["cancellation_effective", "charge"];
    case "merchant_provide_evidence":
      return ["charge"];
    default:
      return [];
  }
}

/**
 * Optional disclosure context: IDs the role can see but has not chosen to disclose. Citing or
 * attaching one of them is reported as UNDISCLOSED_SOURCE (with a clearer explanation than an
 * unknown reference) and blocks approval until the author includes it explicitly or removes it.
 */
export interface DisclosureScope {
  undisclosedSourceIds: ReadonlySet<string>;
  undisclosedFactIds: ReadonlySet<string>;
}

/**
 * Transaction IDs that the stored PayPal (or simulated) payment record behind each fact carries.
 * A claim may name a transaction only by one of these: an ID that comes from nowhere is refused.
 */
export interface ReferenceScope {
  transactionIdsByFact: ReadonlyMap<string, readonly string[]>;
}

/** "Transaction ID: 1AB…", "payment #…", "the order number is …": a labelled reference with a digit. */
const LABELLED_REFERENCE_RE =
  /\b(?:transaction|payment|sale|capture|order|receipt)\s*(?:id|#|no\.?|number|reference|ref\.?)(?:\s+(?:is|was))?\s*[:#]?\s*((?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{4,})/gi;
/** A bare PayPal transaction ID: 17 capitals and digits, with at least one of each. */
const PAYPAL_TRANSACTION_RE = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{17}\b/g;

/** Every transaction-like reference a claim's text names. */
export function mentionedReferences(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(LABELLED_REFERENCE_RE)) found.add(m[1]!.replace(/-+$/, ""));
  for (const m of text.matchAll(PAYPAL_TRANSACTION_RE)) found.add(m[0]);
  return [...found];
}

export function validateDraft(
  draft: DraftContent,
  snapshot: RoleSnapshot,
  role: Role,
  scope?: DisclosureScope,
  references?: ReferenceScope,
): DraftValidation {
  const issues: DraftIssue[] = [];
  const factById = new Map(snapshot.facts.map((f) => [f.id, f]));
  const sourceById = new Map(snapshot.sources.map((s) => [s.id, s]));

  if (draft.role !== role || snapshot.role !== role) {
    issues.push({
      code: "ROLE_SCOPE_VIOLATION",
      claimId: null,
      message: `Draft role ${draft.role} does not match the ${role} snapshot.`,
      blocking: true,
    });
  }
  if (draft.claims.length === 0) {
    issues.push({
      code: "EMPTY_DRAFT",
      claimId: null,
      message: "The draft has no claims.",
      blocking: true,
    });
  }

  const amounts = knownAmountCents(snapshot);
  const dates = knownDates(snapshot);
  const citedFactKinds = new Set<NormalizedFact["kind"]>();

  /**
   * The checks on what a piece of text says, for a claim or for the subject (claimId null):
   * amounts, dates and times, transaction references, unsupported certainty, outcome promises and
   * contradiction with a recorded refund. They compare against the facts the text cites or, when
   * it cites none, against every fact in the snapshot.
   */
  const checkText = (
    text: string,
    claimId: string | null,
    kind: DraftContent["claims"][number]["kind"],
    citedFacts: NormalizedFact[],
  ): void => {
    const where = claimId === null ? "Subject: " : "";
    const cites = claimId === null ? "the facts of this case" : "the facts this claim cites";
    // Amounts and dates must match the facts the claim cites (or, for a claim without cited
    // facts, any known fact). Semantic support is still for the human reviewer to judge.
    const claimAmounts =
      citedFacts.length === 0
        ? amounts
        : new Set<number>([
            ...citedFacts.flatMap((f) => (f.cents !== null ? [f.cents] : [])),
            ...(kind === "request"
              ? [snapshot.requestedCents, snapshot.claimableCents].filter(
                  (v): v is number => v !== null,
                )
              : []),
          ]);
    for (const amount of mentionedAmounts(text)) {
      if (amount.problem !== null) {
        issues.push({
          code: "AMOUNT_MISMATCH",
          claimId,
          message:
            amount.problem === "currency"
              ? `${where}Amount ${amount.text} is in a currency the facts do not use, so it cannot be checked; write it in US dollars.`
              : `${where}Amount ${amount.text} cannot be checked; write it with no decimals or with two.`,
          blocking: true,
        });
        continue;
      }
      if (amount.cents !== null && !claimAmounts.has(amount.cents)) {
        issues.push({
          code: "AMOUNT_MISMATCH",
          claimId,
          message: amounts.has(amount.cents)
            ? `${where}Amount ${amount.text} is not part of ${cites}; cite the fact it comes from.`
            : `${where}Amount ${amount.text} does not match any known fact amount.`,
          blocking: true,
        });
      }
    }

    const claimInstants =
      citedFacts.length === 0 ? knownInstants(snapshot) : citedFacts.flatMap(factInstants);
    const claimDates = new Set(claimInstants.map(dayOf));
    for (const mention of mentionedInstants(text)) {
      if (mention.problem !== null) {
        issues.push({
          code: "DATE_MISMATCH",
          claimId,
          message:
            mention.problem === "invalid"
              ? `${where}"${mention.text}" is not a date or time that can exist, so it cannot be checked.`
              : `${where}"${mention.text}" cannot be checked in this form; write the date as 2026-11-07 or Nov 7, 2026, and times in UTC.`,
          blocking: true,
        });
        continue;
      }
      if (mention.day !== null && !claimDates.has(mention.day)) {
        issues.push({
          code: "DATE_MISMATCH",
          claimId,
          message: dates.has(mention.day)
            ? `${where}Date ${mention.day} is not part of ${cites}; cite the fact it comes from.`
            : `${where}Date ${mention.day} does not match any known fact date.`,
          blocking: true,
        });
        continue;
      }
      if (
        mention.monthDay !== null &&
        !claimInstants.some((ms) => dayOf(ms).slice(5) === mention.monthDay)
      ) {
        issues.push({
          code: "DATE_MISMATCH",
          claimId,
          message: `${where}Date "${mention.text}" does not match the day of ${cites}.`,
          blocking: true,
        });
        continue;
      }
      if (mention.minute === null) continue;
      const timeMatches = claimInstants.some(
        (ms) =>
          minuteOf(ms) === mention.minute &&
          (mention.second === null || new Date(ms).getUTCSeconds() === mention.second) &&
          (mention.day === null || dayOf(ms) === mention.day),
      );
      if (!timeMatches)
        issues.push({
          code: "DATE_MISMATCH",
          claimId,
          message: `${where}Time "${mention.text}" does not match the time of ${cites} (times are compared in UTC, to the minute, and to the second when seconds are written).`,
          blocking: true,
        });
    }

    // A transaction is named only by the ID its payment record carries: the record of a fact the
    // claim cites, or for a claim without cited facts, the record of any fact.
    const mentionedIds = mentionedReferences(text);
    if (mentionedIds.length > 0) {
      const scopeFacts = citedFacts.length > 0 ? citedFacts : snapshot.facts;
      const allowed = new Set(
        scopeFacts.flatMap((f) => references?.transactionIdsByFact.get(f.id) ?? []),
      );
      for (const id of mentionedIds) {
        if (!allowed.has(id))
          issues.push({
            code: "REFERENCE_MISMATCH",
            claimId,
            message: `${where}Transaction ID ${id} is not carried by the PayPal record behind ${cites}; CancelCase adds the reference from the record itself.`,
            blocking: true,
          });
      }
    }

    for (const re of UNSUPPORTED_CERTAINTY_PATTERNS) {
      if (re.test(text)) {
        issues.push({
          code: "UNSUPPORTED_CERTAINTY",
          claimId,
          message: `${where}Wording "${(re.exec(text) ?? [""])[0]}" asserts more than the facts support.`,
          blocking: true,
        });
        break;
      }
    }
    for (const re of OUTCOME_PROMISE_PATTERNS) {
      if (re.test(text)) {
        issues.push({
          code: "OUTCOME_PROMISE",
          claimId,
          message: `${where}The draft promises an outcome that no party can promise.`,
          blocking: true,
        });
        break;
      }
    }

    // Contradiction checks against refund facts.
    const refundFacts = snapshot.facts.filter(
      (f) => f.kind === "refund" && f.visibleTo.includes(role),
    );
    const refundedCents = refundFacts.reduce((sum, f) => sum + (f.cents ?? 0), 0);
    if (
      /\bno refund\b|\bhas not been refunded\b|\bnot received any refund\b/i.test(text) &&
      refundedCents > 0
    ) {
      issues.push({
        code: "CONTRADICTION",
        claimId,
        message: `${where}The draft says no refund was issued, but the facts record a refund.`,
        blocking: true,
      });
    }
  };

  for (const claim of draft.claims) {
    for (const sid of claim.sourceIds) {
      if (!sourceById.has(sid) && scope?.undisclosedSourceIds.has(sid)) {
        issues.push({
          code: "UNDISCLOSED_SOURCE",
          claimId: claim.id,
          message: `Source ${sid} is private and not selected for disclosure; include it explicitly or remove the citation.`,
          blocking: true,
        });
      } else if (!sourceById.has(sid)) {
        issues.push({
          code: "UNKNOWN_SOURCE",
          claimId: claim.id,
          message: `Source ${sid} is not in the ${role} evidence snapshot.`,
          blocking: true,
        });
      }
    }
    for (const fid of claim.factIds) {
      const fact = factById.get(fid);
      if (!fact && scope?.undisclosedFactIds.has(fid)) {
        issues.push({
          code: "UNDISCLOSED_SOURCE",
          claimId: claim.id,
          message: `Fact ${fid} comes only from private sources that are not selected for disclosure.`,
          blocking: true,
        });
        continue;
      }
      if (!fact) {
        issues.push({
          code: "UNKNOWN_FACT",
          claimId: claim.id,
          message: `Fact ${fid} is not in the ${role} snapshot.`,
          blocking: true,
        });
        continue;
      }
      if (!fact.visibleTo.includes(role)) {
        issues.push({
          code: "ROLE_SCOPE_VIOLATION",
          claimId: claim.id,
          message: `Fact ${fid} is not visible to the ${role} role.`,
          blocking: true,
        });
      }
      // A fact ID alone is not evidence: the fact must still trace to at least one source
      // (a document, an attestation record or a recorded provider observation) in this snapshot.
      if (!fact.sourceIds.some((id) => sourceById.has(id))) {
        issues.push({
          code: "UNTRACEABLE_FACT",
          claimId: claim.id,
          message: `Fact ${fid} has no source available in this snapshot, so it cannot support a claim.`,
          blocking: true,
        });
      }
      citedFactKinds.add(fact.kind);
    }
    const citedFacts = claim.factIds
      .map((fid) => factById.get(fid))
      .filter((f): f is NormalizedFact => f !== undefined);
    // When a claim names both, its sources must belong to the facts it cites.
    if (claim.sourceIds.length > 0 && citedFacts.length > 0) {
      const factSources = new Set(citedFacts.flatMap((f) => f.sourceIds));
      if (!claim.sourceIds.some((id) => factSources.has(id))) {
        issues.push({
          code: "CITATION_MISMATCH",
          claimId: claim.id,
          message: "The cited sources do not support any of the cited facts.",
          blocking: true,
        });
      }
    }
    if (claim.kind === "fact" && claim.sourceIds.length === 0 && claim.factIds.length === 0) {
      issues.push({
        code: "UNSOURCED_FACT",
        claimId: claim.id,
        message: "A factual claim must cite at least one source or fact.",
        blocking: true,
      });
    }

    checkText(claim.text, claim.id, claim.kind, citedFacts);
  }

  // The subject is sent with the letter, so it is held to the same rules as a paragraph that
  // cites no fact: its amounts, dates and references must match a known fact, and it may not
  // promise an outcome.
  checkText(draft.subject, null, "context", []);

  for (const kind of requiredFactKinds(draft.action)) {
    if (!citedFactKinds.has(kind)) {
      issues.push({
        code: "REQUIRED_FACT_MISSING",
        claimId: null,
        message: `The draft does not cite a ${kind.replace(/_/g, " ")} fact.`,
        blocking: true,
      });
    }
  }

  for (const evidenceId of draft.attachmentEvidenceIds) {
    const source = sourceById.get(evidenceId);
    if (!source && scope?.undisclosedSourceIds.has(evidenceId)) {
      issues.push({
        code: "UNDISCLOSED_SOURCE",
        claimId: null,
        message: `Attachment ${evidenceId} is private and not selected for disclosure.`,
        blocking: true,
      });
    } else if (!source) {
      issues.push({
        code: "ATTACHMENT_NOT_ALLOWED",
        claimId: null,
        message: `Attachment ${evidenceId} is not in the ${role} evidence snapshot.`,
        blocking: true,
      });
    }
  }

  return { ok: issues.every((i) => !i.blocking), issues };
}

/**
 * Convert a validated model draft into DraftContent. Deterministic greeting/closing are not
 * part of the claims; the renderer adds them.
 */
export function toDraftContent(
  model: ModelDraft,
  action: DraftContent["action"],
  role: Role,
  attachmentEvidenceIds: string[],
  privateSourceIdsIncluded: string[] = [],
): DraftContent {
  return {
    action,
    role,
    subject: model.subject,
    claims: model.claims.map((c) => ({
      id: c.id,
      kind: c.kind,
      text: c.text,
      sourceIds: c.source_ids,
      factIds: c.fact_ids,
    })),
    attachmentEvidenceIds,
    privateSourceIdsIncluded,
  };
}
