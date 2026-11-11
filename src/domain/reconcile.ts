import type { ChargeFacts, ReasonCode, ReconcileResult, SubscriptionFacts } from "./types";
import { isCancellationConfirmed } from "./cancellation";
import { compareInstants, isValidInstant } from "./time";
import { remainingCents } from "./money";

/**
 * Deterministic reconciler. Pure function, no I/O.
 *
 * It compares the charge's relevant *event* time with the *effective* cancellation
 * time, and checks identity, currency, status and refund facts. It returns a
 * classification with reason codes and the sources it relied on. A candidate is
 * not a conclusion that the charge was unlawful; it is a reviewable anomaly.
 */
export function reconcile(subscription: SubscriptionFacts, charge: ChargeFacts): ReconcileResult {
  const reasons: ReasonCode[] = [];
  const sourceIds = uniq([
    ...subscription.sourceIds,
    ...subscription.cancellation.evidenceIds,
    ...charge.sourceIds,
  ]);
  const facts = {
    effectiveAt: subscription.cancellation.effectiveAt,
    eventTime: charge.eventTime,
    postedTime: charge.postedTime,
    servicePeriodStart: charge.servicePeriodStart,
    servicePeriodEnd: charge.servicePeriodEnd,
  };
  const result = (
    classification: ReconcileResult["classification"],
    claimableCents: number | null,
  ): ReconcileResult => ({
    classification,
    reasonCodes: uniq(reasons),
    sourceIds,
    claimableCents,
    facts,
  });

  // 1. Identity: environment, account, association.
  if (charge.environment !== subscription.environment) {
    reasons.push("ENVIRONMENT_MISMATCH");
    return result("NO_ANOMALY", null);
  }
  if (charge.accountAlias !== subscription.accountAlias) {
    reasons.push("ACCOUNT_MISMATCH");
    return result("NO_ANOMALY", null);
  }
  if (charge.subscriptionId !== null && charge.subscriptionId !== subscription.id) {
    reasons.push("DIFFERENT_SUBSCRIPTION");
    return result("NO_ANOMALY", null);
  }
  if (charge.matchMethod === "merchant_name_only") {
    // Same merchant name alone never establishes the association.
    reasons.push("ASSOCIATION_UNRELIABLE");
    return result("NEEDS_REVIEW", null);
  }
  if (charge.matchMethod === "none" || charge.subscriptionId === null) {
    reasons.push("NO_ASSOCIATION");
    return result("NEEDS_REVIEW", null);
  }

  // 2. Cancellation must be confirmed with an effective time.
  const cancellation = subscription.cancellation;
  if (cancellation.state === "TRACKING") {
    reasons.push("SUBSCRIPTION_ACTIVE_NO_CANCELLATION");
    return result("NO_ANOMALY", null);
  }
  if (cancellation.state === "NEEDS_REVIEW") {
    reasons.push("CANCELLATION_NEEDS_REVIEW");
    return result("NEEDS_REVIEW", null);
  }
  if (!isCancellationConfirmed(cancellation)) {
    reasons.push("CANCELLATION_NOT_CONFIRMED");
    return result("NEEDS_REVIEW", null);
  }

  // 3. Currency and amount.
  if (charge.currency !== "USD" || (charge.amount && charge.amount.currency !== "USD")) {
    reasons.push("UNSUPPORTED_CURRENCY");
    return result("NEEDS_REVIEW", null);
  }
  if (charge.amount === null) {
    reasons.push("AMOUNT_UNKNOWN");
    return result("NEEDS_REVIEW", null);
  }
  if (charge.amount.cents === 0) {
    reasons.push("ZERO_AMOUNT");
    return result("NO_ANOMALY", 0);
  }

  // 4. Charge status.
  switch (charge.status) {
    case "PENDING":
      reasons.push("CHARGE_PENDING");
      return result("NEEDS_REVIEW", null);
    case "FAILED":
    case "DENIED":
      reasons.push("CHARGE_NOT_COMPLETED");
      return result("NO_ANOMALY", 0);
    case "REVERSED":
      reasons.push("CHARGE_REVERSED");
      return result("NO_ANOMALY", 0);
    case "REFUNDED":
      reasons.push("FULLY_REFUNDED");
      return result("NO_ANOMALY", 0);
    case "UNKNOWN":
      reasons.push("CHARGE_STATUS_UNKNOWN");
      return result("NEEDS_REVIEW", null);
    case "COMPLETED":
    case "PARTIALLY_REFUNDED":
      break;
    default: {
      const _exhaustive: never = charge.status;
      return _exhaustive;
    }
  }

  // 5. Timeline: event time strictly later than effective cancellation time.
  if (!isValidInstant(charge.eventTime)) {
    reasons.push(charge.eventTime ? "INVALID_TIMESTAMP" : "MISSING_EVENT_TIME");
    return result("NEEDS_REVIEW", null);
  }
  const cmp = compareInstants(charge.eventTime, cancellation.effectiveAt);
  if (cmp === "unknown") {
    reasons.push("INVALID_TIMESTAMP");
    return result("NEEDS_REVIEW", null);
  }
  if (cmp === "equal") {
    reasons.push("BOUNDARY_EQUALITY");
    return result("NEEDS_REVIEW", null);
  }
  if (cmp === "before") {
    reasons.push("CHARGE_BEFORE_CANCELLATION");
    if (
      charge.postedTime &&
      compareInstants(charge.postedTime, cancellation.effectiveAt) === "after"
    ) {
      reasons.push("POSTED_AFTER_BUT_INITIATED_BEFORE");
    }
    return result("NO_ANOMALY", 0);
  }
  reasons.push("CHARGE_AFTER_EFFECTIVE_CANCELLATION");

  // 6. Billing context: arrears for a period that ended before cancellation needs review.
  if (charge.arrearsIndicator === true) {
    reasons.push("POSSIBLE_ARREARS");
    return result("NEEDS_REVIEW", null);
  }
  if (charge.servicePeriodEnd && isValidInstant(charge.servicePeriodEnd)) {
    const periodCmp = compareInstants(charge.servicePeriodEnd, cancellation.effectiveAt);
    if (periodCmp === "before" || periodCmp === "equal") {
      reasons.push("SERVICE_PERIOD_BEFORE_CANCELLATION");
      return result("NEEDS_REVIEW", null);
    }
  } else {
    reasons.push("SERVICE_PERIOD_UNKNOWN");
  }

  // 7. Refunds reduce the maximum request; unknown refund state blocks a payable amount.
  if (!charge.refundStateKnown || charge.refundedCents === null) {
    reasons.push("REFUND_STATE_UNKNOWN");
    return result("CANDIDATE_AFTER_CANCEL", null);
  }
  const remaining = remainingCents(charge.amount.cents, charge.refundedCents);
  if (remaining === 0) {
    reasons.push("FULLY_REFUNDED");
    return result("NO_ANOMALY", 0);
  }
  if (charge.refundedCents > 0) {
    reasons.push("PARTIAL_REFUND_REDUCES_CLAIM");
  }
  return result("CANDIDATE_AFTER_CANCEL", remaining);
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

/**
 * Deduplicate normalized charges that describe the same payment.
 * Two observations are the same charge when they share a provider reference value of the
 * same kind (e.g. the same seller transaction ID) within the same environment and account.
 * Reporting rows that are not balance-affecting never create a second charge.
 */
export interface ChargeObservation {
  environment: string;
  accountAlias: string;
  refs: { kind: string; value: string }[];
  balanceAffecting: boolean;
}

export function dedupeChargeObservations<T extends ChargeObservation>(observations: T[]): T[] {
  const seen = new Map<string, T>();
  const kept: T[] = [];
  for (const obs of observations) {
    if (!obs.balanceAffecting) continue;
    const keys = obs.refs.map((r) => `${obs.environment}|${obs.accountAlias}|${r.kind}|${r.value}`);
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.set(k, obs);
    kept.push(obs);
  }
  return kept;
}
