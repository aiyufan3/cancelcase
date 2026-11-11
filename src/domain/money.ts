import type { Currency, Money } from "./types";

export class MoneyError extends Error {
  constructor(
    message: string,
    readonly code: "UNSUPPORTED_CURRENCY" | "INVALID_DECIMAL" | "NEGATIVE_AMOUNT",
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

const DECIMAL_RE = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parse a provider decimal string such as "19.99" exactly into integer cents.
 * No floating point is involved at any step.
 */
export function parseUsdDecimal(value: string): number {
  const trimmed = value.trim();
  const match = DECIMAL_RE.exec(trimmed);
  if (!match) {
    throw new MoneyError(`Invalid USD decimal string: ${JSON.stringify(value)}`, "INVALID_DECIMAL");
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return Number.parseInt(whole, 10) * 100 + Number.parseInt(fraction, 10);
}

export function parseProviderAmount(value: string, currency: string): Money {
  if (currency !== "USD") {
    throw new MoneyError(
      `Unsupported currency ${currency}; P0 accepts USD only`,
      "UNSUPPORTED_CURRENCY",
    );
  }
  const cents = parseUsdDecimal(value);
  return { cents, currency: "USD" };
}

export function assertCents(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new MoneyError(`Amount must be integer cents, got ${cents}`, "INVALID_DECIMAL");
  }
  if (cents < 0) {
    throw new MoneyError(`Amount must not be negative, got ${cents}`, "NEGATIVE_AMOUNT");
  }
  return cents;
}

export function formatCents(cents: number, currency: Currency = "USD"): string {
  assertCents(Math.abs(cents));
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = (abs % 100).toString().padStart(2, "0");
  const wholeWithSeparators = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${wholeWithSeparators}.${fraction} ${currency}`;
}

/** Decimal string without currency symbol, e.g. 1999 -> "19.99" (what the provider API expects). */
export function centsToDecimalString(cents: number): string {
  assertCents(cents);
  const whole = Math.floor(cents / 100);
  const fraction = (cents % 100).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

export function remainingCents(amountCents: number, refundedCents: number): number {
  assertCents(amountCents);
  assertCents(refundedCents);
  return Math.max(0, amountCents - refundedCents);
}
