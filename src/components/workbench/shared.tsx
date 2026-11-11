"use client";

import { createContext, useContext, useState, type ComponentProps, type ReactNode } from "react";
import type { CaseView } from "@/server/services/case-view";
import { ApiError } from "@/lib/client-api";
import { Card, Notice } from "../ui";

export type Role = "buyer" | "merchant";
export type ActionKind =
  "export_refund_request" | "buyer_create_dispute" | "merchant_provide_evidence";

export type RunResult = CaseView | { view: CaseView; message?: string } | void;

/**
 * Runs one server call for a part of the page. `scope` names the section that shows the
 * outcome, so errors appear next to the control that caused them. Resolves to true on success.
 */
export type RunFn = (
  label: string,
  fn: () => Promise<RunResult>,
  successNotice?: string,
  scope?: string,
) => Promise<boolean>;

export interface ScopedMessage {
  scope: string;
  code?: string;
  message: string;
  details?: unknown;
}

export interface WorkbenchState {
  view: CaseView;
  role: Role;
  run: RunFn;
  busy: string | null;
  error: ScopedMessage | null;
  notice: ScopedMessage | null;
  /** Draft editors report unsaved edits so a role switch never silently discards them. */
  setDirty: (action: ActionKind, dirty: boolean) => void;
  /** Bring an evidence document into view and focus it (citation inspection). */
  focusEvidence: (id: string) => void;
  focusedEvidenceId: string | null;
  /** The document a citation is currently pointing at (hover or keyboard focus); display only. */
  peekEvidenceId: string | null;
  setPeekEvidence: (id: string | null) => void;
  cancellationOpen: boolean;
  setCancellationOpen: (open: boolean) => void;
  /**
   * Which sections are unfolded. On a wide screen everything is open unless folded by hand; on a
   * narrow one, or in focus view, only the section of the current step and those opened since.
   */
  fold: {
    isOpen: (id: string) => boolean;
    toggle: (id: string) => void;
    open: (id: string) => void;
  };
}

export const WorkbenchContext = createContext<WorkbenchState | null>(null);

export function useWorkbench(): WorkbenchState {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) throw new Error("useWorkbench outside the workbench");
  return ctx;
}

/**
 * Whether a section is unfolded. A section folded by hand stays folded. Otherwise everything is
 * open on a wide screen; in the compact view (narrow screen, or the focus view) three things
 * are: the section of the current step, the section of the step just left (so its outcome stays
 * in sight), and whatever the person opened themselves.
 */
export function sectionOpen(
  state: {
    closed: ReadonlySet<string>;
    opened: ReadonlySet<string>;
    compact: boolean;
    stepTarget: string | null;
    previousTarget?: string | null;
  },
  id: string,
): boolean {
  if (state.closed.has(id)) return false;
  return (
    !state.compact ||
    state.opened.has(id) ||
    id === state.stepTarget ||
    id === (state.previousTarget ?? null)
  );
}

/** A section of the case that folds to its title and a one-line summary. */
export function FoldCard({
  id,
  summary,
  ...rest
}: Omit<ComponentProps<typeof Card>, "fold" | "id"> & { id: string; summary?: ReactNode }) {
  const { fold } = useWorkbench();
  const open = fold.isOpen(id);
  // The content animates in only when the section has just been unfolded, not on first load.
  const [wasOpen, setWasOpen] = useState(open);
  const [reveal, setReveal] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    setReveal(open);
  }
  return (
    <Card {...rest} id={id} fold={{ open, onToggle: () => fold.toggle(id), summary, reveal }} />
  );
}

export const ACTION_LABEL: Record<ActionKind, string> = {
  export_refund_request: "Refund request to the merchant",
  buyer_create_dispute: "PayPal case (Sandbox)",
  merchant_provide_evidence: "Evidence response to the reviewer",
};

export function actionLabel(action: ActionKind, environment: string): string {
  if (action === "buyer_create_dispute")
    return environment === "sandbox" ? "PayPal case (Sandbox)" : "PayPal case (simulated)";
  return ACTION_LABEL[action];
}

/**
 * Shown beside a template draft (fixture mode): what a connected model would change, and what
 * stays the same. Request and context paragraphs carry no source, so only facts are "cited".
 */
export const TEMPLATE_DRAFT_NOTE =
  "With a connected model, the AI agent writes this draft; every claim is still validated and every fact cited.";

/** A label used inside a sentence: its first letter in lower case, unless it starts with a name. */
export function inSentence(label: string): string {
  return label.startsWith("PayPal") ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

export const ACTION_HELP: Record<ActionKind, string> = {
  export_refund_request:
    "A factual refund request you send yourself. Exporting writes files on this computer; nothing is sent.",
  buyer_create_dispute:
    "A PayPal case request. The provider decides the outcome; CancelCase only submits an approved request and reads the case back.",
  merchant_provide_evidence:
    "The merchant's factual response, drafted from the merchant's own records. Sent only when the case currently accepts seller evidence.",
};

/** What pressing the final button actually does, in plain words. */
export function actionEffect(action: ActionKind, environment: string): string {
  if (action === "export_refund_request")
    return "Writes the message and the evidence pack on this computer. Nothing is sent; you send it yourself.";
  if (environment === "sandbox")
    return "Sends the request to the PayPal Sandbox API, then reads the case back.";
  return "Runs the local simulation of a PayPal case. No PayPal call is made.";
}

export function isProviderWrite(action: ActionKind): boolean {
  return action !== "export_refund_request";
}

/**
 * True when this exact draft version was approved and its one request succeeded. A send is
 * refused while the facts differ from the draft's, so any change that shows up afterwards (a
 * read-back, a later payment) happened after sending and is not part of what was sent.
 * Presentation only: readiness on the server is unchanged.
 */
export function sentVersion(view: CaseView, action: ActionKind, draftId: string): boolean {
  const approval = view.approvals[action];
  if (!approval || approval.draftId !== draftId || !approval.consumedByOperationId) return false;
  return view.operations.some(
    (o) => o.id === approval.consumedByOperationId && o.status === "SUCCEEDED",
  );
}

/**
 * For a version sent to the provider: when the provider case (PayPal, or its simulation in fixture
 * mode) was read after that request was made, when it was read. Null when nothing was read since.
 */
export function providerReadSinceSent(
  view: CaseView,
  action: ActionKind,
  draftId: string,
): { readAt: string; simulated: boolean } | null {
  if (!isProviderWrite(action) || !sentVersion(view, action, draftId)) return null;
  const opId = view.approvals[action]?.consumedByOperationId;
  const op = view.operations.find((o) => o.id === opId);
  const p = view.provider;
  if (!op || !p?.observedAt || !(Date.parse(p.observedAt) > Date.parse(op.createdAt))) return null;
  return { readAt: p.observedAt, simulated: p.provenance === "synthetic" };
}

/** What the approval sheet says about a version that was already sent, in place of a blocker. */
export function sentNote(
  view: CaseView,
  action: ActionKind,
  draft: { id: string; stale: boolean },
): string | null {
  if (!sentVersion(view, action, draft.id)) return null;
  const done = isProviderWrite(action) ? "sent" : "exported";
  return draft.stale
    ? `This version was ${done}. Facts recorded since then are not part of it; regenerate the draft only to prepare a new request.`
    : `This version was ${done}. Regenerate the draft only to prepare a new request.`;
}

export function toError(err: unknown, scope: string): ScopedMessage {
  if (err instanceof ApiError)
    return { scope, code: err.code, message: err.message, details: err.details };
  if (err instanceof Error) return { scope, code: "CLIENT", message: err.message };
  return { scope, code: "CLIENT", message: "Unexpected error" };
}

/** The outcome of the last call made from this part of the page, shown right here. */
export function LocalStatus({ scope }: { scope: string }) {
  const { error, notice } = useWorkbench();
  const err = error?.scope === scope ? error : null;
  const note = notice?.scope === scope ? notice : null;
  if (!err && !note) return null;
  // Keyed by its words, so a new outcome arrives as a new object instead of silently changing.
  return (
    <div className="rise mt-3 space-y-2" key={`${err?.message ?? ""}|${note?.message ?? ""}`}>
      {err && (
        <Notice tone="block">
          <strong>{readableCode(err.code)}.</strong> {err.message}
          {Array.isArray(err.details) && err.details.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {(err.details as unknown[]).slice(0, 6).map((d, i) => (
                <li key={i}>{typeof d === "string" ? d : JSON.stringify(d)}</li>
              ))}
            </ul>
          )}
          {err.code && <span className="mono ml-1 opacity-70">({err.code})</span>}
        </Notice>
      )}
      {note && <Notice tone="accent">{note.message}</Notice>}
    </div>
  );
}

function readableCode(code: string | undefined): string {
  if (!code) return "Something went wrong";
  const text = code.replace(/_/g, " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A case opened for a connected subscription before any payment has been read: its charge record
 * has no time, no amount and no provider reference yet. Presentation only. The page uses it to
 * say "no payment yet" where it would otherwise call nothing an unknown amount; the check and
 * its result are untouched.
 */
export function awaitingFirstPayment(view: CaseView): boolean {
  const ch = view.charge;
  return (
    ch.eventTime === null &&
    ch.amountText === null &&
    ch.providerRefs.length === 0 &&
    view.subscription.providerRefs.some((r) => r.kind === "subscription_id")
  );
}

export function formatInterval(fromIso: string | null, toIso: string | null): string | null {
  if (!fromIso || !toIso) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const ms = to - from;
  if (ms === 0) return "at the same moment as";
  // Whole units, never rounded up: 8 h 48 min is not "9 h", and 20 minutes is not "1 h".
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const span =
    days > 0
      ? `${days} day${days === 1 ? "" : "s"}${hours > 0 ? ` ${hours} h` : ""}`
      : hours > 0
        ? `${hours} h${mins > 0 ? ` ${mins} min` : ""}`
        : minutes > 0
          ? `${minutes} min`
          : "less than a minute";
  return ms > 0 ? `${span} after` : `${span} before`;
}

export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.8125rem] font-semibold text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}
