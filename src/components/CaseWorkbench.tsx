"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  CaseView,
  ViewDraft,
  ViewExportDownloads,
  ViewOperation,
} from "@/server/services/case-view";
import { apiGet, apiPost, ensureSession, switchRole } from "@/lib/client-api";
import { Wordmark } from "./Wordmark";
import {
  Fact,
  ModePill,
  Notice,
  Pill,
  ProvenancePill,
  StatePill,
  formatDay,
  formatInstant,
} from "./ui";
import { CaseOverview } from "./workbench/CaseOverview";
import { NextStep, deriveNextStep } from "./workbench/NextStep";
import { EvidenceStack } from "./workbench/EvidenceStack";
import { DraftReview } from "./workbench/DraftReview";
import {
  ACTION_LABEL,
  FoldCard,
  LocalStatus,
  WorkbenchContext,
  actionLabel,
  awaitingFirstPayment,
  sectionOpen,
  toError,
  useWorkbench,
  type ActionKind,
  type Role,
  type RunFn,
  type ScopedMessage,
  type WorkbenchState,
} from "./workbench/shared";

/** Below this width the case file folds to one line per section. */
const NARROW = "(max-width: 1023.98px)";
const subscribeNarrow = (onChange: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
};

export function CaseWorkbench({ caseId }: { caseId: string }) {
  const [view, setView] = useState<CaseView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ScopedMessage | null>(null);
  const [notice, setNotice] = useState<ScopedMessage | null>(null);
  const [simulate, setSimulate] = useState<"" | "timeout" | "unsupported">("");
  const [dirtyActions, setDirtyActions] = useState<ReadonlySet<ActionKind>>(new Set());
  const [pendingRole, setPendingRole] = useState<Role | null>(null);
  const [focusedEvidenceId, setFocusedEvidenceId] = useState<string | null>(null);
  const [peekEvidenceId, setPeekEvidence] = useState<string | null>(null);
  const [cancellationOpen, setCancellationOpen] = useState(false);
  // Folding. A narrow screen (or the focus view on a wide one) shows the section of the current
  // step and whatever has been opened since; everything else is one line. Presentation only.
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
  const [focusOnly, setFocusOnly] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const stepTarget = view ? deriveNextStep(view, view.role).target.replace(/^#/, "") : null;
  // When the step moves on, the section it has just left stays open beside the new one.
  const [seenTarget, setSeenTarget] = useState<string | null>(null);
  const [previousTarget, setPreviousTarget] = useState<string | null>(null);
  if (stepTarget && stepTarget !== seenTarget) {
    setPreviousTarget(seenTarget);
    setSeenTarget(stepTarget);
  }
  const compact = narrow || focusOnly;
  // The busy chip keeps its last words while it fades out.
  const [busyLabel, setBusyLabel] = useState("");
  if (busy && busy !== busyLabel) setBusyLabel(busy);

  const load = useCallback(async () => {
    const data = await apiGet<CaseView>(`/api/cases/${caseId}`);
    setView(data);
  }, [caseId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureSession();
        if (!cancelled) await load();
      } catch (err) {
        if (!cancelled) setLoadError(toError(err, "global").message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const run: RunFn = useCallback(
    async (label, fn, successNotice, scope = "global") => {
      setBusy(label);
      setError(null);
      setNotice(null);
      try {
        const result = await fn();
        if (result && "view" in (result as object)) setView((result as { view: CaseView }).view);
        else if (result && "case" in (result as object)) setView(result as CaseView);
        else await load();
        const serverMessage =
          result && typeof (result as { message?: unknown }).message === "string"
            ? (result as { message: string }).message
            : null;
        const message = serverMessage ?? successNotice ?? null;
        if (message) setNotice({ scope, message });
        return true;
      } catch (err) {
        setError(toError(err, scope));
        try {
          await load();
        } catch {
          /* keep the previous view */
        }
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const setDirty = useCallback((action: ActionKind, dirty: boolean) => {
    setDirtyActions((prev) => {
      if (prev.has(action) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(action);
      else next.delete(action);
      return next;
    });
  }, []);

  const fold = useMemo(() => {
    const isOpen = (id: string) =>
      sectionOpen({ closed, opened, compact, stepTarget, previousTarget }, id);
    const set = (id: string, open: boolean) => {
      setOpened((prev) => {
        const next = new Set(prev);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      });
      setClosed((prev) => {
        const next = new Set(prev);
        if (open) next.delete(id);
        else next.add(id);
        return next;
      });
    };
    return {
      isOpen,
      toggle: (id: string) => set(id, !isOpen(id)),
      // Going to a section unfolds it. A section the flow already keeps open is not pinned by
      // that, so it folds again once the case has moved two steps on.
      open: (id: string) => {
        const auto = !compact || id === stepTarget || id === previousTarget;
        if (auto)
          setClosed((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        else set(id, true);
      },
    };
  }, [closed, opened, compact, stepTarget, previousTarget]);

  const focusEvidence = useCallback(
    (id: string) => {
      setFocusedEvidenceId(id);
      fold.open("evidence");
      // The document may have been inside a folded section: wait for it to be laid out.
      requestAnimationFrame(() => {
        const el = document.getElementById(`doc-${id}`);
        el?.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
        el?.focus({ preventScroll: true });
      });
    },
    [fold],
  );

  const doSwitchRole = async (next: Role) => {
    setPendingRole(null);
    setDirtyActions(new Set());
    setFocusedEvidenceId(null);
    setCancellationOpen(false);
    setOpened(new Set());
    setClosed(new Set());
    setPreviousTarget(null);
    await run(
      `Switching to the ${next} view`,
      async () => {
        await switchRole(next);
        await load();
      },
      undefined,
      "role",
    );
  };
  const onSwitchRole = (next: Role) => {
    // Unsaved draft edits are never discarded silently.
    if (dirtyActions.size > 0) setPendingRole(next);
    else void doSwitchRole(next);
  };

  const state = useMemo<WorkbenchState | null>(
    () =>
      view
        ? {
            view,
            role: view.role,
            run,
            busy,
            error,
            notice,
            setDirty,
            focusEvidence,
            focusedEvidenceId,
            peekEvidenceId,
            setPeekEvidence,
            cancellationOpen,
            setCancellationOpen,
            fold,
          }
        : null,
    [
      view,
      run,
      busy,
      error,
      notice,
      setDirty,
      focusEvidence,
      focusedEvidenceId,
      peekEvidenceId,
      cancellationOpen,
      fold,
    ],
  );

  if (!view || !state) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-4 py-10">
        <Wordmark />
        <p className="mt-6 text-ink-muted" role="status">
          {loadError ? `Could not load the case: ${loadError}` : "Loading case…"}
        </p>
      </main>
    );
  }

  const role = view.role;
  return (
    <WorkbenchContext.Provider value={state}>
      <main id="main" className="mx-auto max-w-[1240px] px-4 pb-24 pt-5 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <Link href="/" className="rounded-lg" aria-label="CancelCase home">
            <Wordmark />
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <ModePill environment={view.mode.environment} title={view.mode.description} />
            <RoleSwitch role={role} onChange={onSwitchRole} disabled={busy !== null} />
          </div>
        </header>
        {pendingRole && (
          <div className="mt-3">
            <Notice tone="review">
              <p>
                You have unsaved edits in a draft. Switching to the {pendingRole} view would discard
                them.
              </p>
              <p className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPendingRole(null)}
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void doSwitchRole(pendingRole)}
                >
                  Discard edits and switch
                </button>
              </p>
            </Notice>
          </div>
        )}
        <LocalStatus scope="role" />

        <div className="mt-2 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
          <CaseOverview />
          <div className="lg:sticky lg:top-4 lg:mt-9">
            <NextStep />
          </div>
        </div>

        <p className="sr-only" role="status" aria-live="polite">
          {busy ? `${busy}…` : ""}
        </p>
        <div className="busy-chip" data-active={busy ? "true" : "false"} aria-hidden="true">
          <span className="busy-dots">
            <i />
            <i />
            <i />
          </span>
          <span>{busyLabel}</span>
        </div>
        <LocalStatus scope="global" />

        <div className="mt-10 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-ink-muted">
            The case file
            <span className="font-normal">
              {compact
                ? ": the section of the current step is open, the rest is one line each."
                : ": every record behind this case."}
            </span>
          </p>
          {!narrow && (
            <div
              role="radiogroup"
              aria-label="How much of the case file is unfolded"
              className="role-switch role-switch-small"
              data-pos={focusOnly ? "1" : "0"}
            >
              <button
                type="button"
                role="radio"
                aria-checked={!focusOnly}
                onClick={() => {
                  setFocusOnly(false);
                  setClosed(new Set());
                }}
              >
                Everything
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={focusOnly}
                onClick={() => {
                  setFocusOnly(true);
                  setOpened(new Set());
                  setClosed(new Set());
                  setPreviousTarget(null);
                }}
              >
                Current step
              </button>
            </div>
          )}
        </div>

        <div
          className={`mt-4 flex flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] lg:items-start lg:gap-x-10 ${compact ? "gap-3" : "gap-12"}`}
        >
          <div className={`contents lg:flex lg:flex-col ${compact ? "lg:gap-3" : "lg:gap-12"}`}>
            <CancellationSection className="order-1 lg:order-none" />
            <CheckSection className="order-2 lg:order-none" />
            <div
              id="actions"
              className={`section order-4 flex flex-col lg:order-none ${compact ? "gap-3" : "gap-12"}`}
            >
              {view.availableActions.map((action) => (
                <DraftReview
                  key={action}
                  action={action as ActionKind}
                  simulate={simulate}
                  setSimulate={setSimulate}
                />
              ))}
            </div>
            <OperationsSection className="order-5 lg:order-none" />
            <ProviderSection className="order-6 lg:order-none" />
          </div>
          <div className={`contents lg:flex lg:flex-col ${compact ? "lg:gap-3" : "lg:gap-12"}`}>
            <EvidenceStack className="order-3 lg:order-none" />
            <TimelineSection className="order-7 lg:order-none" />
            <RecordsSection className="order-8 lg:order-none" />
          </div>
        </div>
      </main>
    </WorkbenchContext.Provider>
  );
}

function RoleSwitch({
  role,
  onChange,
  disabled,
}: {
  role: Role;
  onChange: (r: Role) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <div
        role="radiogroup"
        aria-label="Demo role (local simulation)"
        className="role-switch"
        data-role={role}
      >
        {(["buyer", "merchant"] as Role[]).map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={role === r}
            disabled={disabled}
            onClick={() => role !== r && onChange(r)}
          >
            {r} view
          </button>
        ))}
      </div>
      <span className="text-[11px] text-ink-muted">
        Demo role switch: a local simulation, not authentication
      </span>
    </div>
  );
}

/** PROVIDER_ENUM to "Provider enum" for a one-line summary. */
function sentence(code: string): string {
  const text = code.replace(/_/g, " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function operationsSummary(ops: ViewOperation[]): string {
  if (ops.length === 0) return "Nothing exported or sent yet.";
  const latest = ops.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  return `${ops.length} request${ops.length === 1 ? "" : "s"}. Latest: ${sentence(latest.status)}.`;
}

/* ------------------------------------------------------------ cancellation */

function CancellationSection({ className }: { className?: string }) {
  const { view, role, run, cancellationOpen: open, setCancellationOpen: setOpen } = useWorkbench();
  const s = view.subscription;
  const canc = s.cancellation;
  const hints = view.demoHints?.confirmation ?? null;
  const [effectiveAt, setEffectiveAt] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [basis, setBasis] = useState<"user_attestation" | "merchant_confirmation_document">(
    "merchant_confirmation_document",
  );
  const [selected, setSelected] = useState<string[]>([]);
  const files = view.evidence.filter((e) => e.ownerRole === "buyer");
  const waiting = awaitingFirstPayment(view);

  const fillFromHints = () => {
    if (!hints) return;
    setEffectiveAt(hints.effectiveAt);
    setReceivedAt(hints.receivedAt);
    setBasis(hints.basis);
    setSelected(hints.evidenceIds.filter((id) => files.some((f) => f.id === id)));
  };

  const submit = () =>
    run(
      "Recording cancellation",
      () =>
        apiPost<CaseView>(`/api/cases/${view.case.id}/cancellation`, {
          type: "RECORD_CONFIRMATION",
          receivedAt: receivedAt || effectiveAt,
          effectiveAt: effectiveAt || null,
          basis,
          evidenceIds: selected,
        }),
      "Cancellation recorded. This records your facts; it does not cancel anything at the merchant or at PayPal.",
      "cancellation",
    ).then((ok) => {
      if (ok) setOpen(false);
    });

  return (
    <FoldCard
      className={className}
      id="cancellation"
      title="Cancellation record"
      summary={
        canc.state === "CANCEL_CONFIRMED" && canc.effectiveAt
          ? `Confirmed. Takes effect ${formatInstant(canc.effectiveAt)}.`
          : canc.requestedAt
            ? "Requested, not confirmed yet."
            : "Not recorded yet."
      }
      subtitle="A recorded cancellation is a fact about your records. It never claims to have cancelled the merchant's service or a payment mandate."
      actions={
        role === "buyer" ? (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            Record cancellation
          </button>
        ) : null
      }
    >
      <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        <Fact label="Subscription" value={`${s.label}${s.amountText ? `, ${s.amountText}` : ""}`} />
        <Fact label="Merchant" value={s.merchantAlias} />
        <Fact label="Cancellation state" value={<StatePill state={canc.state} />} />
        <Fact label="Basis" value={canc.basisLabel} />
        <Fact label="Requested" value={formatInstant(canc.requestedAt)} />
        <Fact label="Confirmation received" value={formatInstant(canc.confirmationReceivedAt)} />
        <Fact label="Takes effect" value={formatInstant(canc.effectiveAt)} />
        <Fact
          label="Provider mandate (separate observation)"
          value={
            canc.providerMandateStatus
              ? `${canc.providerMandateStatus}, ${formatInstant(canc.providerMandateObservedAt)}, ${
                  canc.providerMandateProvenance === "synthetic"
                    ? "simulated (fixture)"
                    : canc.providerMandateProvenance === "sandbox_api"
                      ? "read from PayPal Sandbox"
                      : "source not recorded"
                }`
              : "not observed"
          }
        />
      </dl>
      {s.billingWatch && (
        <div className="mt-3">
          <Notice tone="review">
            <strong>
              {s.billingWatch.due
                ? "A billing was planned after your cancellation."
                : "A billing is still planned after your cancellation."}
            </strong>{" "}
            Your record says the cancellation takes effect {formatInstant(canc.effectiveAt)}. The
            provider lists the payment mandate as active and{" "}
            {s.billingWatch.due ? "had a billing planned for" : "plans the next billing for"}{" "}
            {formatDay(s.billingWatch.nextBillingAt)} (
            {s.billingWatch.provenance === "synthetic"
              ? "simulated in fixture mode"
              : "read from PayPal Sandbox"}
            , {formatInstant(s.billingWatch.observedAt)}).{" "}
            {s.billingWatch.due
              ? "A plan is not a payment: read the payments to see whether it was charged."
              : waiting
                ? "Recording a cancellation here does not stop it. When the payments are read, the first one is recorded in this case and checked against your cancellation."
                : "Recording a cancellation here does not stop it. A payment after the cancellation becomes its own case when the payments are read."}
          </Notice>
        </div>
      )}
      <p className="mt-2 flex flex-wrap items-center gap-2">
        {s.paymentsReadable && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              run(
                "Reading the subscription's payments from PayPal",
                () =>
                  apiPost<{ view: CaseView; message: string }>(
                    `/api/cases/${view.case.id}/subscription/payments`,
                    {},
                  ),
                undefined,
                "cancellation",
              )
            }
          >
            Read payments from PayPal
          </button>
        )}
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() =>
            run(
              "Reading the provider subscription back",
              () =>
                apiPost<{ view: CaseView }>(`/api/cases/${view.case.id}/subscription/refresh`, {}),
              "Provider mandate observation recorded beside your cancellation facts. Neither implies the other.",
              "cancellation",
            )
          }
        >
          Refresh provider mandate
        </button>
      </p>
      {view.relatedCases.length > 0 && (
        <div className="mt-3">
          <p className="label">Other payments of this subscription</p>
          <ul className="space-y-1.5 text-sm">
            {view.relatedCases.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Link className="link" href={`/cases/${r.id}`}>
                  {r.eventTime ? formatInstant(r.eventTime) : "No payment yet"}
                  {r.amountText ? `, ${r.amountText}` : ""}
                </Link>
                <Pill
                  tone={
                    r.classification === "CANDIDATE_AFTER_CANCEL"
                      ? "accent"
                      : r.classification === "NEEDS_REVIEW"
                        ? "review"
                        : "neutral"
                  }
                >
                  {r.classificationTitle}
                </Pill>
              </li>
            ))}
          </ul>
        </div>
      )}
      {canc.reviewReasons.length > 0 && (
        <div className="mt-3">
          <Notice tone="review">
            Needs review: {canc.reviewReasons.join(", ").replace(/_/g, " ").toLowerCase()}
          </Notice>
        </div>
      )}
      <LocalStatus scope="cancellation" />
      {open && role === "buyer" && (
        <form
          className="sheet mt-5 p-4 sm:p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h3 className="text-lg font-extrabold tracking-tight">
            Record the confirmation you received
          </h3>
          <p className="mt-1 text-sm text-ink-soft">
            Enter the times exactly as they appear in your confirmation, with a UTC offset. Choose
            the documents that prove it.
          </p>
          {hints && (
            <button type="button" className="btn btn-secondary mt-3" onClick={fillFromHints}>
              Fill from the fixture confirmation email (demo convenience)
            </button>
          )}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">Takes effect (ISO, with offset)</span>
              <input
                className="field mono"
                value={effectiveAt}
                onChange={(e) => setEffectiveAt(e.target.value)}
                placeholder="2026-11-07T12:00:00Z"
                required
              />
            </label>
            <label className="block">
              <span className="label">Confirmation received at</span>
              <input
                className="field mono"
                value={receivedAt}
                onChange={(e) => setReceivedAt(e.target.value)}
                placeholder="2026-11-06T09:45:00Z"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="label">Basis</span>
              <select
                className="field"
                value={basis}
                onChange={(e) => setBasis(e.target.value as typeof basis)}
              >
                <option value="merchant_confirmation_document">
                  Merchant confirmation document I kept
                </option>
                <option value="user_attestation">My own attestation (no document)</option>
              </select>
            </label>
          </div>
          <fieldset className="mt-4">
            <legend className="label">Proof documents</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {files.map((f) => (
                <label
                  key={f.id}
                  className="flex min-h-[44px] items-start gap-2 rounded-xl border border-line bg-white px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.includes(f.id)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked ? [...prev, f.id] : prev.filter((x) => x !== f.id),
                      )
                    }
                  />
                  <span>
                    <span className="font-semibold">{f.label}</span>
                    <span className="block text-xs text-ink-muted">
                      {f.kind.replace(/_/g, " ")}, {f.visibility}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary">
              Save cancellation record
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {s.providerRefs.length > 0 && (
        <details className="mt-3">
          <summary>Provider references</summary>
          <p className="mono mt-1 text-ink-muted">
            {s.providerRefs.map((r) => `${r.kind}=${r.value} (${r.provenance})`).join("; ")}
          </p>
        </details>
      )}
    </FoldCard>
  );
}

/* ------------------------------------------------------------------- check */

function CheckSection({ className }: { className?: string }) {
  const { view, role, run } = useWorkbench();
  const c = view.case;
  const ch = view.charge;
  const waiting = awaitingFirstPayment(view);
  const [amount, setAmount] = useState(
    c.requestedCents !== null ? (c.requestedCents / 100).toFixed(2) : "",
  );
  const [channel, setChannel] = useState(c.channel);
  const [reason, setReason] = useState("");
  const tone =
    c.classification === "CANDIDATE_AFTER_CANCEL"
      ? "accent"
      : c.classification === "NEEDS_REVIEW"
        ? "review"
        : "info";
  return (
    <FoldCard
      className={className}
      id="charge"
      title="The check"
      summary={waiting ? "Nothing to check yet." : `${c.classificationText.title}.`}
      subtitle="The charge's initiation time is compared with the time the cancellation takes effect, together with identity, currency, status and refunds."
    >
      {waiting ? (
        <Notice tone="info">
          <strong>Nothing to check yet.</strong> No payment has been read for this subscription. The
          check compares a payment&apos;s initiation time with your cancellation, so it runs when a
          payment is read.
        </Notice>
      ) : (
        <Notice tone={tone}>
          <strong>{c.classificationText.title}.</strong> {c.classificationText.summary}
        </Notice>
      )}
      <ul className="mt-3 space-y-1.5 text-sm">
        {c.reasonCodes.map((r) => (
          <li key={r.code} className="flex flex-wrap gap-x-2">
            <span className="text-ink-soft">{r.text}</span>
            <span className="mono text-ink-muted">{r.code}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-4 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        <Fact
          label="Charge"
          value={
            waiting
              ? "no payment read yet"
              : `${ch.amountText ?? "unknown amount"}, ${
                  ch.status === "UNKNOWN"
                    ? "status unknown"
                    : ch.status.toLowerCase().replace(/_/g, " ")
                }`
          }
        />
        <Fact label="Description" value={ch.description} />
        <Fact label="Initiated" value={formatInstant(ch.eventTime)} />
        <Fact label="Posted" value={formatInstant(ch.postedTime)} />
        <Fact
          label="Service period"
          value={
            ch.servicePeriodStart
              ? `${formatDay(ch.servicePeriodStart)} to ${formatDay(ch.servicePeriodEnd)}`
              : "unknown"
          }
        />
        <Fact
          label="Refunds"
          value={
            ch.refundStateKnown ? `${ch.refundedText ?? "$0.00 USD"} (verified)` : "not verified"
          }
        />
        <Fact label="Association" value={ch.matchMethod.replace(/_/g, " ")} />
        <Fact label="Remaining claimable" value={c.claimableText ?? "not computable"} />
      </dl>
      <p className="mt-3 text-sm text-ink-soft">
        <strong className="text-ink">Channel:</strong> {c.channel.replace(/_/g, " ")}{" "}
        {c.channelAdapter === "connected" ? (
          <Pill tone="info">connected adapter (Sandbox)</Pill>
        ) : c.channelAdapter === "simulated" ? (
          <Pill tone="neutral">simulated adapter (fixture)</Pill>
        ) : (
          <Pill tone="neutral">export only</Pill>
        )}{" "}
        {c.channelDescription}
        {c.claimActive && (
          <>
            {" "}
            <Pill tone="accent">active claim</Pill>
          </>
        )}
        {c.claimClosedReason && (
          <span className="text-ink-muted"> Previous claim closed: {c.claimClosedReason}</span>
        )}
      </p>

      {role === "buyer" && (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <form
            className="sheet p-4"
            onSubmit={(e) => {
              e.preventDefault();
              const cents = Math.round(Number(amount) * 100);
              void run(
                "Updating requested amount",
                () => apiPost<CaseView>(`/api/cases/${c.id}/amount`, { cents }),
                "Requested amount updated. Open approvals were invalidated.",
                "check",
              );
            }}
          >
            <label className="block">
              <span className="label">Requested amount (USD, up to the remaining claimable)</span>
              <input
                className="field mono"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="19.99"
              />
            </label>
            <button
              type="submit"
              className="btn btn-secondary mt-3"
              disabled={c.claimableCents === null}
            >
              Set requested amount
            </button>
          </form>
          <form
            className="sheet p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                "Transferring channel",
                () => apiPost<CaseView>(`/api/cases/${c.id}/channel`, { channel, reason }),
                "Channel updated. One charge keeps at most one active financial claim.",
                "check",
              );
            }}
          >
            <label className="block">
              <span className="label">Recovery channel</span>
              <select
                className="field"
                value={channel}
                onChange={(e) => setChannel(e.target.value as typeof channel)}
              >
                <option value="merchant_refund">Merchant refund request (export only)</option>
                <option value="paypal">PayPal case (connected in Sandbox mode)</option>
                <option value="app_store">App store refund (export only)</option>
                <option value="chargeback">Card chargeback (export only)</option>
              </select>
            </label>
            <label className="mt-3 block">
              <span className="label">Reason for choosing or transferring</span>
              <input
                className="field"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. merchant did not reply within 7 days"
              />
            </label>
            <button
              type="submit"
              className="btn btn-secondary mt-3"
              disabled={reason.trim().length < 3}
            >
              Apply channel
            </button>
          </form>
        </div>
      )}
      <LocalStatus scope="check" />
      {ch.providerRefs.length > 0 && (
        <details className="mt-3">
          <summary>Charge references</summary>
          <p className="mono mt-1 text-ink-muted">
            {ch.providerRefs.map((r) => `${r.kind}=${r.value} (${r.provenance})`).join("; ")}
          </p>
        </details>
      )}
    </FoldCard>
  );
}

/* -------------------------------------------------------------- operations */

function OperationsSection({ className }: { className?: string }) {
  const { view } = useWorkbench();
  // A request that appears while the page is open settles in; the ones already there stay put.
  const known = useRef<Set<string> | null>(null);
  useLayoutEffect(() => {
    const ids = view.operations.map((o) => o.id);
    if (known.current) {
      for (const id of ids)
        if (!known.current.has(id)) document.getElementById(`op-${id}`)?.classList.add("settle");
    }
    known.current = new Set(ids);
  }, [view.operations]);
  return (
    <FoldCard
      className={className}
      id="operations"
      title="Requests and results"
      summary={operationsSummary(view.operations)}
      subtitle="Every export or submission is recorded once, with one dispatch. An unknown result is never sent again automatically."
    >
      {view.operations.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing has been exported or sent from this view.</p>
      ) : (
        <ul className="space-y-3">
          {view.operations.map((op) => (
            <OperationRow key={op.id} op={op} />
          ))}
        </ul>
      )}
      <LocalStatus scope="operations" />
    </FoldCard>
  );
}

/** The name a person knows the request by; an action without one keeps its own words. */
function operationTitle(action: string, environment: string): string {
  return action in ACTION_LABEL ? actionLabel(action as ActionKind, environment) : sentence(action);
}

function OperationRow({ op }: { op: ViewOperation }) {
  const { run, view } = useWorkbench();
  const [findings, setFindings] = useState<string[] | null>(null);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const readback = () =>
    run(
      "Reading back from the provider",
      async () => {
        const r = await apiPost<{ findings: string[]; candidateDisputeId: string | null }>(
          `/api/operations/${op.id}/readback`,
          {},
        );
        setFindings(r.findings);
        setCandidate(r.candidateDisputeId);
      },
      undefined,
      "operations",
    );
  const resolve = (decision: "confirmed_succeeded" | "confirmed_failed" | "needs_manual_review") =>
    run(
      "Recording recovery decision",
      () =>
        apiPost<{ view: CaseView }>(`/api/operations/${op.id}/resolve`, {
          decision,
          note,
          disputeId: candidate,
        }),
      "Recovery decision recorded.",
      "operations",
    );
  const unknown = op.status === "UNKNOWN";
  const opensCase = op.action === "buyer_create_dispute";
  return (
    <li
      id={`op-${op.id}`}
      className={`doc p-4 ${unknown ? "border-2 border-review-fill" : op.status === "FAILED" ? "border-block" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatePill state={op.status} />
        <span className="font-bold">{operationTitle(op.action, view.mode.environment)}</span>
        <Pill tone={op.providerWrite ? "info" : "neutral"}>
          {op.providerWrite ? "provider write" : "local export"}
        </Pill>
        <span className="text-xs text-ink-muted">{formatInstant(op.updatedAt)}</span>
      </div>
      {op.errorCode && (
        <p className="mt-2 text-sm text-block">
          {op.errorMessage} <span className="mono">{op.errorCode}</span>
        </p>
      )}
      {op.status === "FAILED" && (
        <p className="mt-1 text-xs text-ink-muted">
          Nothing was applied. A new attempt needs a new draft review and approval.
        </p>
      )}
      {op.recoveryDecision && (
        <p className="mt-2 text-xs text-ink-muted">
          Recovery: {op.recoveryDecision.replace(/_/g, " ")}. {op.recoveryNote}
        </p>
      )}
      {unknown && (
        <div className="mt-3 rounded-xl bg-review-soft p-3 text-sm text-ink">
          <p className="font-bold">
            Result unknown. The request may or may not have reached the provider.
          </p>
          <p className="mt-1">
            Read back first, then record what you verified. Sending it again is not offered: it
            could create a duplicate.
          </p>
          {opensCase && (
            <p className="mt-1">
              A case creation cannot be recorded as failed. A list without the case does not prove
              that none was created, so this request keeps its claim on the charge until the case is
              found.
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary" onClick={readback}>
              Read back
            </button>
          </div>
          {findings && (
            <ul className="mt-2 list-disc pl-5">
              {findings.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
          <label className="mt-3 block">
            <span className="label">What did you verify?</span>
            <input
              className="field"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. The case appears in the Sandbox resolution view with this amount."
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!note.trim()}
              onClick={() => resolve("confirmed_succeeded")}
            >
              Confirm it succeeded
            </button>
            {!opensCase && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={!note.trim()}
                onClick={() => resolve("confirmed_failed")}
              >
                Confirm it failed
              </button>
            )}
            <button
              type="button"
              className="btn btn-quiet"
              disabled={!note.trim()}
              onClick={() => resolve("needs_manual_review")}
            >
              Keep for manual review
            </button>
          </div>
        </div>
      )}
      {op.downloads && <ExportDownloads downloads={op.downloads} />}
      <details className="mt-2">
        <summary className="text-xs">Technical details</summary>
        <p className="mono mt-1 text-ink-muted">
          {op.id}, attempts {op.attempts}
          {op.result
            ? `; ${Object.entries(op.result)
                .filter(([k]) =>
                  [
                    "disputeId",
                    "status",
                    "provenance",
                    "correlationId",
                    "packHash",
                    "note",
                    "recoveredByHuman",
                    "localStateIssue",
                  ].includes(k),
                )
                .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
                .join("; ")}`
            : ""}
        </p>
      </details>
    </li>
  );
}

/* ---------------------------------------------------------------- provider */

function ProviderSection({ className }: { className?: string }) {
  const { view, run } = useWorkbench();
  const p = view.provider;
  return (
    <FoldCard
      className={className}
      id="provider"
      title="Provider case"
      summary={
        p
          ? `${sentence(p.status ?? "unknown")}, read ${formatInstant(p.observedAt)}.`
          : "None observed."
      }
      subtitle="Status, stage, deadline and allowed actions as last read back. A synthetic observation is a simulation, never a PayPal result."
      actions={
        p ? (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              run(
                "Refreshing provider state",
                () =>
                  apiPost<{ view: CaseView }>(`/api/cases/${view.case.id}/provider/refresh`, {}),
                undefined,
                "provider",
              )
            }
          >
            Refresh
          </button>
        ) : null
      }
    >
      {!p ? (
        <p className="text-sm text-ink-muted">No provider case observed for this charge yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StatePill state={p.status ?? "UNKNOWN"} />
            <ProvenancePill provenance={p.provenance} />
            {p.stale && (
              <Pill tone="review">stale: last refresh failed or the order is uncertain</Pill>
            )}
            {!p.enumsUnderstood && (
              <Pill tone="block">unknown provider value: changes are disabled</Pill>
            )}
          </div>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            <Fact label="Case ID" value={p.disputeId} mono />
            <Fact label="Stage" value={p.stage} />
            <Fact label="Reason" value={p.reason} />
            <Fact label="Outcome" value={p.outcome ?? "none yet"} />
            <Fact label="Seller response due" value={formatInstant(p.sellerResponseDueAt)} />
            <Fact label="Observed" value={formatInstant(p.observedAt)} />
            <Fact
              label="Requested evidence"
              value={p.requestedEvidenceTypes.join(", ") || "none listed"}
            />
            <Fact
              label="Allowed actions (validated links)"
              value={p.allowedActions.join(", ") || "none"}
            />
          </dl>
          {p.evidenceCapability && (
            <p className="mt-2 text-xs text-ink-muted">
              Merchant evidence capability:{" "}
              {p.evidenceCapability.allowed
                ? "available now"
                : `blocked (${p.evidenceCapability.codes.join(", ")})`}
            </p>
          )}
          {p.toolkitCrossCheck && (
            <p className="mt-1 text-xs text-ink-muted">
              PayPal Agent Toolkit cross-check ({formatInstant(p.toolkitCrossCheck.at)}):{" "}
              {p.toolkitCrossCheck.note}
              {p.toolkitCrossCheck.status ? `; toolkit status ${p.toolkitCrossCheck.status}` : ""}
            </p>
          )}
          {p.testControls.length > 0 && (
            <div className="mt-4 rounded-xl border-2 border-dashed border-line p-3">
              <p className="text-sm font-semibold">
                PayPal Sandbox test controls used on this case
              </p>
              <ul className="mt-2 flex flex-col gap-1.5 text-sm">
                {p.testControls.map((t) => (
                  <li key={`${t.kind}-${t.at}`} className="flex flex-wrap items-center gap-2">
                    <span>{testControlLabel(t.kind, t.outcome)}</span>
                    <StatePill state={t.status} />
                    <span className="text-xs text-ink-muted">{formatInstant(t.at)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-ink-muted">
                These are PayPal&apos;s own Sandbox simulations of its steps, run as recorded test
                requests. In the live environment PayPal decides; CancelCase only reads the result
                back.
              </p>
            </div>
          )}
        </>
      )}
      <LocalStatus scope="provider" />
    </FoldCard>
  );
}

/** What a Sandbox test control did, in words. */
function testControlLabel(kind: "evidence_request" | "settlement", outcome: string | null): string {
  if (kind === "evidence_request") return "Asked the seller for evidence (simulation)";
  if (outcome === "BUYER_FAVOR") return "Decided in the buyer's favour (simulation)";
  if (outcome === "SELLER_FAVOR") return "Decided in the seller's favour (simulation)";
  return "Decided the case (simulation)";
}

/* ---------------------------------------------------------------- timeline */

function TimelineSection({ className }: { className?: string }) {
  const { view } = useWorkbench();
  return (
    <FoldCard
      className={className}
      id="timeline"
      title="Timeline"
      summary={`${view.timeline.length} entr${view.timeline.length === 1 ? "y" : "ies"} in time order.`}
      subtitle="Facts, actions and provider observations in time order, each with where it came from."
    >
      <ol className="relative ml-1 border-l-2 border-ink pl-5">
        {view.timeline.map((ev, i) => (
          <li key={i} className="relative mb-4 last:mb-0">
            <span
              className={`absolute -left-[1.68rem] top-1.5 h-3 w-3 rounded-full border-2 border-ink ${ev.kind === "provider" ? "bg-info-soft" : ev.kind === "action" ? "bg-signal" : ev.kind === "system" ? "bg-paper-deep" : "bg-sheet"}`}
              aria-hidden="true"
            />
            <p className="text-xs text-ink-muted">{ev.at ? formatInstant(ev.at) : "no time"}</p>
            <p className="font-semibold leading-snug">{ev.title}</p>
            {ev.detail && <p className="text-sm text-ink-soft">{ev.detail}</p>}
            <div className="mt-1">
              <ProvenancePill provenance={ev.provenance} />
            </div>
          </li>
        ))}
      </ol>
      {view.gaps.length > 0 && (
        <div className="mt-4">
          <Notice tone="review">
            <strong>Gaps:</strong> {view.gaps.join(" ")}
          </Notice>
        </div>
      )}
    </FoldCard>
  );
}

/* ------------------------------------------------------------- records */

function RecordsSection({ className }: { className?: string }) {
  const { view, role, run } = useWorkbench();
  const [confirm, setConfirm] = useState("");
  const [deleted, setDeleted] = useState<string | null>(null);
  return (
    <FoldCard
      className={className}
      id="housekeeping"
      title="Audit and retention"
      summary={`${view.audit.length} audit entr${view.audit.length === 1 ? "y" : "ies"}. Data stays on this computer.`}
      subtitle="Data stays on this computer until you delete the case."
    >
      <details>
        <summary>Audit log ({view.audit.length} entries)</summary>
        <ul className="mt-2 max-h-56 space-y-1 overflow-auto text-xs">
          {view.audit.map((a, i) => (
            <li key={i} className="mono text-ink-muted">
              {formatInstant(a.at)} {a.role ?? "system"} {a.action}
              {a.reasonCode ? ` (${a.reasonCode})` : ""}
            </li>
          ))}
        </ul>
      </details>
      {role === "buyer" && (
        <details>
          <summary>Delete this case</summary>
          <form
            className="mt-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                "Deleting case",
                async () => {
                  await apiPost(`/api/cases/${view.case.id}/delete`, { confirm });
                  setDeleted(view.case.id);
                },
                undefined,
                "records",
              );
            }}
          >
            <p className="text-xs text-ink-muted">
              Removes evidence files, drafts, approvals, operations and workflow checkpoints for
              this case. It does not delete anything already sent to a provider, and file deletion
              is not secure erasure. Not possible while an operation is executing or unknown.
            </p>
            <label className="mt-2 block">
              <span className="label">Type the case ID to confirm</span>
              <input
                className="field mono"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={view.case.id}
              />
            </label>
            <button
              type="submit"
              className="btn btn-danger mt-3"
              disabled={confirm !== view.case.id}
            >
              Delete case
            </button>
            {deleted && (
              <p className="mt-2 text-sm">
                Case deleted.{" "}
                <Link className="link" href="/">
                  Back to overview
                </Link>
              </p>
            )}
          </form>
        </details>
      )}
      <LocalStatus scope="records" />
    </FoldCard>
  );
}

export function scrollBehavior(): ScrollBehavior {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

export type { ViewDraft };

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** The files of one approved export. The private local archive is deliberately not listed here. */
function ExportDownloads({ downloads }: { downloads: ViewExportDownloads }) {
  if (downloads.unavailable)
    return (
      <p className="mt-3 text-sm text-ink-muted" data-testid="export-downloads-unavailable">
        Downloads are not available for this export. {downloads.unavailable}
      </p>
    );
  const row = (d: ViewExportDownloads["materials"][number]) => (
    <li key={d.href} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <a className="link text-sm" href={d.href} download={d.filename}>
        {d.label}
      </a>
      <span className="mono text-xs text-ink-muted">
        {formatBytes(d.sizeBytes)}, sha256 {d.sha256.slice(0, 12)}
      </span>
    </li>
  );
  return (
    <div className="mt-3 rounded-xl bg-paper p-3" data-testid="export-downloads">
      <p className="text-sm font-bold">
        Approved materials for the recipient
        {downloads.draftVersion !== null ? ` (draft version ${downloads.draftVersion})` : ""}
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        These are the files of this approval, checked against the hashes recorded when you approved.
        Nothing was sent; you send them yourself.
      </p>
      <ul className="mt-2 space-y-1">{downloads.materials.map(row)}</ul>
      <p className="mt-3 text-xs font-bold">
        {downloads.attachments.length > 0
          ? "Attachments you selected"
          : "No attachments were selected for this export."}
      </p>
      {downloads.attachments.length > 0 && (
        <ul className="mt-1 space-y-1">{downloads.attachments.map(row)}</ul>
      )}
      <p className="mt-3 text-xs text-ink-muted">
        The local archive under Evidence is a different file: it holds your complete private view
        and is not meant to be sent.
      </p>
    </div>
  );
}
