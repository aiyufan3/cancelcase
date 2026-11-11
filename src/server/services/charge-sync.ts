import type { AppContext } from "../context";
import { cases, charges } from "../db/repos";
import type { ChargeRecord } from "../records";
import type { ChargeStatus, Provenance } from "@/domain/types";
import { parseProviderAmount } from "@/domain/money";
import type { SubscriptionTransactionReadback } from "@/paypal/adapter";
import { logAudit } from "./audit";
import { bumpSnapshot, reconcileCase } from "./case-service";

/**
 * Payment facts derived from a provider transaction read. Only what the read states is used:
 *  - the payment time is the transaction time, never a local creation or import time;
 *  - an unrecognised status stays UNKNOWN instead of being promoted to COMPLETED;
 *  - the refund amount is known only when the status says so (COMPLETED → nothing refunded,
 *    REFUNDED → fully refunded). A partial refund without an amount stays unknown, never 0.
 */
export type ChargeFacts = Pick<
  ChargeRecord,
  "status" | "eventTime" | "amountCents" | "refundedCents" | "refundStateKnown"
>;

const CHARGE_STATUSES: readonly ChargeStatus[] = [
  "COMPLETED",
  "PENDING",
  "FAILED",
  "DENIED",
  "REVERSED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
];

export function mapChargeStatus(raw: string | null | undefined): ChargeStatus {
  const value = (raw ?? "").trim().toUpperCase();
  if (value === "DECLINED") return "DENIED";
  return (CHARGE_STATUSES as readonly string[]).includes(value)
    ? (value as ChargeStatus)
    : "UNKNOWN";
}

function amountCents(value: string | null, currency: string | null): number | null {
  if (!value || !currency) return null;
  try {
    return parseProviderAmount(value, currency).cents;
  } catch {
    return null;
  }
}

export function chargeFactsFrom(input: {
  status: string | null;
  time: string | null;
  amountValue: string | null;
  amountCurrency: string | null;
}): ChargeFacts {
  const status = mapChargeStatus(input.status);
  const cents = amountCents(input.amountValue, input.amountCurrency);
  const refund =
    status === "COMPLETED"
      ? { refundedCents: 0, refundStateKnown: true }
      : status === "REFUNDED" && cents !== null
        ? { refundedCents: cents, refundStateKnown: true }
        : { refundedCents: null, refundStateKnown: false };
  return { status, eventTime: input.time, amountCents: cents, ...refund };
}

export function chargeFactsFromTransaction(tx: SubscriptionTransactionReadback): ChargeFacts {
  return chargeFactsFrom(tx);
}

function sameFacts(a: ChargeFacts, b: ChargeFacts): boolean {
  return (
    a.status === b.status &&
    a.eventTime === b.eventTime &&
    a.amountCents === b.amountCents &&
    a.refundedCents === b.refundedCents &&
    a.refundStateKnown === b.refundStateKnown
  );
}

/** A last-payment time and its transaction time can differ by moments; cycles are days apart. */
const ADOPTION_WINDOW_MS = 10 * 60 * 1000;

function closestWithin(
  txs: SubscriptionTransactionReadback[],
  at: string,
  windowMs: number,
): SubscriptionTransactionReadback | null {
  const target = Date.parse(at);
  if (Number.isNaN(target)) return null;
  let best: SubscriptionTransactionReadback | null = null;
  let bestGap = Infinity;
  for (const t of txs) {
    const gap = Math.abs(Date.parse(t.time ?? "") - target);
    if (gap <= windowMs && gap < bestGap) {
      best = t;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Apply a provider subscription transaction to a case's charge.
 *  - A charge without a sale reference adopts the most recent transaction the read returned
 *    (a payment observed after the case was created).
 *  - A charge with a sale reference is only ever updated from that same sale.
 * When the facts change, the case is reconciled and its evidence snapshot moves forward, so
 * every draft and approval bound to the old facts becomes stale.
 */
export function syncChargeFromTransactions(
  ctx: AppContext,
  caseId: string,
  transactions: SubscriptionTransactionReadback[],
  provenance: Provenance,
  trigger: string,
): { changed: boolean; adopted: boolean; transactionId: string | null } {
  // Identity checks and adoption share a write reservation with connected/import creation,
  // so another process cannot claim the same payment between the check and the update.
  return ctx.db
    .transaction(() =>
      syncChargeFromTransactionsLocked(ctx, caseId, transactions, provenance, trigger),
    )
    .immediate();
}

function syncChargeFromTransactionsLocked(
  ctx: AppContext,
  caseId: string,
  transactions: SubscriptionTransactionReadback[],
  provenance: Provenance,
  trigger: string,
): { changed: boolean; adopted: boolean; transactionId: string | null } {
  const rec = cases.get(ctx.db, caseId);
  if (!rec) return { changed: false, adopted: false, transactionId: null };
  const charge = charges.get(ctx.db, rec.chargeId);
  if (!charge) return { changed: false, adopted: false, transactionId: null };
  const saleRef = charge.providerRefs.find((r) => r.kind === "subscription_sale_id");
  // A charge known only from the subscription's last-payment time adopts the transaction made at
  // that time; only a charge without any time adopts the most recent one. With a recurring
  // subscription the most recent transaction may be a later cycle's payment.
  const dated = [...transactions]
    .filter((t) => t.id && Number.isFinite(Date.parse(t.time ?? "")))
    .sort((a, b) => Date.parse(a.time!) - Date.parse(b.time!));
  const tx = saleRef
    ? (transactions.find((t) => t.id === saleRef.value) ?? null)
    : charge.eventTime
      ? closestWithin(dated, charge.eventTime, ADOPTION_WINDOW_MS)
      : (dated.pop() ?? transactions.find((t) => t.id) ?? null);
  if (!tx) return { changed: false, adopted: false, transactionId: null };
  if (!saleRef) {
    const owners = charges.findByPaymentRefs(ctx.db, charge.environment, charge.accountAlias, [
      { kind: "subscription_sale_id", value: tx.id, provenance },
    ]);
    const dedupeOwner = charges.getByDedupeKey(
      ctx.db,
      charge.environment,
      charge.accountAlias,
      tx.id,
    );
    if (
      owners.some((owner) => owner.id !== charge.id) ||
      (dedupeOwner && dedupeOwner.id !== charge.id)
    ) {
      logAudit(ctx, {
        action: "charge.adoption_blocked",
        caseId,
        reasonCode: "PAYMENT_ALREADY_RECORDED",
        details: { trigger, provenance },
      });
      // Preserve the unresolved placeholder for review. The already identified case receives
      // this sale's facts independently; no live record is merged or deleted here.
      return { changed: false, adopted: false, transactionId: null };
    }
  }
  const next = chargeFactsFromTransaction(tx);
  const current: ChargeFacts = {
    status: charge.status,
    eventTime: charge.eventTime,
    amountCents: charge.amountCents,
    refundedCents: charge.refundedCents,
    refundStateKnown: charge.refundStateKnown,
  };
  const adopted = !saleRef;
  if (!adopted && sameFacts(current, next))
    return { changed: false, adopted: false, transactionId: tx.id };
  const now = ctx.clock.now().toISOString();
  charges.update(ctx.db, {
    ...charge,
    ...next,
    providerRefs: adopted
      ? [...charge.providerRefs, { kind: "subscription_sale_id", value: tx.id, provenance }]
      : charge.providerRefs,
    matchMethod: adopted ? "provider_subscription_transaction" : charge.matchMethod,
    dedupeKey: adopted ? tx.id : charge.dedupeKey,
    updatedAt: now,
  });
  logAudit(ctx, {
    action: "charge.synced",
    caseId,
    reasonCode: adopted ? "adopted_transaction" : "transaction_changed",
    details: {
      trigger,
      provenance,
      status: next.status,
      refundStateKnown: next.refundStateKnown,
    },
  });
  const before = rec.evidenceSnapshotVersion;
  reconcileCase(ctx, caseId, `charge_sync:${trigger}`);
  const after = cases.get(ctx.db, caseId)!;
  if (after.evidenceSnapshotVersion === before)
    bumpSnapshot(ctx, after, `charge_facts_changed:${trigger}`);
  return { changed: true, adopted, transactionId: tx.id };
}
