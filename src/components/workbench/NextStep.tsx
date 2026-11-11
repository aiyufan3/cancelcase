"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CaseView, ViewOperation } from "@/server/services/case-view";
import { apiPost } from "@/lib/client-api";
import { formatDay } from "../ui";
import {
  ACTION_HELP,
  LocalStatus,
  TEMPLATE_DRAFT_NOTE,
  actionLabel,
  awaitingFirstPayment,
  inSentence,
  isProviderWrite,
  useWorkbench,
  type ActionKind,
  type Role,
} from "./shared";

/**
 * A step the app can take by itself when the person asks: a read or a draft. There is no act for
 * recording facts, approving or sending; those stay with the person.
 */
export type StepAct =
  | { kind: "read_payments" }
  | { kind: "draft"; action: ActionKind; regenerate: boolean }
  | { kind: "refresh_provider" };

interface Step {
  tone: "go" | "attention" | "blocked";
  title: string;
  body: string;
  target: string;
  label: string;
  opensCancellation?: boolean;
  /** When set, the step's button takes the step instead of pointing at the place for it. */
  act?: StepAct;
}

function providerStep(view: CaseView): Step {
  const provider = view.provider!;
  if (provider.stale)
    return {
      tone: "attention",
      title: "Refresh the provider case",
      body: "The last read could not confirm the provider's current state. Refresh the case before deciding what to do next.",
      target: "#provider",
      label: "See the provider case",
      act: { kind: "refresh_provider" },
    };
  return {
    tone: "blocked",
    title:
      provider.status === "UNDER_REVIEW"
        ? view.mode.environment === "fixture"
          ? "The case is with the simulated provider"
          : "The case is with PayPal"
        : "Follow the provider case",
    body: `Last observed as ${(provider.status ?? "unknown").replace(/_/g, " ").toLowerCase()}. The provider decides; refresh to read its current state.`,
    target: "#provider",
    label: "See the provider case",
    act: { kind: "refresh_provider" },
  };
}

/**
 * The provider has decided the case. What is left is to read the money back, or nothing: a
 * decision is reported as read, never judged, and a simulated one says so.
 */
function resolvedStep(view: CaseView, role: Role): Step {
  const p = view.provider!;
  const code = (p.outcome ?? "").toUpperCase();
  const favour = code.includes("BUYER_FAVO")
    ? "buyer"
    : code.includes("SELLER_FAVO")
      ? "seller"
      : null;
  const provider = view.mode.environment === "fixture" ? "The simulated provider" : "PayPal";
  const simulated = (p.testControls ?? []).some(
    (t) => t.kind === "settlement" && t.status === "SUCCEEDED",
  );
  const decided =
    favour === "buyer"
      ? "in the buyer's favour"
      : favour === "seller"
        ? "in the seller's favour"
        : `with the outcome ${code ? code.replace(/_/g, " ").toLowerCase() : "not given"}`;
  const who = simulated
    ? `${provider}'s Sandbox test control decided the case`
    : `${provider} decided the case`;
  const said = `${who} ${decided}.`;
  if (role === "buyer" && favour === "buyer") {
    if (view.case.recoveredCents > 0)
      return {
        tone: "blocked",
        title: "Resolved, and the refund was read back",
        body: `${said} ${provider} reports ${view.case.recoveredText} refunded; that is what counts as recovered.`,
        target: "#provider",
        label: "See the provider case",
      };
    if (view.subscription.paymentsReadable)
      return {
        tone: "go",
        title: "Read the refund back",
        body: `${said} A refund counts as recovered only when ${provider} reports it: read the payments.`,
        target: "#cancellation",
        label: "Go to the subscription",
        act: { kind: "read_payments" },
      };
  }
  return {
    tone: "blocked",
    title: `${provider} decided the case`,
    body: `${said} CancelCase reports the decision as read back; it does not judge it.`,
    target: "#provider",
    label: "See the provider case",
  };
}

/**
 * One next step, derived only from server-provided state (operations, cancellation record,
 * reconciliation and the server's readiness reasons). It names the place where the step is
 * taken and, for a read or a draft, an act the app can take there. It never describes an
 * approval or a send as something the app does.
 */
export function deriveNextStep(view: CaseView, role: Role): Step {
  const ops = view.operations;
  if (ops.some((o) => o.status === "UNKNOWN"))
    return {
      tone: "attention",
      title: "Check what happened to the last request",
      body: "Its result is unknown: it may or may not have reached the provider. Read it back and record what you verify. Nothing is sent again automatically.",
      target: "#operations",
      label: "Go to the unknown result",
    };
  if (ops.some((o) => o.status === "DISPATCHING" || o.status === "PREPARED"))
    return {
      tone: "blocked",
      title: "A request is being sent",
      body: "Wait for its result before changing anything else.",
      target: "#operations",
      label: "See the request",
    };
  // A decided provider case comes before everything that would lead to it. Without an outcome
  // code the decision is not known yet: the step is to read the case again.
  if (view.provider?.status === "RESOLVED")
    return view.provider.outcome ? resolvedStep(view, role) : providerStep(view);
  // A completed seller response hands the case back to the provider unless a new evidence
  // request is currently actionable. The buyer's anomaly check does not determine that flow.
  if (
    role === "merchant" &&
    view.provider &&
    ops.some((o) => o.action === "merchant_provide_evidence" && o.status === "SUCCEEDED") &&
    !view.provider.evidenceCapability?.allowed
  )
    return providerStep(view);
  const c = view.case;
  if (role === "buyer" && view.subscription.cancellation.state !== "CANCEL_CONFIRMED")
    return {
      tone: "go",
      title: "Record the cancellation you received",
      body: "Enter when it takes effect and choose the document that proves it. Recording it does not cancel anything.",
      target: "#cancellation",
      label: "Open the form",
      opensCancellation: true,
    };
  // The provider still plans to bill after the recorded cancellation. A plan is not a payment:
  // the step is to read the payments, and it never overrides a real open review.
  const watch = view.subscription.billingWatch;
  // A case created before any payment exists. Read only where the view is the buyer's own.
  const unpaid = () => view.charge.eventTime === null && view.charge.providerRefs.length === 0;
  if (
    role === "buyer" &&
    watch &&
    view.subscription.paymentsReadable &&
    (c.classification === "NO_ANOMALY" || unpaid())
  )
    return watch.due
      ? {
          tone: "go",
          title: "Read the payments",
          body: unpaid()
            ? `A billing was planned for ${formatDay(watch.nextBillingAt)}, after your cancellation took effect. Read the payments: the first one is recorded in this case and checked against your cancellation.`
            : `A billing was planned for ${formatDay(watch.nextBillingAt)}, after your cancellation took effect. Read the payments: one made after the cancellation becomes its own case.`,
          target: "#cancellation",
          label: "Go to the subscription",
          act: { kind: "read_payments" },
        }
      : {
          tone: "attention",
          title: "A billing is still planned",
          body: `The provider lists this subscription as active and plans to bill it on ${formatDay(watch.nextBillingAt)}, after your recorded cancellation. Recording it here does not stop the billing.`,
          target: "#cancellation",
          label: "See the subscription",
        };
  // No payment has been read and the provider's plan is not known either: there is nothing to
  // resolve by hand, only something to read.
  if (role === "buyer" && view.subscription.paymentsReadable && awaitingFirstPayment(view))
    return {
      tone: "attention",
      title: "No payment yet",
      body: "Nothing has been read for this subscription, so there is nothing to check. Read the payments to see whether the provider has billed it.",
      target: "#cancellation",
      label: "Go to the subscription",
      act: { kind: "read_payments" },
    };
  if (role === "buyer" && c.classification === "NEEDS_REVIEW")
    return {
      tone: "attention",
      title: "Resolve what the check could not confirm",
      body: c.reasonCodes[0]?.text ?? c.classificationText.summary,
      target: "#charge",
      label: "See the check",
    };
  if (role === "buyer" && c.classification === "NO_ANOMALY")
    return {
      tone: "blocked",
      title: "Nothing to request",
      body: c.classificationText.summary,
      target: "#charge",
      label: "See the check",
    };
  // The step follows the channel the case is on: with the PayPal channel the PayPal case comes
  // before the request to the merchant, otherwise the order the server lists the actions in.
  const actions = [...(view.availableActions as ActionKind[])];
  if (c.channel === "paypal")
    actions.sort(
      (a, b) => Number(b === "buyer_create_dispute") - Number(a === "buyer_create_dispute"),
    );
  // What is already under way comes first, whichever action it belongs to: an approval waiting
  // to be used, a draft waiting for a decision. Starting something new never hides it.
  for (const action of actions) {
    const ready = view.readiness[action];
    const draft = view.drafts[action];
    const approval = view.approvals[action];
    const name = actionLabel(action, view.mode.environment);
    if (approval?.usable && !ready?.submit)
      return {
        tone: "go",
        title: isProviderWrite(action)
          ? "Send the approved request"
          : "Export the approved request",
        body: `Version ${draft?.version ?? "?"} of the ${inSentence(name)} is approved until its timer runs out. Sending is a separate, deliberate step.`,
        target: `#action-${action}`,
        label: "Go to the approved request",
      };
    if (draft && ready?.reviewPending && !ready.approve)
      return {
        tone: "go",
        title: `Review version ${draft.version} and decide`,
        body: "Read the message, check what it discloses, then approve or reject it.",
        target: `#action-${action}`,
        label: "Review the draft",
      };
    if (
      action === "merchant_provide_evidence" &&
      draft &&
      view.provider?.evidenceCapability?.allowed &&
      !ready?.generate &&
      (!ready?.reviewPending || draft.stale)
    )
      return {
        tone: "go",
        title: "Prepare a new evidence response",
        body: "The provider currently accepts seller evidence. Regenerate the response and review the new version before approving it.",
        target: `#action-${action}`,
        label: "Go to drafting",
        act: { kind: "draft", action, regenerate: true },
      };
  }
  // A provider case is open for this charge: the buyer follows it. The card does not offer a
  // second request for the same charge on another channel; the section's own button still can.
  if (role === "buyer" && view.provider && c.claimActive) return providerStep(view);
  // Then what can be started.
  for (const action of actions) {
    const name = actionLabel(action, view.mode.environment);
    if (!view.drafts[action] && !view.readiness[action]?.generate)
      return {
        tone: "go",
        title: `Draft the ${inSentence(name)}`,
        body: ACTION_HELP[action],
        target: `#action-${action}`,
        label: "Go to drafting",
        act: { kind: "draft", action, regenerate: false },
      };
  }
  const last = ops.at(-1);
  if (last?.status === "SUCCEEDED" && !last.providerWrite)
    return {
      tone: "blocked",
      title: "Send the exported message yourself",
      body: "The message and the evidence pack are on this computer. CancelCase did not send anything.",
      target: "#operations",
      label: "See the export",
    };
  if (view.provider) return providerStep(view);
  const first = view.availableActions[0] as ActionKind | undefined;
  const reason = first
    ? (view.readiness[first]?.generate ?? view.readiness[first]?.approve ?? null)
    : null;
  return {
    tone: "blocked",
    title: "Nothing can be done yet",
    body: reason?.message ?? "No action is available for this view right now.",
    target: first ? `#action-${first}` : "#charge",
    label: "See why",
  };
}

type StageState = "done" | "current" | "upcoming" | "attention";

export function deriveStages(view: CaseView, role: Role) {
  const anyUnknown = view.operations.some((o) => o.status === "UNKNOWN");
  const approvedOrActed =
    Object.values(view.approvals).some((a) => a && a.decision === "approved") ||
    view.operations.length > 0;
  const raw = [
    {
      label: role === "buyer" ? "Record" : "Case",
      href: "#cancellation",
      done:
        role === "buyer"
          ? view.subscription.cancellation.state === "CANCEL_CONFIRMED"
          : view.provider !== null,
    },
    { label: "Check", href: "#charge", done: view.case.classification !== "NEEDS_REVIEW" },
    { label: "Review", href: "#actions", done: approvedOrActed },
    {
      label: "Approve and act",
      href: "#operations",
      done: view.operations.some((o) => o.status === "SUCCEEDED"),
    },
  ];
  const current = raw.findIndex((s) => !s.done);
  return raw.map((s, i) => ({
    ...s,
    state: (i === 3 && anyUnknown
      ? "attention"
      : s.done
        ? "done"
        : i === current
          ? "current"
          : "upcoming") as StageState,
  }));
}

/**
 * The latest request, when it failed. The card says so until something newer exists, so a step
 * offered after a failure never reads as if nothing had happened.
 */
export function lastFailedRequest(view: CaseView): ViewOperation | null {
  const latest = view.operations.reduce<ViewOperation | null>(
    (a, b) => (!a || b.createdAt > a.createdAt ? b : a),
    null,
  );
  return latest?.status === "FAILED" ? latest : null;
}

/* ------------------------------------------------------------- one-press run */

/** A run never takes more than this many acts, whatever the server answers. */
export const MAX_ACTS = 3;

/**
 * Whether a run goes on to the next step's act. Each kind is taken at most once, so a read that
 * changed nothing is not repeated, and nothing follows a draft: a draft hands over to the person.
 */
export function continues(
  act: StepAct | undefined,
  taken: readonly StepAct["kind"][],
): act is StepAct {
  if (!act) return false;
  if (taken.length >= MAX_ACTS) return false;
  if (taken.includes("draft")) return false;
  return !taken.includes(act.kind);
}

/** One line of what a run did. Every line states a result the server returned. */
export interface TrailRow {
  state: "running" | "done" | "attention" | "failed" | "waiting";
  text: string;
  detail?: string;
  /** A muted line under the detail, for context rather than a result */
  note?: string;
  href?: string;
  linkText?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What reading the payments found, from the server's own message and the view it returned. */
export function paymentRows(
  before: CaseView,
  after: CaseView,
  message: string,
  newCaseIds: readonly string[],
): TrailRow[] {
  const rows: TrailRow[] = [{ state: "done", text: "Payments read", detail: message }];
  const recorded = before.charge.eventTime === null && after.charge.eventTime !== null;
  if (recorded || before.case.classification !== after.case.classification)
    rows.push({
      state: "done",
      text: "Checked against your cancellation",
      detail: after.case.classificationText.title,
    });
  if (after.case.recoveredCents > before.case.recoveredCents)
    rows.push({
      state: "done",
      text: "Refund read back",
      detail: `${after.case.recoveredText} reported refunded by the provider`,
    });
  if (newCaseIds.length > 0)
    rows.push({
      state: "attention",
      text:
        newCaseIds.length === 1
          ? "A later payment has its own case"
          : "Later payments have their own cases",
      href: `/cases/${newCaseIds[0]}`,
      linkText: newCaseIds.length === 1 ? "Open that case" : "Open the first one",
    });
  return rows;
}

/** What drafting produced: the graph's own log line for the facts, the draft the view now holds. */
export function draftRows(log: readonly string[], view: CaseView, action: ActionKind): TrailRow[] {
  const rows: TrailRow[] = [];
  const gathered = [...log]
    .reverse()
    .find((line) => line.startsWith("gathered "))
    ?.match(/^gathered (\d+) facts and (\d+) sources/);
  rows.push({
    state: "done",
    text: "Facts gathered",
    detail: gathered
      ? `${plural(Number(gathered[1]), "fact")}, ${plural(Number(gathered[2]), "source")}`
      : undefined,
  });
  const draft = view.drafts[action];
  if (!draft) {
    rows.push({ state: "failed", text: "No draft was produced" });
    return rows;
  }
  rows.push({
    state: "done",
    text: `Draft v${draft.version} written`,
    detail: draft.originLabel,
    ...(draft.origin === "fixture_template" ? { note: TEMPLATE_DRAFT_NOTE } : {}),
  });
  if (draft.validation.ok) {
    rows.push({ state: "done", text: "Validation passed" });
    rows.push({
      state: "waiting",
      text: "Your approval is next",
      detail: "Nothing was approved or sent.",
    });
  } else {
    const blocking = draft.validation.issues.filter((i) => i.blocking).length;
    rows.push({
      state: "attention",
      text: "Validation blocked the draft",
      detail: `${plural(blocking, "finding")} to resolve before it can be approved`,
    });
    rows.push({
      state: "waiting",
      text: "Your edits are next",
      detail: "Nothing was approved or sent.",
    });
  }
  return rows;
}

/** What reading the provider case back found. */
export function providerRows(view: CaseView, error: string | null): TrailRow[] {
  if (error)
    return [{ state: "failed", text: "The provider case could not be read", detail: error }];
  const status = (view.provider?.status ?? "unknown").replace(/_/g, " ").toLowerCase();
  return [{ state: "done", text: "Provider case read", detail: `Last observed as ${status}` }];
}

/** The words on the button of a step the app can take, and what pressing it does. */
export function actWords(
  act: StepAct,
  role: Role,
): { label: string; short: string; hint: string; busy: string; failed: string } {
  if (act.kind === "draft")
    return {
      label: role === "buyer" ? "Prepare my case" : "Prepare the response",
      short: "Prepare",
      hint:
        role === "buyer"
          ? "Gathers the facts, drafts the request with its sources, then stops for your approval."
          : "Gathers your records, drafts the response with its sources, then stops for your approval.",
      busy: "Gathering facts and drafting",
      failed: "The draft could not be prepared",
    };
  if (act.kind === "read_payments")
    return {
      label: "Read the payments",
      short: "Read",
      hint: "Reads the payments from PayPal once. If one came after your cancellation, the request is drafted and waits for your approval.",
      busy: "Reading the subscription's payments from PayPal",
      failed: "The payments could not be read",
    };
  return {
    label: "Read the case again",
    short: "Read",
    hint:
      role === "merchant"
        ? "Reads the provider's current state. If it asks for your evidence, the response is drafted and waits for your approval."
        : "Reads the provider's current state.",
    busy: "Refreshing provider state",
    failed: "The provider case could not be read",
  };
}

function TrailMark({ state }: { state: TrailRow["state"] }) {
  if (state === "running")
    return (
      <span className="run-mark" aria-hidden="true">
        <span className="run-dots">
          <i />
          <i />
          <i />
        </span>
      </span>
    );
  return (
    <span className="run-mark" aria-hidden="true">
      {state === "done" && (
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path
            d="M2.2 6.4 4.9 9 9.8 3.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {state === "failed" && (
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path
            d="M3 3l6 6M9 3l-6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      )}
      {state === "attention" && <span className="run-bang">!</span>}
    </span>
  );
}

export function NextStep() {
  const { view, role, run, busy, setCancellationOpen, fold } = useWorkbench();
  const step = deriveNextStep(view, role);
  const stages = deriveStages(view, role);
  const words = step.act ? actWords(step.act, role) : null;
  const stepKey = `${step.tone}|${step.title}`;
  const failedRequest = lastFailedRequest(view);

  const goTo = (target: string, opensCancellation = false) => {
    if (opensCancellation) setCancellationOpen(true);
    // The step's section may be folded: unfold it, then go there once it is laid out.
    fold.open(target.replace(/^#/, ""));
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(target);
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      const focusable = el?.querySelector<HTMLElement>(
        opensCancellation ? "form input, form select" : "h2 button, h2",
      );
      if (focusable) {
        if (!focusable.hasAttribute("tabindex") && focusable.tagName === "H2")
          focusable.setAttribute("tabindex", "-1");
        focusable.focus({ preventScroll: true });
      }
    }, 60);
  };
  const go = () => goTo(step.target, step.opensCancellation);

  // On a narrow screen the step follows the reader: once the card has scrolled away, a bar at
  // the bottom keeps the one next action within reach. It repeats the card; it adds no action.
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardInView, setCardInView] = useState(true);
  const inView = useRef(true);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const el = cardRef.current;
    if (!el || typeof IntersectionObserver === "undefined")
      return () => {
        alive.current = false;
      };
    const observer = new IntersectionObserver(
      ([entry]) => {
        inView.current = entry!.isIntersecting;
        setCardInView(entry!.isIntersecting);
      },
      { threshold: 0.15 },
    );
    observer.observe(el);
    return () => {
      alive.current = false;
      observer.disconnect();
    };
  }, []);

  // What the last one-press run did. It belongs to the step the run stopped at and to this view
  // of the case: once the step moves on, or the role changes, it is gone.
  const [trail, setTrail] = useState<(TrailRow & { id: number; delay: number })[]>([]);
  const [trailFor, setTrailFor] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [trailRole, setTrailRole] = useState(role);
  if (trailRole !== role) {
    setTrailRole(role);
    setTrail([]);
    setTrailFor(null);
  }
  const rowId = useRef(0);

  /**
   * Takes the step, then the next one if the app can take that too, and stops where the person is
   * needed. It only calls what the buttons in the sections call: a read or a draft. It cannot
   * approve or send, and it never repeats a read.
   */
  const prepare = async () => {
    if (!step.act || running || busy !== null) return;
    setRunning(true);
    setTrailFor(null);
    const rows: (TrailRow & { id: number; delay: number })[] = [];
    const show = () => setTrail(rows.slice());
    const add = (batch: TrailRow[]) => {
      batch.forEach((row, i) => rows.push({ ...row, id: ++rowId.current, delay: i * 130 }));
      show();
    };
    const taken: StepAct["kind"][] = [];
    let current = view;
    let act: StepAct | undefined = step.act;
    let failed = false;
    while (continues(act, taken)) {
      const doing = act;
      const w = actWords(doing, role);
      const before = current;
      const out: { view: CaseView | null; rows: TrailRow[] } = { view: null, rows: [] };
      add([{ state: "running", text: w.busy }]);
      const ok = await run(
        w.busy,
        async () => {
          const id = before.case.id;
          let after: CaseView;
          if (doing.kind === "read_payments") {
            const r = await apiPost<{
              result: { newCaseIds: string[] };
              view: CaseView;
              message: string;
            }>(`/api/cases/${id}/subscription/payments`, {});
            out.rows = paymentRows(before, r.view, r.message, r.result.newCaseIds);
            after = r.view;
          } else if (doing.kind === "draft") {
            const r = await apiPost<{ view: CaseView; thread: { log: string[] } }>(
              `/api/cases/${id}/threads/${doing.action}/start`,
              { regenerate: doing.regenerate },
            );
            out.rows = draftRows(r.thread.log, r.view, doing.action);
            after = r.view;
          } else {
            const r = await apiPost<{ view: CaseView; error: string | null }>(
              `/api/cases/${id}/provider/refresh`,
              {},
            );
            out.rows = providerRows(r.view, r.error);
            after = r.view;
          }
          out.view = after;
          // The trail carries the outcome; the view alone goes back, so no second notice appears.
          return { view: after };
        },
        undefined,
        "next-step",
      );
      rows.pop();
      if (!ok || !out.view) {
        add([{ state: "failed", text: w.failed }]);
        failed = true;
        break;
      }
      add(out.rows);
      taken.push(doing.kind);
      current = out.view;
      act = deriveNextStep(current, role).act;
    }
    const final = deriveNextStep(current, role);
    setTrailFor(`${final.tone}|${final.title}`);
    setRunning(false);
    if (failed || (final.target === step.target && !taken.includes("draft"))) return;
    // Leave a moment to read what was done before the page moves to where the person is needed.
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!reduce && inView.current) await new Promise((r) => window.setTimeout(r, 900));
    if (alive.current) goTo(final.target);
  };

  const showTrail = trail.length > 0 && (running || trailFor === stepKey);
  const acting = Boolean(step.act) && (running || busy !== null);
  return (
    <aside aria-labelledby="next-step-title" className="flex flex-col gap-4">
      <div className="next-step" data-tone={step.tone} ref={cardRef}>
        <p className="muted text-sm font-semibold">Next step</p>
        {failedRequest && (
          <p className="next-step-flag">
            <strong>
              {failedRequest.providerWrite
                ? "The last request was not accepted."
                : "The last export did not complete."}
            </strong>{" "}
            Nothing was applied.{" "}
            <button type="button" className="run-link" onClick={() => goTo("#operations")}>
              See what happened
            </button>
          </p>
        )}
        {/* Keyed by the step, so a new step arrives instead of the words changing in place. */}
        <div className="rise" key={stepKey}>
          <h2
            id="next-step-title"
            className="mt-1 text-xl font-extrabold leading-snug tracking-tight"
          >
            {step.title}
          </h2>
          <p className="muted mt-2 text-sm">{step.body}</p>
          <button
            type="button"
            className={`btn mt-4 w-full ${step.tone === "go" ? "btn-primary" : "btn-secondary"}`}
            onClick={words ? () => void prepare() : go}
            disabled={acting}
            aria-describedby={words ? "next-step-hint" : undefined}
          >
            {words ? words.label : step.label}
          </button>
          {words && (
            <p id="next-step-hint" className="muted mt-2 text-xs">
              {words.hint}
            </p>
          )}
        </div>
        {showTrail && (
          <ol className="run-trail" aria-label="What was done" aria-live="polite">
            {trail.map((row) => (
              <li
                key={row.id}
                className="run-row rise"
                data-state={row.state}
                style={{ animationDelay: `${row.delay}ms` }}
              >
                <TrailMark state={row.state} />
                <span className="min-w-0">
                  <span className="run-text">{row.text}</span>
                  {row.detail && <span className="run-detail">{row.detail}</span>}
                  {row.note && <span className="run-note">{row.note}</span>}
                  {row.href && (
                    <Link className="run-link" href={row.href}>
                      {row.linkText}
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
        <LocalStatus scope="next-step" />
      </div>
      <nav aria-label="Case stages">
        <ol className="stages">
          {stages.map((s) => (
            <li key={s.label} className="contents">
              <a
                href={s.href}
                className="stage"
                data-state={s.state}
                aria-current={s.state === "current" ? "step" : undefined}
                onClick={() => {
                  // A stage link lands on an unfolded section, never on a closed row.
                  if (s.href === "#actions")
                    for (const a of view.availableActions) fold.open(`action-${a}`);
                  else fold.open(s.href.slice(1));
                }}
              >
                <span>
                  {s.label}
                  <span className="sr-only">
                    {s.state === "done"
                      ? " (done)"
                      : s.state === "current"
                        ? " (current)"
                        : s.state === "attention"
                          ? " (needs attention)"
                          : ""}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-ink-muted">
          Stages show where the case is. Any stage can be revisited.
        </p>
      </nav>
      <div
        className="step-bar"
        data-tone={step.tone}
        data-shown={cardInView ? "false" : "true"}
        inert={cardInView}
        aria-hidden={cardInView}
      >
        <p className="min-w-0">
          <span className="step-bar-kicker">Next step</span>
          <span className="step-bar-title">{step.title}</span>
        </p>
        <button
          type="button"
          className={`btn ${step.tone === "go" ? "btn-primary" : "btn-secondary"}`}
          onClick={words ? () => void prepare() : go}
          disabled={acting}
        >
          {words ? words.short : step.tone === "blocked" ? "See" : "Go"}
          <span className="sr-only">: {words ? words.label : step.label}</span>
        </button>
      </div>
    </aside>
  );
}
