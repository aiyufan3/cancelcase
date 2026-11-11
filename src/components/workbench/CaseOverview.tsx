"use client";

import type { CSSProperties } from "react";
import type { CaseView } from "@/server/services/case-view";
import { StatePill, formatClock, formatDay } from "../ui";
import { awaitingFirstPayment, formatInterval, Labelled, useWorkbench } from "./shared";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * Digits as counters: each one is a strip that rolls to its value when the amount arrives and
 * again whenever it changes. The strip starts on an empty cell, so no number that is not the
 * amount ever rests on screen. Decorative only; the readable amount is the label beside it.
 */
function Roll({ text, offset = 0 }: { text: string; offset?: number }) {
  return (
    <>
      {[...text].map((ch, i) =>
        ch >= "0" && ch <= "9" ? (
          <span
            key={i}
            className="digit"
            style={{ "--d": Number(ch), "--i": offset + i } as CSSProperties}
          >
            <span className="digit-strip">
              <span />
              {DIGITS.map((n) => (
                <span key={n}>{n}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

/** The amount set like a receipt total: large whole units, raised cents, a readable currency. */
export function Amount({ cents, label }: { cents: number | null; label: string }) {
  if (cents === null)
    return (
      <p className="amount amount-unknown" aria-label={label}>
        Unknown amount
      </p>
    );
  const whole = Math.floor(Math.abs(cents) / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (Math.abs(cents) % 100).toString().padStart(2, "0");
  return (
    <p className="amount">
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="amount-symbol">
        $
      </span>
      <span aria-hidden="true">
        <Roll text={whole} />
      </span>
      <span aria-hidden="true" className="amount-tail">
        <span className="amount-cents">
          .<Roll text={fraction} offset={whole.length} />
        </span>
        <span className="amount-currency">USD</span>
      </span>
    </p>
  );
}

/** The provider's billing plan in the right tense: a time that has passed is not "the next". */
function billingPlan(planned: string | null, now: string): string {
  if (!planned) return "";
  return Date.parse(planned) <= Date.parse(now)
    ? `The provider planned a billing for ${formatDay(planned)}.`
    : `The provider plans the next billing for ${formatDay(planned)}.`;
}

/** The case as an object: a folder, the receipt with the amount, and the fact chain. */
export function CaseOverview() {
  const { view, role } = useWorkbench();
  const c = view.case;
  const reconciled = c.classification !== "NEEDS_REVIEW";
  const waiting = awaitingFirstPayment(view);
  const planned = view.subscription.cancellation.providerMandateNextBillingAt;
  return (
    <section className="folder px-4 pb-5 pt-6 sm:px-7 sm:pb-7" aria-labelledby="case-title">
      <div className="folder-tab">
        <span>{view.subscription.label}</span>
      </div>
      <h1
        id="case-title"
        className="relative max-w-[30ch] text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl"
      >
        {c.buyerAlias} and {c.merchantAlias}
      </h1>
      <p className="relative mt-1 text-sm text-ink-soft">
        {role === "buyer" ? "Buyer" : "Merchant"} view of case <span className="mono">{c.id}</span>
      </p>

      <div className="receipt mt-5 px-5 pb-9 pt-5 sm:px-7">
        <p className="text-sm font-semibold text-ink-muted">
          {waiting
            ? "First payment"
            : c.classification === "NO_ANOMALY"
              ? "Charge amount (nothing under review)"
              : "Amount under review"}
        </p>
        <div className="mt-2">
          {waiting ? (
            <p className="amount amount-unknown">No payment yet</p>
          ) : (
            <Amount cents={c.amountUnderReviewCents} label={c.amountUnderReviewText} />
          )}
        </div>
        {waiting ? (
          <p className="mt-4 max-w-[64ch] text-[0.975rem] text-ink-soft">
            <strong className="text-ink">Nothing to check yet.</strong> No payment has been read for
            this subscription. {billingPlan(planned, view.serverTime)} When a payment is read, it is
            recorded here and checked against your cancellation.
          </p>
        ) : (
          <p className="mt-4 max-w-[64ch] text-[0.975rem] text-ink-soft">
            <strong className="text-ink">{c.classificationText.title}.</strong>{" "}
            {c.classificationText.summary}
          </p>
        )}
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Labelled label="Money recovered (verified)">
            {c.recoveredCents > 0 ? (
              <span className="font-semibold">{c.recoveredText}</span>
            ) : (
              <>
                <span className="text-ink-muted">{c.recoveredText}</span>
                <span className="block text-xs font-semibold text-ink-soft">
                  {recoveryHint(view)}
                </span>
              </>
            )}
            <span className="block text-xs text-ink-muted">Counts refunds read back only.</span>
          </Labelled>
          <Labelled label={`${role === "buyer" ? "Buyer" : "Merchant"} workflow`}>
            <StatePill state={c.roleState} />
          </Labelled>
          <Labelled label="Provider case">
            {view.provider ? (
              <>
                <StatePill state={view.provider.status ?? "UNKNOWN"} />
                <span className="block text-xs text-ink-muted">
                  {view.provider.provenance === "synthetic" ? "Simulated" : "Observed"}{" "}
                  {formatDay(view.provider.observedAt)}
                  {view.provider.observedAt && (
                    <span className="block">{formatClock(view.provider.observedAt)}</span>
                  )}
                </span>
              </>
            ) : (
              <span className="text-ink-muted">None yet</span>
            )}
          </Labelled>
        </dl>
      </div>

      <FactChain view={view} reconciled={reconciled} waiting={waiting} />
    </section>
  );
}

/**
 * While nothing has been recovered, what the case is waiting on, in a few words. It restates the
 * provider case as read (or that there is none) and never predicts an outcome.
 */
export function recoveryHint(view: CaseView): string {
  const p = view.provider;
  if (!p) return "No refund read back yet";
  switch (p.status) {
    case "WAITING_FOR_SELLER_RESPONSE":
      return "Awaiting seller response";
    case "WAITING_FOR_BUYER_RESPONSE":
      return "Awaiting buyer response";
    case "UNDER_REVIEW":
      return "Case under review";
    case "OPEN":
      return "Case open";
    case "RESOLVED":
      if (p.outcome === "RESOLVED_SELLER_FAVOUR") return "Decided in the seller's favour";
      if (p.outcome === "RESOLVED_BUYER_FAVOUR")
        return "Decided in the buyer's favour; no refund read back yet";
      return "Case resolved";
    default:
      return "No refund read back yet";
  }
}

function FactChain({
  view,
  reconciled,
  waiting,
}: {
  view: CaseView;
  reconciled: boolean;
  waiting: boolean;
}) {
  const canc = view.subscription.cancellation;
  const ch = view.charge;
  const relation = formatInterval(canc.effectiveAt, ch.eventTime);
  const planned = canc.providerMandateNextBillingAt;
  // A link is drawn solid only between two things that are actually known: the two times for
  // the first, a payment with a time and a check that reached a result for the second.
  const timesKnown = Boolean(canc.effectiveAt && ch.eventTime);
  const checked = reconciled && Boolean(ch.eventTime);
  const status = ch.status.toLowerCase().replace(/_/g, " ");
  return (
    <ol className="chain mt-5" aria-label="Fact chain">
      <li className="chain-node" data-known={canc.effectiveAt ? "true" : "false"}>
        <p className="text-[0.8125rem] font-semibold text-ink-muted">Cancellation takes effect</p>
        <p className="mt-1 font-bold">
          {canc.effectiveAt ? formatDay(canc.effectiveAt) : "Not recorded yet"}
          {canc.effectiveAt && (
            <span className="block text-sm">{formatClock(canc.effectiveAt)}</span>
          )}
        </p>
        <p className="mt-1 text-xs text-ink-soft">
          {canc.effectiveAt ? canc.basisLabel : "Record the confirmation you received."}
        </p>
      </li>
      <li
        className="chain-link"
        aria-hidden="true"
        data-connected={timesKnown ? "true" : "false"}
      />
      {waiting ? (
        <li className="chain-node" data-known="false">
          <p className="text-[0.8125rem] font-semibold text-ink-muted">First payment</p>
          <p className="mt-1 font-bold">None read yet</p>
          <p className="mt-1 text-xs text-ink-soft">
            {billingPlan(planned, view.serverTime) ||
              "Read the payments to see whether the provider has billed."}
          </p>
        </li>
      ) : (
        <li className="chain-node" data-known={ch.eventTime ? "true" : "false"}>
          <p className="text-[0.8125rem] font-semibold text-ink-muted">Charge initiated</p>
          <p className="mt-1 font-bold">
            {ch.eventTime ? formatDay(ch.eventTime) : "Time unknown"}
            {ch.eventTime && <span className="block text-sm">{formatClock(ch.eventTime)}</span>}
          </p>
          <p className="mt-1 text-xs text-ink-soft">
            {ch.amountText ?? "Amount unknown"}
            {status === "unknown" ? ", status unknown" : `, ${status}`}
            {relation && canc.effectiveAt ? `, ${relation} the cancellation` : ""}
          </p>
        </li>
      )}
      <li className="chain-link" aria-hidden="true" data-connected={checked ? "true" : "false"} />
      {waiting ? (
        <li className="chain-node" data-known="false">
          <p className="text-[0.8125rem] font-semibold text-ink-muted">Check result</p>
          <p className="mt-1 font-bold">Not checked yet</p>
          <p className="mt-1 text-xs text-ink-soft">The check needs a payment to compare.</p>
        </li>
      ) : (
        <li
          className="chain-node"
          data-known={checked ? "true" : "false"}
          data-verdict={view.case.classification}
        >
          <p className="text-[0.8125rem] font-semibold text-ink-muted">Check result</p>
          <p className="mt-1 font-bold">{view.case.classificationText.title}</p>
          <p className="mt-1 text-xs text-ink-soft">
            {view.case.reasonCodes[0]?.text ?? "No reason recorded."}
          </p>
        </li>
      )}
    </ol>
  );
}
