import type { AppContext } from "../context";
import {
  approvals as approvalRepo,
  drafts as draftRepo,
  operations as operationRepo,
} from "../db/repos";
import type { DraftRecord } from "../records";
import { claimForCharge } from "./claim-service";
import type { CaseBundle } from "./snapshot";
import { canProvideEvidence } from "@/domain/provider-state";
import { isExpired } from "@/domain/time";
import type { ActionKind, Role, WorkflowState } from "@/domain/types";
import { PROVIDER_NOTE_LENGTH_MESSAGE, PROVIDER_NOTE_MAX_LENGTH } from "./payloads";

/**
 * Action readiness: one place that decides whether a role can generate, approve or submit an
 * action right now, and why not. The services enforce it, the graph relies on the services,
 * and the view renders the same reasons, so the buttons, the API and the dispatcher agree.
 * Dispatch still re-checks everything authoritatively immediately before any write.
 *
 * The three state systems stay separate: cancellation facts and reconciliation (classification),
 * the local workflow (role state) and the provider observation are inputs, not merged here.
 */

export interface Blocker {
  code: string;
  message: string;
}

export interface ActionReadiness {
  action: ActionKind;
  generate: Blocker | null;
  approve: Blocker | null;
  submit: Blocker | null;
  /** The latest draft's content hash, which an approval must name exactly */
  draftId: string | null;
  draftHash: string | null;
  /** A review is pending for the latest draft */
  reviewPending: boolean;
}

const REVIEW_STATES: readonly WorkflowState[] = ["READY_FOR_REVIEW", "AWAITING_APPROVAL"];

function roleState(bundle: CaseBundle, role: Role): WorkflowState {
  return role === "buyer" ? bundle.caseRecord.buyerState : bundle.caseRecord.merchantState;
}

export function reviewIsPending(bundle: CaseBundle, role: Role): boolean {
  return REVIEW_STATES.includes(roleState(bundle, role));
}

/** Preconditions shared by generation, approval and submission. */
function actionBlocker(
  ctx: AppContext,
  bundle: CaseBundle,
  role: Role,
  action: ActionKind,
): Blocker | null {
  const state = roleState(bundle, role);
  if (state === "EXECUTING" || state === "UNKNOWN")
    return {
      code: "IN_FLIGHT",
      message:
        state === "UNKNOWN"
          ? "The last submission has an unknown result. Read it back and record a recovery decision first."
          : "An operation is executing.",
    };
  const unsettled = operationRepo
    .listForCase(ctx.db, bundle.caseRecord.id)
    .some(
      (o) =>
        o.role === role &&
        o.action === action &&
        (o.status === "PREPARED" || o.status === "DISPATCHING" || o.status === "UNKNOWN"),
    );
  if (unsettled)
    return {
      code: "IN_FLIGHT",
      message: "An earlier submission of this action is not settled yet.",
    };
  if (role === "buyer" && bundle.caseRecord.classification !== "CANDIDATE_AFTER_CANCEL")
    return {
      code: "NOT_A_CANDIDATE",
      message: `Drafting needs a reviewed candidate anomaly first (current classification: ${bundle.caseRecord.classification.replace(/_/g, " ").toLowerCase()}).`,
    };
  if (action === "buyer_create_dispute") {
    if (bundle.caseRecord.channel !== "paypal")
      return {
        code: "CHANNEL_NOT_PAYPAL",
        message: "Choose the PayPal channel (with a reason) before preparing a PayPal case.",
      };
    const claim = claimForCharge(ctx, bundle.charge.id);
    if (claim)
      return {
        code: "CLAIM_ALREADY_ACTIVE",
        message:
          claim.state === "OPEN"
            ? "A provider case is already open for this charge; a second claim is not allowed."
            : "A claim for this charge is reserved by an unsettled submission.",
      };
  }
  if (action === "merchant_provide_evidence" && !bundle.caseRecord.providerObservation?.disputeId)
    return {
      code: "NO_PROVIDER_CASE",
      message:
        "No provider case is attached to this charge yet, so there is nothing to respond to.",
    };
  return null;
}

/** Merchant-only: does the current provider observation accept evidence? */
function capabilityBlocker(ctx: AppContext, bundle: CaseBundle, role: Role, action: ActionKind) {
  if (action !== "merchant_provide_evidence") return null;
  const capability = canProvideEvidence(bundle.caseRecord.providerObservation, role, ctx.clock, {
    requireRealProvider: ctx.config.mode === "sandbox",
  });
  if (capability.allowed) return null;
  return {
    code: "CAPABILITY_BLOCKED",
    message: `The provider case does not accept evidence right now (${capability.codes.join(", ")}). Refresh the case; you can still prepare the response.`,
  };
}

export function draftBlocker(draft: DraftRecord | null, bundle: CaseBundle): Blocker | null {
  if (!draft) return { code: "NO_DRAFT", message: "Generate a draft first." };
  if (!draft.validation.ok)
    return { code: "DRAFT_INVALID", message: "The draft has blocking validation issues." };
  if (
    draft.action !== "export_refund_request" &&
    draft.renderedText.length > PROVIDER_NOTE_MAX_LENGTH
  )
    return { code: "PROVIDER_NOTE_TOO_LONG", message: PROVIDER_NOTE_LENGTH_MESSAGE };
  if (draft.snapshotVersion !== bundle.caseRecord.evidenceSnapshotVersion)
    return {
      code: "DRAFT_STALE",
      message: "Facts changed after this draft was produced; regenerate it.",
    };
  return null;
}

export function actionReadiness(
  ctx: AppContext,
  bundle: CaseBundle,
  role: Role,
  action: ActionKind,
): ActionReadiness {
  const draft = draftRepo.latest(ctx.db, bundle.caseRecord.id, role, action);
  const common = actionBlocker(ctx, bundle, role, action);
  const reviewPending = reviewIsPending(bundle, role) && draft !== null;
  const approve =
    common ??
    draftBlocker(draft, bundle) ??
    (reviewPending
      ? null
      : {
          code: "REVIEW_NOT_PENDING",
          message:
            "No review is pending for this draft. Regenerate the draft to start a new review, then approve the new version.",
        }) ??
    capabilityBlocker(ctx, bundle, role, action);
  let submit: Blocker | null = approve;
  if (!submit) {
    const approval = draft ? approvalRepo.latestForDraft(ctx.db, draft.id) : null;
    if (!approval || approval.decision !== "approved")
      submit = { code: "NOT_APPROVED", message: "Approve this exact version before submitting." };
    else if (approval.revokedReason)
      submit = { code: "APPROVAL_REVOKED", message: "The approval was revoked; review again." };
    else if (approval.consumedByOperationId)
      submit = { code: "APPROVAL_USED", message: "This approval was already used." };
    else if (isExpired(approval.expiresAt, ctx.clock))
      submit = { code: "APPROVAL_EXPIRED", message: "The approval expired; approve again." };
  }
  return {
    action,
    generate: common,
    approve,
    submit,
    draftId: draft?.id ?? null,
    draftHash: draft?.contentHash ?? null,
    reviewPending,
  };
}
