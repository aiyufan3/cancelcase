"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CaseView, ViewApproval, ViewDraft, ViewOperation } from "@/server/services/case-view";
import { apiPost } from "@/lib/client-api";
import { Notice, Pill, StatePill, formatInstant } from "../ui";
import { recoveryHint } from "./CaseOverview";
import {
  ACTION_HELP,
  FoldCard,
  LocalStatus,
  Labelled,
  TEMPLATE_DRAFT_NOTE,
  actionEffect,
  actionLabel,
  isProviderWrite,
  providerReadSinceSent,
  sentNote,
  sentVersion,
  useWorkbench,
  type ActionKind,
} from "./shared";

type Simulate = "" | "timeout" | "unsupported";

/**
 * One outward action: the draft as a readable, directly editable message, what it discloses,
 * and an approval sheet. Approval is always the person's own press and is bound to the version
 * on screen; it can be used at once (one press approves and sends) or within its window.
 */
export function DraftReview({
  action,
  simulate,
  setSimulate,
}: {
  action: ActionKind;
  simulate: Simulate;
  setSimulate: (v: Simulate) => void;
}) {
  const { view, run, setDirty } = useWorkbench();
  const draft = view.drafts[action];
  const [edits, setEdits] = useState<Record<string, string>>({});
  const caseId = view.case.id;
  const scope = `action-${action}`;
  const readiness = view.readiness[action];
  const generateBlocked = readiness?.generate?.message ?? null;
  const dirty = Object.keys(edits).some(
    (id) => edits[id] !== draft?.claims.find((c) => c.id === id)?.text,
  );
  const providerRead = draft ? providerReadSinceSent(view, action, draft.id) : null;

  const start = () =>
    run(
      "Gathering facts and drafting",
      async () => {
        const r = await apiPost<{ view: CaseView; thread: { regenerated: boolean } }>(
          `/api/cases/${caseId}/threads/${action}/start`,
          { regenerate: Boolean(draft) },
        );
        // Only report a new version when the server actually produced one.
        return {
          view: r.view,
          message: r.thread.regenerated
            ? "New draft version ready for review. Every statement of fact cites its sources; validation ran on the server."
            : "No new version was needed; review the current draft.",
        };
      },
      undefined,
      scope,
    );

  const saveEdits = () =>
    run(
      "Saving edits and re-validating",
      () =>
        apiPost<{ view: CaseView }>(`/api/cases/${caseId}/drafts/${action}/edit`, {
          claims: Object.entries(edits).map(([id, text]) => ({ id, text })),
        }),
      "Edits saved as a new draft version. Any earlier approval is void.",
      scope,
    ).then((ok) => {
      if (!ok) return;
      setEdits({});
      setDirty(action, false);
    });

  const discardEdits = () => {
    setEdits({});
    setDirty(action, false);
  };

  const edit = (id: string, text: string) => {
    const next = { ...edits, [id]: text };
    setEdits(next);
    setDirty(
      action,
      Object.keys(next).some((k) => next[k] !== draft?.claims.find((c) => c.id === k)?.text),
    );
  };

  return (
    <FoldCard
      id={`action-${action}`}
      summary={
        draft
          ? `Draft v${draft.version}, ${draft.validation.ok ? "validation passed" : "blocked by validation"}${view.approvals[action]?.usable ? ", approved" : ""}.`
          : "No draft yet."
      }
      title={actionLabel(action, view.mode.environment)}
      subtitle={ACTION_HELP[action]}
      actions={
        <button
          type="button"
          className={`btn ${draft ? "btn-secondary" : "btn-primary"}`}
          onClick={start}
          disabled={Boolean(generateBlocked)}
          aria-describedby={generateBlocked ? `generate-reason-${action}` : undefined}
        >
          {draft ? "Regenerate draft" : "Generate draft"}
        </button>
      }
    >
      {generateBlocked && (
        <div id={`generate-reason-${action}`}>
          <Notice tone="review">{generateBlocked}</Notice>
        </div>
      )}
      <LocalStatus scope={scope} />
      {draft && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Pill
              tone={
                draft.origin === "live_model" || draft.origin === "repaired_model"
                  ? "info"
                  : "neutral"
              }
            >
              {draft.originLabel}
            </Pill>
            <Pill tone="neutral">v{draft.version}</Pill>
            <Pill tone={draft.validation.ok ? "accent" : "block"}>
              {draft.validation.ok ? "validation passed" : "blocked by validation"}
            </Pill>
            {sentVersion(view, action, draft.id) ? (
              <>
                <Pill tone="accent">{isProviderWrite(action) ? "sent" : "exported"}</Pill>
                {draft.stale && (
                  <Pill tone="neutral">
                    {!isProviderWrite(action)
                      ? "facts changed since export"
                      : providerRead
                        ? "New PayPal activity since you sent this"
                        : "Case details changed since you sent this"}
                  </Pill>
                )}
              </>
            ) : (
              draft.stale && <Pill tone="review">facts changed since drafting</Pill>
            )}
          </div>
          {draft.stale && providerRead && (
            <p className="mt-1.5 text-xs text-ink-muted">
              {providerRead.simulated ? "The simulated PayPal case now shows" : "PayPal now shows"}:{" "}
              {recoveryHint(view)} (read {formatInstant(providerRead.readAt)}). What you sent is
              unchanged; check the PayPal case below before you reply.
            </p>
          )}
          {draft.origin === "fixture_template" && (
            <p className="mt-1.5 text-xs text-ink-muted">{TEMPLATE_DRAFT_NOTE}</p>
          )}

          <article
            key={`letter-${draft.id}`}
            className="letter rise mt-3 p-4 sm:p-6"
            aria-label={`Draft version ${draft.version}`}
          >
            <p className="text-sm text-ink-muted">To {draft.recipientLabel}</p>
            <p className="mt-1 font-bold leading-snug">Subject: {draft.subject}</p>
            <ol className="mt-4 space-y-4">
              {draft.claims.map((cl, index) => {
                const value = edits[cl.id] ?? cl.text;
                const changed = edits[cl.id] !== undefined && edits[cl.id] !== cl.text;
                const issues = draft.validation.issues.filter((i) => i.claimId === cl.id);
                return (
                  <li
                    key={cl.id}
                    className="rise letter-claim"
                    data-issue={
                      issues.some((i) => i.blocking) ? "block" : issues.length ? "note" : undefined
                    }
                    style={{ animationDelay: `${120 + index * 70}ms` }}
                  >
                    <textarea
                      className="letter-paragraph"
                      rows={3}
                      aria-label={`Claim ${cl.id} text`}
                      data-dirty={changed ? "true" : "false"}
                      value={value}
                      onChange={(e) => edit(cl.id, e.target.value)}
                    />
                    <Citations claimKind={cl.kind} sourceIds={cl.sourceIds} />
                    {issues.map((i, idx) => (
                      <p
                        key={idx}
                        className={`mt-1 text-sm ${i.blocking ? "text-block" : "text-ink-muted"}`}
                      >
                        {i.blocking ? "Blocks approval: " : ""}
                        {i.message} <span className="mono opacity-70">{i.code}</span>
                      </p>
                    ))}
                  </li>
                );
              })}
            </ol>
            {draft.referenceLine && (
              <p className="mt-4 text-sm leading-relaxed">
                {draft.referenceLine}
                <span className="mt-1 block text-xs text-ink-muted">
                  Added by CancelCase from the cited payment record; it is not part of the edited
                  text.
                </span>
              </p>
            )}
          </article>

          {dirty && (
            <div className="mt-3 flex flex-wrap items-center gap-2" role="status">
              <span className="pill pill-review">Unsaved changes</span>
              <button type="button" className="btn btn-primary" onClick={saveEdits}>
                Save edits (re-validate)
              </button>
              <button type="button" className="btn btn-quiet" onClick={discardEdits}>
                Discard changes
              </button>
            </div>
          )}

          {/* Findings about one paragraph sit under it; what concerns the whole draft is here. */}
          {draft.validation.issues.some(
            (i) => !i.claimId || !draft.claims.some((c) => c.id === i.claimId),
          ) && (
            <ul className="mt-3 space-y-1 text-sm">
              {draft.validation.issues
                .filter((i) => !i.claimId || !draft.claims.some((c) => c.id === i.claimId))
                .map((i, idx) => (
                  <li key={idx} className={i.blocking ? "text-block" : "text-ink-muted"}>
                    {i.message} <span className="mono opacity-70">{i.code}</span>
                  </li>
                ))}
            </ul>
          )}

          <DisclosureControl key={draft.id} view={view} action={action} draft={draft} />

          <details className="mt-4">
            <summary>
              Exact text that will be {isProviderWrite(action) ? "sent" : "exported"}
            </summary>
            <pre className="mt-2 whitespace-pre-wrap rounded-xl border border-line bg-white p-4 text-sm leading-relaxed">
              {draft.renderedText}
            </pre>
          </details>

          <ApprovalSheet
            action={action}
            draft={draft}
            approval={view.approvals[action] ?? null}
            dirty={dirty}
            simulate={simulate}
            setSimulate={setSimulate}
          />
        </div>
      )}
    </FoldCard>
  );
}

function Citations({ claimKind, sourceIds }: { claimKind: string; sourceIds: string[] }) {
  const { view, focusEvidence, setPeekEvidence } = useWorkbench();
  if (sourceIds.length === 0)
    return claimKind === "fact" ? (
      <p className="mt-1 text-xs font-semibold text-block">
        No source: a statement of fact needs one.
      </p>
    ) : (
      <p className="mt-1 text-xs text-ink-muted">
        {claimKind === "request"
          ? "No source: this paragraph is a request statement."
          : claimKind === "unknown"
            ? "No source: this paragraph states what is not known."
            : "No source: this paragraph is a context statement."}
      </p>
    );
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
      <span>sources:</span>
      {sourceIds.map((id) => {
        const src = view.sources.find((s) => s.id === id);
        const isDocument = view.evidence.some((e) => e.id === id);
        const label = src?.label ?? id;
        return isDocument ? (
          <button
            key={id}
            type="button"
            className="pill pill-neutral source-chip min-h-[28px] cursor-pointer underline decoration-dotted underline-offset-2 hover:bg-white"
            onClick={() => focusEvidence(id)}
            onPointerEnter={() => setPeekEvidence(id)}
            onPointerLeave={() => setPeekEvidence(null)}
            onFocus={() => setPeekEvidence(id)}
            onBlur={() => setPeekEvidence(null)}
            title="Show this document"
          >
            {label}
          </button>
        ) : (
          <span key={id} className="pill pill-neutral" title="Recorded observation">
            {label}
          </span>
        );
      })}
    </p>
  );
}

function ApprovalSheet({
  action,
  draft,
  approval,
  dirty,
  simulate,
  setSimulate,
}: {
  action: ActionKind;
  draft: ViewDraft;
  approval: ViewApproval | null;
  dirty: boolean;
  simulate: Simulate;
  setSimulate: (v: Simulate) => void;
}) {
  const { view, run, busy, fold } = useWorkbench();
  const [rejectReason, setRejectReason] = useState("");
  const caseId = view.case.id;
  const scope = `approval-${action}`;
  const readiness = view.readiness[action];
  const providerWrite = isProviderWrite(action);
  const inFlight = view.case.roleState === "EXECUTING" || view.case.roleState === "UNKNOWN";
  const approveReason = dirty
    ? "Save your edits first: approval applies to the saved version you can see."
    : (sentNote(view, action, draft) ?? readiness?.approve?.message ?? null);
  const submitReason = dirty
    ? "Save and approve the edited version before anything is sent."
    : (readiness?.submit?.message ?? null);
  const usable = Boolean(approval?.usable);
  // There is a version to decide on: a review is pending, or edits are waiting to be saved.
  const deciding = Boolean(readiness?.reviewPending) || dirty;

  // The approval mark lands only when a new server-saved approval appears, not on page load.
  const stampRef = useRef<HTMLParagraphElement>(null);
  const seenApproval = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    const id = usable ? (approval?.id ?? null) : null;
    if (seenApproval.current !== undefined && id && id !== seenApproval.current)
      stampRef.current?.classList.add("stamp-in");
    seenApproval.current = id;
  }, [usable, approval?.id]);

  const approve = () =>
    run(
      "Recording approval",
      () =>
        apiPost<{ view: CaseView }>(`/api/cases/${caseId}/approvals`, {
          action,
          draftId: draft.id,
          expectedContentHash: draft.contentHash,
          decision: "approved",
        }),
      "Approved for 15 minutes, bound to this exact version, its attachments and the current facts. Sending is the next, separate step.",
      scope,
    );
  const reject = () =>
    run(
      "Recording rejection",
      async () => {
        const r = await apiPost<{ view: CaseView }>(`/api/cases/${caseId}/approvals`, {
          action,
          draftId: draft.id,
          expectedContentHash: draft.contentHash,
          decision: "rejected",
          reason: rejectReason || "rejected",
        });
        await apiPost(`/api/cases/${caseId}/threads/${action}/resume`, {
          kind: "reject",
          reason: rejectReason || "rejected",
        }).catch(() => undefined);
        return r;
      },
      "Rejected. Nothing will be sent from this version.",
      scope,
    );
  // The fixture test control applies to one request. It is shared by every action on the page,
  // so leaving it set would also make the next request, for example the seller's, time out.
  const simulationUsed = () => {
    if (simulate) setSimulate("");
  };
  const submit = () =>
    run(
      providerWrite ? "Re-reading provider state and submitting" : "Exporting",
      () =>
        apiPost<{ view: CaseView }>(`/api/cases/${caseId}/threads/${action}/resume`, {
          kind: "approve",
          approvalId: approval!.id,
          simulate: simulate || null,
        }),
      providerWrite
        ? "Submission attempted. See the result and the provider read-back below."
        : "Exported locally. Nothing was sent; send the message yourself.",
      scope,
    ).finally(simulationUsed);

  // One press for both. The approval is recorded for exactly this version, then that approval is
  // used once: the same two server calls the separate buttons make, in the same order. If the
  // approved version cannot be sent right now, it stops after the approval and the sheet says why.
  const sendingBoth = useRef(false);
  const approveAndSend = async () => {
    if (sendingBoth.current) return;
    sendingBoth.current = true;
    try {
      const got: { approvalId: string | null; blocked: boolean } = {
        approvalId: null,
        blocked: false,
      };
      const approved = await run(
        "Recording approval",
        async () => {
          const r = await apiPost<{ view: CaseView }>(`/api/cases/${caseId}/approvals`, {
            action,
            draftId: draft.id,
            expectedContentHash: draft.contentHash,
            decision: "approved",
          });
          const recorded = r.view.approvals[action];
          got.approvalId = recorded?.usable ? recorded.id : null;
          got.blocked = Boolean(r.view.readiness[action]?.submit);
          return r;
        },
        "Approved for 15 minutes, bound to this exact version, its attachments and the current facts.",
        scope,
      );
      if (!approved || !got.approvalId || got.blocked) return;
      await run(
        providerWrite ? "Re-reading provider state and submitting" : "Exporting",
        () =>
          apiPost<{ view: CaseView }>(`/api/cases/${caseId}/threads/${action}/resume`, {
            kind: "approve",
            approvalId: got.approvalId,
            simulate: simulate || null,
          }),
        providerWrite
          ? "Submission attempted. See the result and the provider read-back below."
          : "Exported locally. Nothing was sent; send the message yourself.",
        scope,
      ).finally(simulationUsed);
    } finally {
      sendingBoth.current = false;
    }
  };

  // The latest request made from this draft's action, so the sheet also shows how it ended.
  const lastRequest = view.operations
    .filter((o) => o.action === action)
    .reduce<ViewOperation | null>((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
  const seeResult = () => {
    fold.open("operations");
    window.setTimeout(() => {
      const el = document.getElementById(lastRequest ? `op-${lastRequest.id}` : "operations");
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    }, 60);
  };

  const attachments = draft.attachmentEvidenceIds.map(
    (id) => view.evidence.find((e) => e.id === id)?.label ?? id,
  );
  const disclosed = draft.privateSourceIdsIncluded.map(
    (id) => view.evidence.find((e) => e.id === id)?.label ?? id,
  );

  return (
    <section
      className="sheet mt-5 p-4 sm:p-5"
      aria-labelledby={`approval-title-${action}`}
      style={{ background: "#fff" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={`approval-title-${action}`} className="text-lg font-extrabold tracking-tight">
          Approval
        </h3>
        {approval && (
          <span className="flex flex-wrap items-center gap-1.5">
            <StatePill state={approval.decision.toUpperCase()} />
            {approval.revokedReason && <Pill tone="block">revoked: {approval.revokedReason}</Pill>}
            {approval.expired && approval.decision === "approved" && (
              <Pill tone="review">expired</Pill>
            )}
            {approval.consumedByOperationId && <Pill tone="neutral">used</Pill>}
          </span>
        )}
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <Labelled label="Recipient">{draft.recipientLabel}</Labelled>
        <Labelled label="Environment">{view.mode.label}</Labelled>
        {action !== "merchant_provide_evidence" && (
          <Labelled label="Requested amount">
            {view.case.requestedText ?? "Not computable yet"}
          </Labelled>
        )}
        <Labelled label="Version">
          v{draft.version}, {draft.originLabel.toLowerCase()}
        </Labelled>
        <Labelled label="Attachments">
          {attachments.length > 0 ? attachments.join(", ") : "None"}
        </Labelled>
        {action === "merchant_provide_evidence" && view.provider && (
          <Labelled label="Evidence type sent">{view.provider.evidenceTypeToSend}</Labelled>
        )}
        <Labelled label="Private documents disclosed">
          {disclosed.length > 0 ? disclosed.join(", ") : "None"}
        </Labelled>
        <div className="sm:col-span-2">
          <Labelled label="What sending does">
            {actionEffect(action, view.mode.environment)}
          </Labelled>
        </div>
      </dl>

      {usable && approval ? (
        <>
          {/* Approved: the mark, how long it holds, and the one thing left to press. */}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <p ref={stampRef} className="stamp" role="status">
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d="M4 10.5 8.2 14.5 16 5.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Approved: version {draft.version}
            </p>
            <Countdown
              decidedAt={approval.decidedAt}
              expiresAt={approval.expiresAt}
              serverTime={view.serverTime}
            />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={submit}
              disabled={Boolean(submitReason)}
              aria-describedby={submitReason ? `submit-reason-${action}` : undefined}
            >
              {providerWrite ? "Submit approved request" : "Export approved request"}
            </button>
          </div>
          {submitReason && (
            <p id={`submit-reason-${action}`} className="mt-2 text-sm text-ink-soft">
              {submitReason}
            </p>
          )}
        </>
      ) : deciding ? (
        <>
          {/* A version to decide on: one press for both, or the approval alone for later. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void approveAndSend()}
              disabled={Boolean(approveReason) || busy !== null}
              aria-describedby={approveReason ? `approve-reason-${action}` : `both-help-${action}`}
            >
              {providerWrite ? "Approve and submit" : "Approve and export"}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={approve}
              disabled={Boolean(approveReason)}
              aria-describedby={approveReason ? `approve-reason-${action}` : undefined}
            >
              Approve this draft
            </button>
          </div>
          {approveReason ? (
            <p id={`approve-reason-${action}`} className="mt-2 text-sm text-ink-soft">
              {approveReason}
            </p>
          ) : (
            <p id={`both-help-${action}`} className="mt-2 text-xs text-ink-muted">
              One press records your approval of exactly this version and uses it once. To decide
              now and {providerWrite ? "submit" : "export"} within 15 minutes, approve the draft
              alone.
            </p>
          )}
        </>
      ) : null}

      {lastRequest && (
        <p className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-ink-muted">Last request from here</span>
          <StatePill state={lastRequest.status} />
          <button type="button" className="link" onClick={seeResult}>
            See what happened
          </button>
        </p>
      )}
      {/* Nothing to decide: say why, without controls that cannot be used. */}
      {!usable && !deciding && approveReason && (
        <p id={`approve-reason-${action}`} className="mt-2 text-sm text-ink-soft">
          {approveReason}
        </p>
      )}

      {deciding && (
        <details className="reject-disclosure mt-3">
          <summary>Reject…</summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor={`reject-reason-${action}`}>
              Rejection reason
            </label>
            <input
              id={`reject-reason-${action}`}
              className="field max-w-[16rem] flex-1"
              placeholder="Reason for rejecting"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-danger"
              onClick={reject}
              disabled={inFlight || !readiness?.reviewPending || dirty}
            >
              Reject
            </button>
          </div>
        </details>
      )}

      {view.mode.environment === "fixture" && providerWrite && (
        <label className="mt-4 flex flex-wrap items-center gap-2 border-t-2 border-dashed border-line pt-3 text-xs text-ink-muted">
          <span className="font-semibold">Fixture test control</span>
          <select
            className="field max-w-[16rem]"
            value={simulate}
            onChange={(e) => setSimulate(e.target.value as Simulate)}
            aria-label="Fixture simulation switch"
          >
            <option value="">no simulation</option>
            <option value="timeout">simulate ambiguous timeout</option>
            <option value="unsupported">simulate unsupported capability</option>
          </select>
          <span>Applies to the next request only.</span>
        </label>
      )}
      <LocalStatus scope={scope} />
    </section>
  );
}

const RING = 2 * Math.PI * 9;

function Countdown({
  decidedAt,
  expiresAt,
  serverTime,
}: {
  decidedAt: string | null;
  expiresAt: string;
  serverTime: string;
}) {
  // Remaining time is derived from the server clock at render time plus elapsed browser time,
  // so a skewed browser clock cannot show a wrong countdown.
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const t = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(t);
  }, [serverTime]);
  const remaining = Math.max(
    0,
    new Date(expiresAt).getTime() - (new Date(serverTime).getTime() + elapsedMs),
  );
  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  // The ring shows the share of the approval window that is left; the words stay exact.
  const windowMs = decidedAt ? new Date(expiresAt).getTime() - new Date(decidedAt).getTime() : 0;
  const left = windowMs > 0 ? Math.min(1, remaining / windowMs) : 0;
  return (
    <span className="countdown">
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="countdown-track" cx="12" cy="12" r="9" />
        <circle
          className="countdown-arc"
          cx="12"
          cy="12"
          r="9"
          transform="rotate(-90 12 12)"
          strokeDasharray={RING}
          strokeDashoffset={RING * (1 - left)}
        />
      </svg>
      <span className="mono text-ink-soft" aria-live="off">
        valid for {m}:{String(s).padStart(2, "0")}
      </span>
    </span>
  );
}

function DisclosureControl({
  view,
  action,
  draft,
}: {
  view: CaseView;
  action: ActionKind;
  draft: ViewDraft;
}) {
  const { run } = useWorkbench();
  const attachable = action !== "buyer_create_dispute";
  const [attachments, setAttachments] = useState<string[]>(draft.attachmentEvidenceIds);
  const [included, setIncluded] = useState<string[]>(draft.privateSourceIdsIncluded);
  const dirty =
    attachments.slice().sort().join(",") !== draft.attachmentEvidenceIds.slice().sort().join(",") ||
    included.slice().sort().join(",") !== draft.privateSourceIdsIncluded.slice().sort().join(",");
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  const save = () =>
    run(
      "Saving disclosure as a new version",
      () =>
        apiPost<{ view: CaseView }>(`/api/cases/${view.case.id}/drafts/${action}/edit`, {
          claims: [],
          attachmentEvidenceIds: attachable ? attachments : [],
          privateSourceIdsIncluded: included,
        }),
      "Disclosure saved as a new draft version. Approve this version before anything is sent.",
      `action-${action}`,
    );
  const docs = view.evidence.filter((e) => e.ownerRole === view.role || e.visibility === "shared");
  return (
    <fieldset
      className="mt-5 rounded-2xl border-2 border-ink p-4"
      aria-describedby={`disclosure-help-${action}`}
    >
      <legend className="px-2 text-sm font-extrabold">What goes to {draft.recipientLabel}</legend>
      <p id={`disclosure-help-${action}`} className="text-xs text-ink-muted">
        Shared documents can be cited{attachable ? " and attached" : ""}. Private documents stay
        with you unless you include them here; including one creates a new version that needs a new
        approval. Seeing a document here does not mean it is sent.
      </p>
      <ul className="mt-3 divide-y divide-line">
        {docs.map((e) => {
          const isPrivate = e.visibility === "private";
          const disclosed = !isPrivate || included.includes(e.id);
          const attached = attachments.includes(e.id);
          return (
            <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{e.label}</span>{" "}
                <Pill tone={isPrivate ? "review" : "neutral"}>
                  {isPrivate ? "private" : "shared"}
                </Pill>{" "}
                <span className="text-xs text-ink-muted">
                  {attached ? "attached" : disclosed ? "can be cited" : "stays with you"}
                </span>
              </span>
              {isPrivate && (
                <label className="flex min-h-[44px] items-center gap-2">
                  <input
                    type="checkbox"
                    checked={included.includes(e.id)}
                    onChange={() => {
                      setIncluded((prev) => toggle(prev, e.id));
                      if (included.includes(e.id))
                        setAttachments((prev) => prev.filter((x) => x !== e.id));
                    }}
                  />
                  Disclose<span className="sr-only"> {e.label}</span>
                </label>
              )}
              {attachable && e.hasFile && (
                <label className="flex min-h-[44px] items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={!disclosed}
                    checked={attached}
                    onChange={() => setAttachments((prev) => toggle(prev, e.id))}
                  />
                  Attach<span className="sr-only"> {e.label}</span>
                </label>
              )}
            </li>
          );
        })}
      </ul>
      {dirty && (
        <button type="button" className="btn btn-primary mt-3" onClick={save}>
          Save disclosure (new version)
        </button>
      )}
    </fieldset>
  );
}
