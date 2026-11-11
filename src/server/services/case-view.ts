import type { AppContext } from "../context";
import {
  approvals as approvalRepo,
  audit,
  cases,
  charges,
  contacts,
  drafts as draftRepo,
  operations as operationRepo,
  subscriptions,
} from "../db/repos";
import type { ApprovalRecord, DraftRecord, OperationRecord } from "../records";
import { requireBundle } from "./case-service";
import { buildRoleSnapshot, visibleEvidence, type CaseBundle } from "./snapshot";
import { describeMode } from "../config";
import { describeChannel } from "@/domain/channels";
import { formatCents } from "@/domain/money";
import { compareInstants, isExpired } from "@/domain/time";
import { canProvideEvidence } from "@/domain/provider-state";
import type { ActionKind, Classification, ReasonCode, Role, WorkflowState } from "@/domain/types";
import { maskId } from "@/paypal/redact";
import { EVIDENCE_LIMITS } from "./evidence-store";
import { readDemoHints, type DemoHints } from "./fixture-seed";
import { claimForCharge, claimState, type ClaimState } from "./claim-service";
import { draftOriginLabel } from "@/llm/drafter";
import { actionReadiness } from "./readiness";
import { cancellationDetailsIncluded, pickEvidenceType, refundVerified } from "./payloads";
import { SETUP_CASE_SENTINEL } from "./setup-service";
import { exportDownloadList, RECIPIENT_FILE_LABELS } from "./export-download";

/**
 * Role-scoped view model for the UI. Everything the client renders comes from here, so the
 * private evidence filter happens once, server-side. Provider identifiers are masked in
 * recording mode; the server keeps the real values for its own calls.
 */

export const REASON_TEXT: Record<ReasonCode, string> = {
  ENVIRONMENT_MISMATCH: "The charge and subscription belong to different environments.",
  ACCOUNT_MISMATCH: "The charge belongs to a different account.",
  DIFFERENT_SUBSCRIPTION: "The charge is linked to a different subscription.",
  ASSOCIATION_UNRELIABLE:
    "Only the merchant name matches; that is not enough to associate the charge.",
  NO_ASSOCIATION: "No reliable association between the charge and this subscription.",
  SUBSCRIPTION_ACTIVE_NO_CANCELLATION:
    "No cancellation is recorded; the charge looks like a normal renewal.",
  CANCELLATION_NOT_CONFIRMED:
    "Cancellation was requested but is not confirmed with an effective time.",
  CANCELLATION_NEEDS_REVIEW: "The cancellation record needs review (missing or conflicting proof).",
  UNSUPPORTED_CURRENCY: "Only USD is supported in this version.",
  AMOUNT_UNKNOWN: "The charge amount is not known.",
  ZERO_AMOUNT: "The charge amount is zero.",
  CHARGE_PENDING: "The charge is still pending.",
  CHARGE_NOT_COMPLETED: "The charge did not complete.",
  CHARGE_REVERSED: "The charge was reversed.",
  FULLY_REFUNDED: "The charge has been fully refunded.",
  PARTIAL_REFUND_REDUCES_CLAIM: "A partial refund reduces the amount that can be requested.",
  REFUND_STATE_UNKNOWN: "Refund state has not been verified; the claimable amount is unknown.",
  MISSING_EVENT_TIME: "The charge has no event time.",
  INVALID_TIMESTAMP: "A timestamp could not be interpreted (needs an explicit UTC offset).",
  CHARGE_BEFORE_CANCELLATION: "The charge was initiated before the cancellation took effect.",
  POSTED_AFTER_BUT_INITIATED_BEFORE:
    "It posted later, but posting time does not make it a post-cancellation charge.",
  BOUNDARY_EQUALITY:
    "The charge time equals the effective cancellation time exactly; review needed.",
  CHARGE_AFTER_EFFECTIVE_CANCELLATION:
    "The charge was initiated after the effective cancellation time.",
  POSSIBLE_ARREARS: "The charge may be arrears for an earlier period.",
  SERVICE_PERIOD_BEFORE_CANCELLATION:
    "The service period on the receipt ended before the cancellation.",
  SERVICE_PERIOD_UNKNOWN: "The service period covered by the charge is unknown.",
  CHARGE_STATUS_UNKNOWN: "The charge status is unknown.",
};

export const CLASSIFICATION_TEXT: Record<Classification, { title: string; summary: string }> = {
  CANDIDATE_AFTER_CANCEL: {
    title: "Candidate: charged after cancellation",
    summary:
      "A completed charge was initiated after the effective cancellation time. This is a reviewable anomaly, not a finding of fault.",
  },
  NEEDS_REVIEW: {
    title: "Needs review",
    summary: "Facts are missing or contradictory. Resolve them before drafting.",
  },
  NO_ANOMALY: {
    title: "No anomaly",
    summary: "The facts do not show a charge after cancellation.",
  },
};

export interface ViewEvidence {
  id: string;
  label: string;
  kind: string;
  ownerRole: Role;
  visibility: "private" | "shared";
  provenance: string;
  mime: string | null;
  sizeBytes: number | null;
  sha256Short: string | null;
  capturedAt: string | null;
  eventTime: string | null;
  hasFile: boolean;
  textExcerpt: string | null;
  factCount: number;
}

export interface ViewDraft {
  id: string;
  version: number;
  action: ActionKind;
  origin: string;
  /** Neutral origin label: Connected model · Template — no model call · Human edit */
  originLabel: string;
  subject: string;
  claims: { id: string; kind: string; text: string; sourceIds: string[]; factIds: string[] }[];
  renderedText: string;
  /**
   * The closing reference the renderer added from the cited payment record, as it appears in the
   * rendered text ("Transaction ID: … Please confirm the refund within 7 days."), or null.
   */
  referenceLine: string | null;
  /** Approval requests must name this hash: decisions apply to exactly this version */
  contentHash: string;
  attachmentEvidenceIds: string[];
  /** Private sources the author explicitly chose to disclose (none by default) */
  privateSourceIdsIncluded: string[];
  /** Who receives this draft when it is exported or submitted */
  recipientLabel: string;
  validation: {
    ok: boolean;
    issues: { code: string; claimId: string | null; message: string; blocking: boolean }[];
  };
  snapshotVersion: number;
  stale: boolean;
  createdAt: string;
}

export interface ViewApproval {
  id: string;
  action: ActionKind;
  draftId: string | null;
  decision: string;
  decidedAt: string | null;
  expiresAt: string;
  expired: boolean;
  consumedByOperationId: string | null;
  revokedReason: string | null;
  usable: boolean;
}

export interface ViewOperation {
  id: string;
  action: ActionKind;
  role: Role;
  status: string;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  recoveryDecision: string | null;
  recoveryNote: string | null;
  providerWrite: boolean;
  result: Record<string, unknown> | null;
  /** Recipient downloads of a completed export; null for every other operation. */
  downloads: ViewExportDownloads | null;
  createdAt: string;
  updatedAt: string;
}

export interface ViewExportDownload {
  label: string;
  filename: string;
  href: string;
  sizeBytes: number;
  sha256: string;
}

export interface ViewExportDownloads {
  draftVersion: number | null;
  materials: ViewExportDownload[];
  attachments: ViewExportDownload[];
  unavailable: string | null;
}

export interface ViewTimelineEvent {
  at: string | null;
  title: string;
  detail: string;
  kind: "fact" | "action" | "provider" | "system";
  provenance: string | null;
}

export interface CaseView {
  mode: {
    environment: string;
    label: string;
    description: string;
    recordingMode: boolean;
  };
  role: Role;
  case: {
    id: string;
    buyerAlias: string;
    merchantAlias: string;
    channel: string;
    channelDescription: string;
    /** True only when a connected adapter would actually be used (Sandbox mode, PayPal channel) */
    channelConnected: boolean;
    /** connected (Sandbox API) · simulated (fixture adapter) · export_only (no adapter) */
    channelAdapter: "connected" | "simulated" | "export_only";
    claimActive: boolean;
    /** none · reserved (a claim-opening operation is unsettled) · open (provider case exists) */
    claimState: ClaimState;
    claimClosedReason: string | null;
    buyerState: WorkflowState;
    merchantState: WorkflowState;
    roleState: WorkflowState;
    classification: Classification;
    classificationText: { title: string; summary: string };
    reasonCodes: { code: ReasonCode; text: string }[];
    claimableCents: number | null;
    claimableText: string | null;
    requestedCents: number | null;
    requestedText: string | null;
    /** Remaining claimable amount, else the charge amount; null when the amount is unknown */
    amountUnderReviewCents: number | null;
    amountUnderReviewText: string;
    /** Refunds read back from the provider, in cents; 0 when none is verified. */
    recoveredCents: number;
    recoveredText: string;
    evidenceSnapshotVersion: number;
    origin: string;
    originNote: string | null;
    createdAt: string;
    updatedAt: string;
  };
  subscription: {
    id: string;
    label: string;
    merchantAlias: string;
    amountText: string | null;
    providerRefs: { kind: string; value: string; provenance: string }[];
    providerStatus: string | null;
    providerStatusObservedAt: string | null;
    cancellation: {
      state: string;
      requestedAt: string | null;
      confirmationReceivedAt: string | null;
      effectiveAt: string | null;
      basis: string | null;
      basisLabel: string;
      evidenceIds: string[];
      reviewReasons: string[];
      providerMandateStatus: string | null;
      providerMandateObservedAt: string | null;
      providerMandateProvenance: string | null;
      providerMandateNextBillingAt: string | null;
    };
    /**
     * Set when the provider still plans to bill a mandate after the recorded cancellation takes
     * effect. The two facts stand side by side: one is the buyer's record, the other the
     * provider's plan. `due` is true once the planned time has passed.
     */
    billingWatch: {
      nextBillingAt: string;
      observedAt: string | null;
      provenance: string | null;
      due: boolean;
    } | null;
    /** Whether this view can read the subscription's payments from the provider. */
    paymentsReadable: boolean;
  };
  /** The other payments of the same subscription; each has its own case. */
  relatedCases: {
    id: string;
    eventTime: string | null;
    amountText: string | null;
    status: string;
    classification: Classification;
    classificationTitle: string;
  }[];
  charge: {
    id: string;
    description: string | null;
    status: string;
    amountText: string | null;
    refundedText: string | null;
    refundStateKnown: boolean;
    eventTime: string | null;
    postedTime: string | null;
    ingestedTime: string;
    servicePeriodStart: string | null;
    servicePeriodEnd: string | null;
    matchMethod: string;
    providerRefs: { kind: string; value: string; provenance: string }[];
  };
  provider: {
    disputeId: string | null;
    provenance: string | null;
    status: string | null;
    stage: string | null;
    outcome: string | null;
    reason: string | null;
    sellerResponseDueAt: string | null;
    requestedEvidenceTypes: string[];
    /** The evidence type an evidence response would be labelled with (see pickEvidenceType). */
    evidenceTypeToSend: string;
    allowedActions: string[];
    observedAt: string | null;
    enumsUnderstood: boolean;
    stale: boolean;
    evidenceCapability: { allowed: boolean; codes: string[] } | null;
    toolkitCrossCheck: {
      ok: boolean;
      status: string | null;
      agrees: boolean | null;
      note: string;
      at: string;
    } | null;
    /**
     * PayPal Sandbox test controls used on this provider case: PayPal's own simulations of its
     * steps (asking for the seller's evidence, deciding the case). Never product actions.
     */
    testControls: {
      kind: "evidence_request" | "settlement";
      /** For a settlement: the outcome that was asked for. */
      outcome: string | null;
      status: string;
      at: string;
    }[];
  } | null;
  evidence: ViewEvidence[];
  /** Every source the role's drafts may cite (documents and recorded observations), for labels */
  sources: {
    id: string;
    label: string;
    kind: string;
    provenance: string;
    visibility: string;
    hasFile: boolean;
  }[];
  evidenceLimits: typeof EVIDENCE_LIMITS;
  contactHistory: { id: string; at: string; direction: string; summary: string; shared: boolean }[];
  drafts: Partial<Record<ActionKind, ViewDraft>>;
  approvals: Partial<Record<ActionKind, ViewApproval>>;
  operations: ViewOperation[];
  availableActions: ActionKind[];
  /** Server-derived readiness per action: what is possible now and why not */
  readiness: Partial<
    Record<
      ActionKind,
      {
        generate: { code: string; message: string } | null;
        approve: { code: string; message: string } | null;
        submit: { code: string; message: string } | null;
        reviewPending: boolean;
      }
    >
  >;
  timeline: ViewTimelineEvent[];
  gaps: string[];
  audit: { at: string; action: string; reasonCode: string | null; role: string | null }[];
  demoHints: DemoHints | null;
  serverTime: string;
}

const BASIS_LABEL: Record<string, string> = {
  user_attestation: "User attestation (not verified by a provider)",
  merchant_confirmation_document: "Merchant confirmation document kept by the buyer",
  provider_api_observation: "Observed through the provider API",
};

/**
 * Recording mode masks every real identifier, whatever its source: a value read from the
 * provider and a value an operator typed in (user attestation) are equally sensitive. Only
 * synthetic fixture values, which are invented, are shown in full.
 */
export function maskForRecording(
  ctx: AppContext,
  value: string | null,
  provenance: string | null,
): string | null {
  if (!value || !ctx.config.recordingMode || provenance === "synthetic") return value;
  return maskId(value);
}

/**
 * Recording mode applied to free text: a real identifier inside a letter (its closing reference,
 * or one typed into a paragraph) is masked like everywhere else. Synthetic values stay readable.
 */
export function maskIdsInText(
  ctx: AppContext,
  refs: { value: string | null; provenance: string | null }[],
): (text: string) => string {
  const real = ctx.config.recordingMode
    ? refs
        .filter((r): r is { value: string; provenance: string | null } => Boolean(r.value))
        .filter((r) => r.provenance !== "synthetic")
        .map((r) => r.value)
        .sort((a, b) => b.length - a.length)
    : [];
  if (real.length === 0) return (text) => text;
  return (text) => real.reduce((acc, id) => acc.split(id).join(maskId(id) ?? id), text);
}

const REFERENCE_LINE_RE = /^Transaction ID: .+\. Please confirm the refund within 7 days\.$/m;

function refView(ctx: AppContext, refs: { kind: string; value: string; provenance: string }[]) {
  return refs.map((r) => ({
    kind: r.kind,
    provenance: r.provenance,
    value: maskForRecording(ctx, r.value, r.provenance) ?? r.value,
  }));
}

function recipientLabel(action: ActionKind, merchantAlias: string): string {
  if (action === "export_refund_request") return `${merchantAlias} (you send it yourself)`;
  return "PayPal case reviewer";
}

function draftView(
  d: DraftRecord,
  currentSnapshotVersion: number,
  merchantAlias: string,
  mask: (text: string) => string = (text) => text,
): ViewDraft {
  const renderedText = mask(d.renderedText);
  return {
    id: d.id,
    version: d.version,
    action: d.action,
    origin: d.origin,
    originLabel: draftOriginLabel(d.origin),
    subject: d.content.subject,
    claims: d.content.claims.map((c) => ({ ...c, text: mask(c.text) })),
    renderedText,
    referenceLine: REFERENCE_LINE_RE.exec(renderedText)?.[0] ?? null,
    contentHash: d.contentHash,
    attachmentEvidenceIds: d.content.attachmentEvidenceIds,
    privateSourceIdsIncluded: d.content.privateSourceIdsIncluded ?? [],
    recipientLabel: recipientLabel(d.action, merchantAlias),
    validation: d.validation,
    snapshotVersion: d.snapshotVersion,
    stale: d.snapshotVersion !== currentSnapshotVersion,
    createdAt: d.createdAt,
  };
}

function approvalView(a: ApprovalRecord, ctx: AppContext): ViewApproval {
  const expired = isExpired(a.expiresAt, ctx.clock);
  return {
    id: a.id,
    action: a.action,
    draftId: a.draftId,
    decision: a.decision,
    decidedAt: a.decidedAt,
    expiresAt: a.expiresAt,
    expired,
    consumedByOperationId: a.consumedByOperationId,
    revokedReason: a.revokedReason,
    usable: a.decision === "approved" && !expired && !a.consumedByOperationId && !a.revokedReason,
  };
}

function exportDownloadsView(
  o: OperationRecord,
  labels: Map<string, string>,
): ViewExportDownloads | null {
  const list = exportDownloadList(o);
  if (!list) return null;
  const base = `/api/operations/${o.id}/export`;
  return {
    draftVersion: list.draftVersion,
    materials: list.materials.map((m) => ({
      label: RECIPIENT_FILE_LABELS[m.key],
      filename: m.filename,
      href: `${base}?file=${m.key}`,
      sizeBytes: m.sizeBytes,
      sha256: m.sha256,
    })),
    attachments: list.attachments.map((a) => ({
      // The document's own name where this role can still see it; the file name otherwise.
      label: labels.get(a.evidenceId) ?? a.filename,
      filename: a.filename,
      href: `${base}?attachment=${encodeURIComponent(a.evidenceId)}`,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256,
    })),
    unavailable: list.unavailable,
  };
}

function operationView(
  o: OperationRecord,
  ctx: AppContext,
  labels: Map<string, string>,
): ViewOperation {
  const result = (
    o.result && typeof o.result === "object" ? { ...(o.result as Record<string, unknown>) } : null
  ) as Record<string, unknown> | null;
  if (result && typeof result.disputeId === "string") {
    result.disputeId = maskForRecording(
      ctx,
      result.disputeId as string,
      (result.provenance as string | undefined) ??
        (o.environment === "fixture" ? "synthetic" : null),
    );
  }
  return {
    id: o.id,
    action: o.action,
    role: o.role,
    status: o.status,
    attempts: o.attempts,
    errorCode: o.errorCode,
    errorMessage: o.errorMessage,
    recoveryDecision: o.recoveryDecision,
    recoveryNote: o.recoveryNote,
    providerWrite: o.action !== "export_refund_request",
    result,
    downloads: exportDownloadsView(o, labels),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

/** The Sandbox test controls recorded for one provider case, oldest first. */
function sandboxTestControls(
  ctx: AppContext,
  disputeId: string | null,
): NonNullable<CaseView["provider"]>["testControls"] {
  if (!disputeId) return [];
  return operationRepo
    .listForCase(ctx.db, SETUP_CASE_SENTINEL)
    .filter(
      (op) =>
        (op.action === "sandbox_require_evidence" || op.action === "sandbox_adjudicate") &&
        (op.payload as { disputeId?: unknown }).disputeId === disputeId,
    )
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((op) => ({
      kind:
        op.action === "sandbox_adjudicate"
          ? ("settlement" as const)
          : ("evidence_request" as const),
      outcome:
        op.action === "sandbox_adjudicate"
          ? String((op.payload as { outcome?: unknown }).outcome ?? "") || null
          : null,
      status: op.status,
      at: op.updatedAt,
    }));
}

export function buildCaseView(ctx: AppContext, caseId: string, role: Role): CaseView {
  const bundle = requireBundle(ctx, caseId);
  const { caseRecord: rec, charge, subscription } = bundle;
  const snapshot = buildRoleSnapshot(ctx, bundle, role);
  const maskText = maskIdsInText(ctx, [
    ...charge.providerRefs,
    ...subscription.providerRefs,
    {
      value: rec.providerObservation?.disputeId ?? null,
      provenance: rec.providerObservation?.provenance ?? null,
    },
  ]);
  const visible = visibleEvidence(bundle, role);
  const mode = describeMode(ctx.config.mode);
  const actionsForRole: ActionKind[] =
    role === "buyer"
      ? ["export_refund_request", "buyer_create_dispute"]
      : ["merchant_provide_evidence"];
  const drafts: Partial<Record<ActionKind, ViewDraft>> = {};
  const approvals: Partial<Record<ActionKind, ViewApproval>> = {};
  for (const action of actionsForRole) {
    const d = draftRepo.latest(ctx.db, caseId, role, action);
    if (d) {
      drafts[action] = draftView(d, rec.evidenceSnapshotVersion, rec.merchantAlias, maskText);
      const a = approvalRepo.latestForDraft(ctx.db, d.id);
      if (a) approvals[action] = approvalView(a, ctx);
    }
  }
  const sourceLabels = new Map(snapshot.sources.map((src) => [src.id, src.label]));
  const ops = operationRepo
    .listForCase(ctx.db, caseId)
    .filter((o) => o.role === role)
    .map((o) => operationView(o, ctx, sourceLabels));
  const obs = rec.providerObservation;
  const providerCapability = obs
    ? canProvideEvidence(obs, "merchant", ctx.clock, {
        requireRealProvider: ctx.config.mode === "sandbox",
      })
    : null;
  const verifiedRefund =
    charge.refundStateKnown && (charge.refundedCents ?? 0) > 0 ? charge.refundedCents! : 0;
  // An unknown charge amount stays unknown; it is never shown as $0.00.
  const underReview = rec.claimableCents ?? charge.amountCents ?? null;

  const timeline: ViewTimelineEvent[] = [];
  timeline.push({
    at: null,
    title: "Subscription tracked",
    detail: `${subscription.label} with ${subscription.merchantAlias}`,
    kind: "fact",
    // The real source of the subscription record: a provider read, the fixture or the operator.
    provenance:
      subscription.providerRefs.find((r) => r.kind === "subscription_id")?.provenance ??
      "user_attestation",
  });
  if (subscription.cancellation.requestedAt)
    timeline.push({
      at: subscription.cancellation.requestedAt,
      title: "Cancellation requested",
      detail: "Recorded cancellation request",
      kind: "fact",
      provenance: subscription.cancellation.basis,
    });
  if (
    subscription.cancellation.effectiveAt &&
    subscription.cancellation.state === "CANCEL_CONFIRMED"
  ) {
    timeline.push({
      at: subscription.cancellation.effectiveAt,
      title: "Cancellation effective",
      detail: BASIS_LABEL[subscription.cancellation.basis ?? ""] ?? "basis not recorded",
      kind: "fact",
      provenance: subscription.cancellation.basis,
    });
  }
  if (charge.eventTime)
    timeline.push({
      at: charge.eventTime,
      title: "Charge initiated",
      detail: `${charge.status} ${charge.amountCents !== null ? formatCents(charge.amountCents) : "unknown amount"}`,
      kind: "fact",
      provenance:
        charge.providerRefs.find((r) => r.provenance === "sandbox_api")?.provenance ??
        charge.providerRefs.find((r) => r.provenance === "synthetic")?.provenance ??
        null,
    });
  for (const c of contacts.listForCase(ctx.db, caseId).filter((c) => c.visibleTo.includes(role))) {
    timeline.push({
      at: c.at,
      title:
        c.direction === "note"
          ? "Note"
          : c.direction === "buyer_to_merchant"
            ? "Buyer contacted merchant"
            : "Merchant replied",
      detail: c.summary,
      kind: "action",
      provenance: "user_attestation",
    });
  }
  for (const o of ops) {
    timeline.push({
      at: o.updatedAt,
      title: `${o.action.replace(/_/g, " ")} → ${o.status}`,
      detail:
        o.errorMessage ??
        (o.status === "SUCCEEDED"
          ? o.providerWrite
            ? "Accepted; read-back follows"
            : "Exported locally; nothing sent"
          : ""),
      kind: o.providerWrite ? "provider" : "action",
      provenance: (o.result?.provenance as string | undefined) ?? null,
    });
  }
  if (obs)
    timeline.push({
      at: obs.observedAt,
      title: `Provider case ${obs.status ?? "unknown"}`,
      detail: `${obs.provenance === "synthetic" ? "Simulated" : "Observed"} · stage ${obs.stage ?? "unknown"}`,
      kind: "provider",
      provenance: obs.provenance,
    });
  timeline.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

  return {
    mode: { environment: ctx.config.mode, ...mode, recordingMode: ctx.config.recordingMode },
    role,
    case: {
      id: rec.id,
      buyerAlias: rec.buyerAlias,
      merchantAlias: rec.merchantAlias,
      channel: rec.channel,
      channelDescription: describeChannel(rec.channel).description,
      channelConnected: channelAdapter(rec.channel, ctx.config.mode) === "connected",
      channelAdapter: channelAdapter(rec.channel, ctx.config.mode),
      claimActive: claimState(claimForCharge(ctx, rec.chargeId)) === "open",
      claimState: claimState(claimForCharge(ctx, rec.chargeId)),
      claimClosedReason: rec.claimClosedReason,
      buyerState: rec.buyerState,
      merchantState: rec.merchantState,
      roleState: role === "buyer" ? rec.buyerState : rec.merchantState,
      classification: rec.classification,
      classificationText: CLASSIFICATION_TEXT[rec.classification],
      reasonCodes: rec.reasonCodes.map((code) => ({ code, text: REASON_TEXT[code] })),
      claimableCents: rec.claimableCents,
      claimableText: rec.claimableCents !== null ? formatCents(rec.claimableCents) : null,
      requestedCents: rec.requestedCents,
      requestedText: rec.requestedCents !== null ? formatCents(rec.requestedCents) : null,
      amountUnderReviewCents: underReview,
      amountUnderReviewText: underReview === null ? "Unknown amount" : formatCents(underReview),
      recoveredCents: verifiedRefund,
      recoveredText: formatCents(verifiedRefund),
      evidenceSnapshotVersion: rec.evidenceSnapshotVersion,
      origin: rec.origin,
      originNote: rec.originNote,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    },
    subscription: {
      id: subscription.id,
      label: subscription.label,
      merchantAlias: subscription.merchantAlias,
      amountText: subscription.amountCents !== null ? formatCents(subscription.amountCents) : null,
      providerRefs: refView(ctx, subscription.providerRefs),
      providerStatus: subscription.providerStatus,
      providerStatusObservedAt: subscription.providerStatusObservedAt,
      cancellation: {
        ...subscription.cancellation,
        basisLabel: BASIS_LABEL[subscription.cancellation.basis ?? ""] ?? "Not recorded",
        providerMandateProvenance: subscription.cancellation.providerMandateProvenance ?? null,
        providerMandateNextBillingAt:
          subscription.cancellation.providerMandateNextBillingAt ?? null,
        evidenceIds: subscription.cancellation.evidenceIds.filter((id) =>
          visible.some((e) => e.id === id),
        ),
      },
      billingWatch: billingWatch(ctx, subscription.cancellation),
      paymentsReadable:
        ctx.config.mode === "sandbox" &&
        role === "buyer" &&
        subscription.providerRefs.some(
          (r) => r.kind === "subscription_id" && r.provenance === "sandbox_api",
        ),
    },
    relatedCases: relatedCases(ctx, rec.id, subscription.id),
    charge: {
      id: charge.id,
      description: charge.description,
      status: charge.status,
      amountText: charge.amountCents !== null ? formatCents(charge.amountCents) : null,
      refundedText: charge.refundedCents !== null ? formatCents(charge.refundedCents) : null,
      refundStateKnown: charge.refundStateKnown,
      eventTime: charge.eventTime,
      postedTime: charge.postedTime,
      ingestedTime: charge.ingestedTime,
      servicePeriodStart: charge.servicePeriodStart,
      servicePeriodEnd: charge.servicePeriodEnd,
      matchMethod: charge.matchMethod,
      providerRefs: refView(ctx, charge.providerRefs),
    },
    provider: obs
      ? {
          disputeId: maskForRecording(ctx, obs.disputeId, obs.provenance),
          provenance: obs.provenance,
          status: obs.status,
          stage: obs.stage,
          outcome: obs.outcome,
          reason: obs.reason,
          sellerResponseDueAt: obs.sellerResponseDueAt,
          requestedEvidenceTypes: obs.requestedEvidenceTypes,
          evidenceTypeToSend: pickEvidenceType(
            obs.requestedEvidenceTypes,
            refundVerified(charge),
            cancellationDetailsIncluded(
              bundle,
              draftRepo.latest(ctx.db, caseId, "merchant", "merchant_provide_evidence"),
            ),
          ),
          allowedActions: obs.allowedActions,
          observedAt: obs.observedAt,
          enumsUnderstood: obs.enumsUnderstood,
          stale: obs.stale,
          evidenceCapability: providerCapability,
          toolkitCrossCheck: lastToolkitCrossCheck(ctx, caseId),
          testControls: sandboxTestControls(ctx, obs.disputeId),
        }
      : null,
    evidence: visible.map((e) => ({
      id: e.id,
      label: e.label,
      kind: e.kind,
      ownerRole: e.ownerRole,
      visibility: e.visibility,
      provenance: e.provenance,
      mime: e.mime,
      sizeBytes: e.sizeBytes,
      sha256Short: e.sha256 ? e.sha256.slice(0, 12) : null,
      capturedAt: e.capturedAt,
      eventTime: e.eventTime,
      hasFile: Boolean(e.storageName),
      textExcerpt: e.textExcerpt,
      factCount: e.facts.length,
    })),
    sources: snapshot.sources.map((src) => ({
      id: src.id,
      label: src.label,
      kind: src.kind,
      provenance: src.provenance,
      visibility: src.visibility,
      hasFile: src.sha256 !== null,
    })),
    evidenceLimits: EVIDENCE_LIMITS,
    contactHistory: snapshot.contactHistory.map((c) => ({
      id: c.id,
      at: c.at,
      direction: c.direction,
      summary: c.summary,
      shared: c.visibleTo.length > 1,
    })),
    drafts,
    approvals,
    operations: ops,
    availableActions: actionsForRole,
    readiness: Object.fromEntries(
      actionsForRole.map((action) => {
        const r = actionReadiness(ctx, bundle, role, action);
        return [
          action,
          {
            generate: r.generate,
            approve: r.approve,
            submit: r.submit,
            reviewPending: r.reviewPending,
          },
        ];
      }),
    ),
    timeline,
    gaps: snapshot.gaps,
    audit: audit
      .listForCase(ctx.db, caseId, 200)
      .filter((a) => isAuditVisibleTo(a, role))
      .slice(0, 40)
      .map((a) => ({ at: a.at, action: a.action, reasonCode: a.reasonCode, role: a.role })),
    demoHints: readDemoHints(ctx),
    serverTime: ctx.clock.now().toISOString(),
  };
}

/**
 * Audit entries a role may see: its own activity plus deliberately shared system events
 * (reconciliation, provider and subscription read-backs, claim changes, case lifecycle).
 * The other role's drafting, approvals, operations and denials stay private to that role.
 */
const SHARED_SYSTEM_EVENTS = [
  /^case\.reconciled$/,
  /^case\.deleted$/,
  /^provider\./,
  /^subscription\./,
  /^claim\./,
  /^setup\.case_created$/,
  /^setup\.dispute_imported$/,
];

export function isAuditVisibleTo(
  entry: { role: Role | null; action: string },
  role: Role,
): boolean {
  if (entry.role === role) return true;
  if (entry.role !== null) return false;
  return SHARED_SYSTEM_EVENTS.some((re) => re.test(entry.action));
}

/**
 * The provider's plan to bill next, when it conflicts with a confirmed cancellation: the mandate
 * is observed as active and the planned time is after the cancellation takes effect. Nothing is
 * inferred about a payment; only a provider read can show one.
 */
function billingWatch(
  ctx: AppContext,
  cancellation: CaseBundle["subscription"]["cancellation"],
): CaseView["subscription"]["billingWatch"] {
  const next = cancellation.providerMandateNextBillingAt ?? null;
  if (
    cancellation.state !== "CANCEL_CONFIRMED" ||
    !cancellation.effectiveAt ||
    cancellation.providerMandateStatus !== "ACTIVE" ||
    !next ||
    compareInstants(next, cancellation.effectiveAt) !== "after"
  )
    return null;
  return {
    nextBillingAt: next,
    observedAt: cancellation.providerMandateObservedAt,
    provenance: cancellation.providerMandateProvenance ?? null,
    due: compareInstants(next, ctx.clock.now().toISOString()) !== "after",
  };
}

function relatedCases(
  ctx: AppContext,
  caseId: string,
  subscriptionId: string,
): CaseView["relatedCases"] {
  return cases
    .list(ctx.db)
    .filter((c) => c.subscriptionId === subscriptionId && c.id !== caseId)
    .map((c) => {
      const charge = charges.get(ctx.db, c.chargeId);
      return {
        id: c.id,
        eventTime: charge?.eventTime ?? null,
        amountText: charge && charge.amountCents !== null ? formatCents(charge.amountCents) : null,
        status: charge?.status ?? "UNKNOWN",
        classification: c.classification,
        classificationTitle: CLASSIFICATION_TEXT[c.classification].title,
      };
    })
    .sort((a, b) => (a.eventTime ?? "9999").localeCompare(b.eventTime ?? "9999"));
}

/** Which adapter a channel would really use in this mode: the fixture adapter only simulates. */
export function channelAdapter(
  channel: Parameters<typeof describeChannel>[0],
  mode: "fixture" | "sandbox",
): "connected" | "simulated" | "export_only" {
  if (!describeChannel(channel).connected) return "export_only";
  return mode === "sandbox" ? "connected" : "simulated";
}

export function listCaseSummaries(ctx: AppContext, role: Role) {
  return cases.list(ctx.db).map((c) => {
    const charge = charges.get(ctx.db, c.chargeId);
    const amountUnderReviewCents = c.claimableCents ?? charge?.amountCents ?? null;
    return {
      id: c.id,
      buyerAlias: c.buyerAlias,
      merchantAlias: c.merchantAlias,
      subscriptionLabel: subscriptions.get(ctx.db, c.subscriptionId)?.label ?? null,
      classification: c.classification,
      classificationTitle: CLASSIFICATION_TEXT[c.classification].title,
      channel: c.channel,
      roleState: role === "buyer" ? c.buyerState : c.merchantState,
      claimableText: c.claimableCents !== null ? formatCents(c.claimableCents) : null,
      amountUnderReviewCents,
      chargeTime: charge?.eventTime ?? null,
      updatedAt: c.updatedAt,
    };
  });
}

export type CaseBundleForView = CaseBundle;

function lastToolkitCrossCheck(ctx: AppContext, caseId: string) {
  const entry = audit
    .listForCase(ctx.db, caseId, 100)
    .find(
      (a) =>
        a.action === "provider.refreshed" &&
        a.details &&
        typeof a.details === "object" &&
        (a.details as { toolkitCrossCheck?: unknown }).toolkitCrossCheck,
    );
  if (!entry) return null;
  const c = (
    entry.details as {
      toolkitCrossCheck: {
        ok: boolean;
        status: string | null;
        agrees: boolean | null;
        note: string;
      };
    }
  ).toolkitCrossCheck;
  return { ...c, at: entry.at };
}
