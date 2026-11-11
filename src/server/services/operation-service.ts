import type { AppContext } from "../context";
import {
  approvals as approvalRepo,
  cases,
  claims as claimRepo,
  drafts as draftRepo,
  evidence as evidenceRepo,
  operations as operationRepo,
} from "../db/repos";
import type { CaseRecord, OperationRecord, RecoveryDecision } from "../records";
import { newId } from "../ids";
import { logAudit } from "./audit";
import { AppError } from "./errors";
import {
  applyWorkflow,
  assertActionAllowedForRole,
  bumpSnapshot,
  computeApprovalContext,
  requireBundle,
  toChargeFacts,
  toSubscriptionFacts,
} from "./case-service";
import { buildOutwardSnapshot, buildRoleSnapshot, type CaseBundle } from "./snapshot";
import {
  currentMaterialFingerprint,
  isProviderEvidenceMime,
  providerNoteExceedsLimit,
  PROVIDER_NOTE_LENGTH_MESSAGE,
  type ActionPayload,
} from "./payloads";
import { EvidenceError, readEvidenceBytes } from "./evidence-store";
import { writeExportFile } from "./export-store";
import type { ExportedAttachment, ExportedMaterial } from "./export-download";
import { buildEvidencePack, renderEvidencePackMarkdown } from "@/domain/evidence-pack";
import { checkApproval, providerMaterial } from "@/domain/approval";
import { actionOpensClaim } from "@/domain/channels";
import {
  assertNoClaimForCharge,
  openClaimForOperation,
  releaseClaimForOperation,
  releaseClaimOnProviderResolution,
} from "./claim-service";
import { canProvideEvidence, enumsUnderstood, mergeObservation } from "@/domain/provider-state";
import { syncChargeFromTransactions } from "./charge-sync";
import { reconcile } from "@/domain/reconcile";
import { addMinutes } from "@/domain/time";
import type { ActionKind, ProviderObservation, Role, WorkflowEvent } from "@/domain/types";
import { canTransition } from "@/domain/workflow";
import { PROVIDER_WRITE_ACTIONS } from "@/domain/types";
import type { EvidenceAttachment, WriteOutcome } from "@/paypal/adapter";
import { isAcceptableBuyerReference } from "@/paypal/sandbox-adapter";
import { sha256Hex } from "@/domain/canonical";
import { sanitizeFilename } from "./evidence-store";

/**
 * Operation ledger and dispatcher.
 *
 * prepare():  in one SQLite transaction, re-check the approval against the *current* binding,
 *             reserve a unique logical operation and consume the approval. A second click, tab
 *             or graph resume finds the existing operation and never creates another.
 * dispatch(): acquire the single DISPATCHING reservation, re-verify facts and attachment bytes,
 *             re-read provider state for provider writes, then call the adapter exactly once.
 *             Ambiguous results become UNKNOWN and are never resent automatically.
 * recover():  read back what can be read back and record the human recovery decision.
 */

export const DISPATCH_LEASE_MINUTES = 2;

export function logicalKey(
  env: string,
  caseId: string,
  role: Role,
  action: ActionKind,
  approvalId: string,
): string {
  return `${env}:${caseId}:${role}:${action}:${approvalId}`;
}

export interface SubmitResult {
  operation: OperationRecord;
  created: boolean;
}

export function prepareOperation(
  ctx: AppContext,
  input: {
    caseId: string;
    role: Role;
    action: ActionKind;
    approvalId: string;
    simulate?: "timeout" | "unsupported" | null;
  },
): SubmitResult {
  assertActionAllowedForRole(input.role, input.action);
  const approval = approvalRepo.get(ctx.db, input.approvalId);
  if (
    !approval ||
    approval.caseId !== input.caseId ||
    approval.role !== input.role ||
    approval.action !== input.action
  ) {
    logAudit(ctx, {
      action: "operation.denied",
      role: input.role,
      caseId: input.caseId,
      approvalId: input.approvalId,
      reasonCode: "APPROVAL_MISMATCH",
    });
    throw new AppError("APPROVAL_MISMATCH", "No approval matches this case, role and action.", 403);
  }
  if (!approval.draftId) throw new AppError("APPROVAL_MISMATCH", "The approval has no draft.", 409);
  if (approval.consumedByOperationId) {
    const existing = operationRepo.get(ctx.db, approval.consumedByOperationId);
    if (existing) return { operation: existing, created: false };
  }
  const { bundle, binding, payload, attachmentHashes } = computeApprovalContext(
    ctx,
    input.caseId,
    input.role,
    input.action,
    approval.draftId,
  );
  if (providerNoteExceedsLimit(payload))
    throw new AppError("PROVIDER_NOTE_TOO_LONG", PROVIDER_NOTE_LENGTH_MESSAGE, 409);
  const check = checkApproval(approval, binding, ctx.clock);
  if (!check.valid) {
    logAudit(ctx, {
      action: "operation.denied",
      role: input.role,
      caseId: input.caseId,
      approvalId: approval.id,
      reasonCode: check.codes.join(","),
      details: { bindingFingerprint: approval.fingerprint },
    });
    throw new AppError(
      "APPROVAL_INVALID",
      `The approval cannot be used: ${check.codes.join(", ")}.`,
      409,
      { codes: check.codes },
    );
  }
  if (approval.materialFingerprint !== currentMaterialFingerprint(bundle)) {
    approvalRepo.revokeOpenForCase(
      ctx.db,
      input.caseId,
      input.role,
      input.action,
      "material_facts_changed",
    );
    logAudit(ctx, {
      action: "operation.denied",
      role: input.role,
      caseId: input.caseId,
      approvalId: approval.id,
      reasonCode: "MATERIAL_CHANGED",
    });
    throw new AppError(
      "MATERIAL_CHANGED",
      "Case facts changed after approval; review the draft again.",
      409,
    );
  }

  const opensClaim = actionOpensClaim(input.action);
  if (opensClaim) {
    try {
      assertNoClaimForCharge(ctx, bundle);
    } catch (err) {
      logAudit(ctx, {
        action: "operation.denied",
        role: input.role,
        caseId: input.caseId,
        approvalId: approval.id,
        reasonCode: "CLAIM_ALREADY_ACTIVE",
      });
      throw err;
    }
  }

  const now = ctx.clock.now().toISOString();
  const key = logicalKey(ctx.config.mode, input.caseId, input.role, input.action, approval.id);
  const txn = ctx.db.transaction((): SubmitResult => {
    const existing = operationRepo.getByLogicalKey(ctx.db, key);
    if (existing) return { operation: existing, created: false };
    const op: OperationRecord = {
      id: newId(ctx.config.mode, "op"),
      logicalKey: key,
      environment: ctx.config.mode,
      caseId: input.caseId,
      role: input.role,
      action: input.action,
      resourceId: input.caseId,
      payload: { ...payload, simulate: input.simulate ?? null },
      payloadHash: binding.payloadHash,
      payloadVersion: binding.payloadVersion,
      attachmentHashes,
      approvalId: approval.id,
      status: "PREPARED",
      attempts: 0,
      leaseUntil: null,
      providerRequestId: null,
      result: null,
      errorCode: null,
      errorMessage: null,
      recoveryDecision: null,
      recoveryNote: null,
      createdAt: now,
      updatedAt: now,
    };
    operationRepo.insert(ctx.db, op);
    const consumed = approvalRepo.consume(ctx.db, approval.id, op.id, now);
    if (!consumed)
      throw new AppError(
        "APPROVAL_INVALID",
        "The approval was consumed, revoked or expired concurrently.",
        409,
      );
    // The claim slot is taken in the same transaction as the operation: if another attempt
    // already holds it, the whole reservation (operation and approval consumption) rolls back.
    if (
      opensClaim &&
      !claimRepo.reserve(ctx.db, {
        chargeId: bundle.charge.id,
        environment: ctx.config.mode,
        caseId: input.caseId,
        channel: bundle.caseRecord.channel,
        state: "RESERVED",
        operationId: op.id,
        providerRef: null,
        openedAt: now,
        updatedAt: now,
      })
    ) {
      throw new AppError(
        "CLAIM_ALREADY_ACTIVE",
        "Another claim for this charge was reserved concurrently; nothing was prepared.",
        409,
      );
    }
    return { operation: op, created: true };
  });
  const result = txn();
  if (result.created) {
    logAudit(ctx, {
      action: "operation.prepared",
      role: input.role,
      caseId: input.caseId,
      operationId: result.operation.id,
      approvalId: approval.id,
      details: {
        actionKind: input.action,
        payloadHash: binding.payloadHash,
        providerWrite: PROVIDER_WRITE_ACTIONS.includes(input.action),
      },
    });
  }
  return result;
}

function finish(
  ctx: AppContext,
  op: OperationRecord,
  patch: Partial<OperationRecord>,
): OperationRecord {
  const updated: OperationRecord = {
    ...op,
    ...patch,
    leaseUntil: null,
    updatedAt: ctx.clock.now().toISOString(),
  };
  operationRepo.update(ctx.db, updated);
  logAudit(ctx, {
    action: `operation.${updated.status.toLowerCase()}`,
    role: op.role,
    caseId: op.caseId,
    operationId: op.id,
    approvalId: op.approvalId,
    reasonCode: updated.errorCode,
    details: {
      actionKind: op.action,
      correlationId: (updated.result as { correlationId?: string } | null)?.correlationId ?? null,
    },
  });
  return updated;
}

function roleState(rec: CaseRecord, role: Role) {
  return role === "buyer" ? rec.buyerState : rec.merchantState;
}

export async function dispatchOperation(
  ctx: AppContext,
  operationId: string,
): Promise<OperationRecord> {
  const op = operationRepo.get(ctx.db, operationId);
  if (!op) throw new AppError("OPERATION_NOT_FOUND", "Operation not found.", 404);
  if (op.status !== "PREPARED") return op; // idempotent: never dispatch twice
  const now = ctx.clock.now().toISOString();
  const acquired = operationRepo.acquireDispatch(
    ctx.db,
    op.id,
    addMinutes(now, DISPATCH_LEASE_MINUTES),
    now,
  );
  if (!acquired) return operationRepo.get(ctx.db, op.id) ?? op;
  let current = operationRepo.get(ctx.db, op.id)!;
  let bundle = requireBundle(ctx, op.caseId);
  const startedFrom = roleState(bundle.caseRecord, op.role);
  if (startedFrom === "AWAITING_APPROVAL") {
    bundle = {
      ...bundle,
      caseRecord: applyWorkflow(ctx, bundle.caseRecord, op.role, { type: "DISPATCH_STARTED" }),
    };
  }

  // Every fail() below happens before the adapter is called: nothing was sent, so a claim
  // reservation held by this operation is released in the same step.
  const fail = (code: string, message: string): OperationRecord => {
    const failed = ctx.db.transaction(() => {
      const f = finish(ctx, current, {
        status: "FAILED",
        errorCode: code,
        errorMessage: message,
      });
      if (actionOpensClaim(op.action))
        releaseClaimForOperation(ctx, bundle.charge.id, op.id, op.caseId, `NOT_SENT_${code}`);
      return f;
    })();
    const rec = cases.get(ctx.db, op.caseId);
    if (rec && roleState(rec, op.role) === "EXECUTING")
      applyWorkflow(ctx, rec, op.role, { type: "DISPATCH_FAILED", reason: code });
    return failed;
  };

  if (startedFrom !== "AWAITING_APPROVAL")
    return fail(
      "REVIEW_STATE_CHANGED",
      `The review is no longer awaiting this approval (local state ${startedFrom}); nothing was sent.`,
    );
  const approval = current.approvalId ? approvalRepo.get(ctx.db, current.approvalId) : null;
  if (!approval || approval.consumedByOperationId !== current.id)
    return fail("APPROVAL_NOT_BOUND", "The operation is not bound to a consumed approval.");
  const payload = current.payload as ActionPayload & {
    simulate?: "timeout" | "unsupported" | null;
  };

  /**
   * Is the approved content still exactly what would be sent? Checked before any provider
   * read and again immediately before the write, because the facts, the draft or the files can
   * change while an asynchronous preflight read is in progress.
   */
  const verifyApproved = (
    phase: "dispatch" | "preflight",
  ): { code: string; message: string } | { attachments: EvidenceAttachment[] } => {
    if (providerNoteExceedsLimit(payload))
      return { code: "PROVIDER_NOTE_TOO_LONG", message: PROVIDER_NOTE_LENGTH_MESSAGE };
    const fresh = requireBundle(ctx, op.caseId);
    const prefix = phase === "preflight" ? "PREFLIGHT_" : "";
    if (ctx.clock.now().toISOString() >= approval.expiresAt)
      return {
        code: "APPROVAL_EXPIRED",
        message: "The approval expired before dispatch; approve again.",
      };
    const latest = draftRepo.latest(ctx.db, op.caseId, op.role, op.action);
    if (!latest || latest.id !== payload.draftId)
      return {
        code: `${prefix}DRAFT_CHANGED`,
        message: "A newer version of the draft exists; the approved version was not sent.",
      };
    if (approval.materialFingerprint !== currentMaterialFingerprint(fresh))
      return {
        code: `${prefix}MATERIAL_CHANGED`,
        message: "Case facts changed after approval; review the draft again.",
      };
    let files: EvidenceAttachment[];
    try {
      files = loadAttachments(ctx, fresh, op.role, payload);
    } catch (err) {
      return {
        code:
          err instanceof AppError
            ? err.code
            : err instanceof EvidenceError
              ? `ATTACHMENT_${err.code}`
              : "ATTACHMENT_ERROR",
        message: err instanceof Error ? err.message : "Attachment verification failed.",
      };
    }
    const hashes = files.map((a) => a.sha256).sort();
    if (JSON.stringify(hashes) !== JSON.stringify([...current.attachmentHashes].sort()))
      return {
        code: "ATTACHMENT_CHANGED",
        message: "Attachment bytes differ from the approved attachments.",
      };
    bundle = fresh;
    return { attachments: files };
  };

  const first = verifyApproved("dispatch");
  if ("code" in first) return fail(first.code, first.message);

  // Local export: no provider involved.
  if (payload.kind === "export_refund_request") {
    const exported = writeExport(ctx, bundle, op.role, current, payload, first.attachments);
    current = finish(ctx, current, { status: "SUCCEEDED", result: exported });
    current = settleWorkflow(ctx, current, { type: "DISPATCH_SUCCEEDED" });
    return current;
  }

  // Provider writes: re-read and re-validate immediately before the call.
  const simulate = payload.simulate ?? null;
  const writeCtx = {
    operationId: current.id,
    requestId: `cc-${sha256Hex(current.id).slice(0, 24)}`,
    simulate,
  };
  let outcome: WriteOutcome<unknown>;
  if (payload.kind === "buyer_create_dispute") {
    const reservation = claimRepo.get(ctx.db, bundle.charge.id);
    if (!reservation || reservation.state !== "RESERVED" || reservation.operationId !== op.id)
      return fail(
        "CLAIM_NOT_RESERVED",
        "This operation does not hold the claim reservation for the charge; nothing was sent.",
      );
    if (bundle.caseRecord.channel !== "paypal")
      return fail(
        "CHANNEL_MISMATCH",
        "The case channel is not PayPal; transfer the channel with a reason first.",
      );
    const recon = reconcile(toSubscriptionFacts(bundle.subscription), toChargeFacts(bundle.charge));
    if (recon.classification !== "CANDIDATE_AFTER_CANCEL" || recon.claimableCents === null)
      return fail(
        "NOT_EXECUTABLE",
        `Reconciliation is ${recon.classification}${recon.claimableCents === null ? " with an unknown claimable amount" : ""}; execution is blocked.`,
      );
    if (payload.disputeAmountCents <= 0 || payload.disputeAmountCents > recon.claimableCents)
      return fail(
        "AMOUNT_OUT_OF_RANGE",
        "The requested amount exceeds the remaining claimable amount.",
      );
    if (!payload.buyerTransactionId)
      return fail(
        "MISSING_TRANSACTION_REFERENCE",
        "No buyer transaction reference is recorded for this charge.",
      );
    if (
      ctx.config.mode === "sandbox" &&
      !isAcceptableBuyerReference(payload.buyerTransactionId, payload.buyerTransactionProvenance)
    ) {
      return fail(
        "SYNTHETIC_REFERENCE_REJECTED",
        "The buyer transaction reference is not a provider observation or an operator-recorded PayPal transaction ID.",
      );
    }
    const preflight = await preflightBuyerFacts(ctx, bundle);
    if (preflight) return fail(preflight.code, preflight.message);
    const last = verifyApproved("preflight");
    if ("code" in last) return fail(last.code, last.message);
    outcome = await ctx.adapter.createBuyerDispute(payload, writeCtx);
  } else if (payload.kind === "merchant_provide_evidence") {
    if (!payload.disputeId)
      return fail("NO_PROVIDER_CASE", "No provider case is attached to this charge.");
    const read = await ctx.adapter.getDispute(payload.disputeId);
    if (!read.ok)
      return fail(
        `READBACK_${read.error.code}`,
        `Could not re-read the case before submission: ${read.error.message}`,
      );
    if (read.data.observation.disputeId !== payload.disputeId)
      return fail(
        "PREFLIGHT_RESOURCE_MISMATCH",
        "The provider read returned a different case; nothing was sent.",
      );
    const applied = applyObservation(ctx, op.caseId, read.data.observation, {
      correlationId: read.correlationId,
      toolkitCrossCheck: read.data.summary.toolkitCrossCheck,
    });
    const capability = canProvideEvidence(applied.observation, op.role, ctx.clock, {
      requireRealProvider: ctx.config.mode === "sandbox",
    });
    if (!capability.allowed || simulate === "unsupported") {
      const codes = simulate === "unsupported" ? ["ACTION_LINK_MISSING"] : capability.codes;
      return fail(
        "CAPABILITY_BLOCKED",
        `The case does not currently accept this submission: ${codes.join(", ")}.`,
      );
    }
    // New requested evidence, a new deadline or any other material change after approval
    // needs a fresh review of the response; nothing is sent.
    const last = verifyApproved("preflight");
    if ("code" in last) return fail(last.code, last.message);
    outcome = await ctx.adapter.provideEvidence(payload, last.attachments, writeCtx);
  } else {
    return fail("UNSUPPORTED_ACTION", "This action has no dispatcher.");
  }

  if (outcome.kind === "succeeded") {
    const disputeId =
      payload.kind === "buyer_create_dispute"
        ? (outcome.result as { disputeId: string; status: string | null }).disputeId
        : null;
    // The provider accepted the write: persist the result and canonical references first, in
    // one transaction, before any fallible local bookkeeping.
    current = ctx.db.transaction(() => {
      const done = finish(ctx, current, {
        status: "SUCCEEDED",
        result: {
          ...(outcome.result as object),
          provenance: outcome.provenance,
          correlationId: outcome.correlationId,
        },
        providerRequestId: outcome.providerRequestId,
      });
      if (payload.kind === "buyer_create_dispute") {
        openClaimForOperation(ctx, {
          chargeId: bundle.charge.id,
          caseId: op.caseId,
          operationId: op.id,
          providerRef: disputeId,
        });
        // Keep the minimal provider reference with the result, so a failed first read-back can
        // be retried with Refresh later. Recovery never creates the case again.
        const rec = cases.get(ctx.db, op.caseId);
        if (rec && disputeId && rec.providerObservation?.disputeId !== disputeId)
          persistObservation(
            ctx,
            rec,
            minimalReference(
              disputeId,
              outcome.provenance,
              (outcome.result as { status: string | null }).status ?? null,
              payload.reason,
              ctx.clock.now().toISOString(),
            ),
          );
      }
      return done;
    })();
    current = settleWorkflow(ctx, current, { type: "DISPATCH_SUCCEEDED" });
    try {
      await refreshProviderObservation(ctx, op.caseId, disputeId);
    } catch (err) {
      logAudit(ctx, {
        action: "provider.refresh_failed",
        caseId: op.caseId,
        operationId: op.id,
        reasonCode: "READBACK_EXCEPTION",
        details: { message: err instanceof Error ? err.message.slice(0, 200) : "error" },
      });
    }
  } else if (outcome.kind === "failed") {
    // A definitive provider failure: the request was not applied, so the claim slot is freed.
    current = ctx.db.transaction(() => {
      const f = finish(ctx, current, {
        status: "FAILED",
        errorCode: outcome.error.code,
        errorMessage: outcome.error.message,
        result: {
          correlationId: outcome.error.correlationId,
          httpStatus: outcome.error.httpStatus,
        },
      });
      if (actionOpensClaim(op.action))
        releaseClaimForOperation(ctx, bundle.charge.id, op.id, op.caseId, "PROVIDER_REJECTED");
      return f;
    })();
    current = settleWorkflow(ctx, current, {
      type: "DISPATCH_FAILED",
      reason: outcome.error.code,
    });
  } else {
    // UNKNOWN keeps the reservation: the request may have been applied.
    current = finish(ctx, current, {
      status: "UNKNOWN",
      errorCode: outcome.error.code,
      errorMessage: outcome.error.message,
      result: { correlationId: outcome.error.correlationId, httpStatus: outcome.error.httpStatus },
    });
    current = settleWorkflow(ctx, current, { type: "DISPATCH_UNKNOWN" });
  }
  return current;
}

/**
 * Record the local workflow consequence of a settled operation. The operation result is already
 * persisted; if the role's local state no longer allows the transition (for example it was moved
 * by a concurrent action), the mismatch is recorded explicitly on the operation and in the audit
 * instead of throwing — a local bookkeeping problem must never make a provider result look failed
 * or retryable. Pre-send transitions keep using applyWorkflow, which throws on invalid states.
 */
function settleWorkflow(
  ctx: AppContext,
  op: OperationRecord,
  event: Extract<
    WorkflowEvent,
    { type: "DISPATCH_SUCCEEDED" | "DISPATCH_FAILED" | "DISPATCH_UNKNOWN" }
  >,
): OperationRecord {
  const rec = cases.get(ctx.db, op.caseId);
  if (!rec) return op;
  const state = roleState(rec, op.role);
  if (canTransition(state, event.type)) {
    applyWorkflow(ctx, rec, op.role, event);
    return op;
  }
  const note = `Local workflow was ${state} when the ${op.status} result arrived; the result is saved and the local state was left unchanged.`;
  const updated: OperationRecord = {
    ...op,
    result: { ...((op.result as object | null) ?? {}), localStateIssue: note },
    updatedAt: ctx.clock.now().toISOString(),
  };
  operationRepo.update(ctx.db, updated);
  logAudit(ctx, {
    action: "workflow.local_state_mismatch",
    role: op.role,
    caseId: op.caseId,
    operationId: op.id,
    reasonCode: event.type,
    details: { state, operationStatus: op.status },
  });
  return updated;
}

/** The reference saved from a create response: identifier only, stale until the first read. */
function minimalReference(
  disputeId: string,
  provenance: ProviderObservation["provenance"],
  status: string | null,
  reason: string | null,
  at: string,
): ProviderObservation {
  return {
    disputeId,
    provenance,
    status,
    stage: null,
    outcome: null,
    reason,
    sellerResponseDueAt: null,
    requestedEvidenceTypes: [],
    allowedActions: [],
    observedVersion: 0,
    observedAt: at,
    enumsUnderstood: enumsUnderstood(status, null),
    stale: true,
  };
}

/** The provider case created by this case's last successful create operation, if any. */
function createdDisputeId(ctx: AppContext, caseId: string): string | null {
  const created = operationRepo
    .listForCase(ctx.db, caseId)
    .filter((o) => o.action === "buyer_create_dispute" && o.status === "SUCCEEDED")
    .map((o) => (o.result as { disputeId?: unknown } | null)?.disputeId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return created.at(-1) ?? null;
}

/**
 * Buyer case creation needs the current payment and refund facts. Fixture mode simulates them.
 * In Sandbox mode the subscription transaction is read again right before the request: a read
 * failure or a missing reference blocks the request, and changed facts are applied to the case
 * so the final approval check sees them (and stops). Returns a blocker or null.
 */
async function preflightBuyerFacts(
  ctx: AppContext,
  bundle: CaseBundle,
): Promise<{ code: string; message: string } | null> {
  if (ctx.config.mode !== "sandbox") return null;
  const subRef = bundle.subscription.providerRefs.find((r) => r.kind === "subscription_id");
  const saleRef = bundle.charge.providerRefs.find((r) => r.kind === "subscription_sale_id");
  if (!subRef || !saleRef)
    return {
      code: "PAYMENT_FACTS_UNAVAILABLE",
      message:
        "The current payment and refund state of this charge cannot be read here (no provider subscription transaction reference). Export the request or use the PayPal site instead; nothing was sent.",
    };
  const end = ctx.clock.now();
  const since = bundle.charge.eventTime ? Date.parse(bundle.charge.eventTime) : NaN;
  const start = new Date(
    Number.isFinite(since)
      ? Math.min(since - 2 * 86_400_000, end.getTime() - 86_400_000)
      : end.getTime() - 90 * 86_400_000,
  );
  const read = await ctx.adapter.listSubscriptionTransactions(
    subRef.value,
    start.toISOString(),
    end.toISOString(),
  );
  if (!read.ok)
    return {
      code: "PREFLIGHT_READ_FAILED",
      message: `Could not re-read the payment before creating the case (${read.error.code}); nothing was sent.`,
    };
  if (!read.data.some((t) => t.id === saleRef.value))
    return {
      code: "PAYMENT_NOT_FOUND",
      message:
        "The recorded payment was not in the provider's transaction list for this subscription; nothing was sent.",
    };
  syncChargeFromTransactions(ctx, bundle.caseRecord.id, read.data, read.provenance, "preflight");
  return null;
}

function loadAttachments(
  ctx: AppContext,
  bundle: CaseBundle,
  role: Role,
  payload: ActionPayload,
): EvidenceAttachment[] {
  const ids = payload.kind === "buyer_create_dispute" ? [] : payload.attachmentEvidenceIds;
  const draft = draftRepo.get(ctx.db, payload.draftId);
  const snapshot = buildOutwardSnapshot(
    buildRoleSnapshot(ctx, bundle, role),
    draft?.content.privateSourceIdsIncluded ?? [],
  );
  const visible = new Set(snapshot.sources.map((s) => s.id));
  return ids.map((id) => {
    if (!visible.has(id))
      throw new AppError(
        "ATTACHMENT_NOT_DISCLOSED",
        `Attachment ${id} is not visible to the ${role} role or not selected for disclosure.`,
        403,
      );
    const rec = evidenceRepo.get(ctx.db, id);
    if (!rec || !rec.storageName || !rec.mime)
      throw new AppError("ATTACHMENT_NOT_A_FILE", `Attachment ${id} has no file.`, 409);
    if (payload.kind === "merchant_provide_evidence" && !isProviderEvidenceMime(rec.mime))
      throw new AppError(
        "ATTACHMENT_TYPE_NOT_ACCEPTED",
        `Attachment ${id} is not a PDF, PNG or JPEG file; the provider does not accept it as evidence.`,
        409,
      );
    const bytes = readEvidenceBytes(ctx, rec);
    const ext = rec.storageName.split(".").pop() ?? "bin";
    return {
      evidenceId: id,
      filename: sanitizeFilename(`${rec.kind}-${id}.${ext}`),
      mime: rec.mime,
      sha256: sha256Hex(bytes),
      bytes,
    };
  });
}

function writeExport(
  ctx: AppContext,
  bundle: CaseBundle,
  role: Role,
  op: OperationRecord,
  payload: Extract<ActionPayload, { kind: "export_refund_request" }>,
  approvedAttachments: EvidenceAttachment[],
) {
  const draft = draftRepo.get(ctx.db, payload.draftId);
  const roleSnapshot = buildRoleSnapshot(ctx, bundle, role);
  // Recipient-facing bundle: only what the approved draft discloses. The complete role view is
  // written separately as a clearly labelled local archive that is not meant to be sent.
  const outward = buildOutwardSnapshot(roleSnapshot, draft?.content.privateSourceIdsIncluded ?? []);
  const attached = new Set(payload.attachmentEvidenceIds);
  const generatedAt = ctx.clock.now().toISOString();
  const common = {
    generatedAt,
    buyerAlias: bundle.caseRecord.buyerAlias,
    merchantAlias: bundle.caseRecord.merchantAlias,
    subscriptionLabel: bundle.subscription.label,
    modeLabel: ctx.config.mode === "fixture" ? "Fixture (synthetic)" : "Sandbox (connected)",
    providerCase: {
      id: bundle.caseRecord.providerObservation?.disputeId ?? null,
      status: bundle.caseRecord.providerObservation?.status ?? null,
      stage: bundle.caseRecord.providerObservation?.stage ?? null,
      observedAt: bundle.caseRecord.providerObservation?.observedAt ?? null,
      provenance: bundle.caseRecord.providerObservation?.provenance ?? null,
    },
    draft: draft ? { version: draft.version, hash: draft.contentHash, origin: draft.origin } : null,
    remedyText:
      payload.requestedCents !== null
        ? `Refund of the charge made after the effective cancellation (requested amount recorded in section 5).`
        : "Review of the charge made after the effective cancellation.",
  };
  const recipientPack = buildEvidencePack({
    ...common,
    audience: "recipient",
    snapshot: outward,
    attachedSourceIds: Array.from(attached),
    actions: [],
  });
  const archivePack = buildEvidencePack({
    ...common,
    audience: "local_archive",
    snapshot: roleSnapshot,
    attachedSourceIds: Array.from(attached),
    actions: operationRepo
      .listForCase(ctx.db, bundle.caseRecord.id)
      .filter((o) => o.role === role)
      .map((o) => ({
        operationId: o.id,
        action: o.action,
        status: o.status,
        approvalId: o.approvalId,
        at: o.updatedAt,
      })),
  });
  const files = {
    message: `${op.id}-refund-request.md`,
    packJson: `${op.id}-evidence-pack.json`,
    packMarkdown: `${op.id}-evidence-pack.md`,
    localArchive: `archive/${op.id}-local-archive.json`,
  };
  const caseId = bundle.caseRecord.id;
  const stored = {
    message: writeExportFile(ctx, caseId, files.message, payload.renderedText),
    packMarkdown: writeExportFile(
      ctx,
      caseId,
      files.packMarkdown,
      renderEvidencePackMarkdown(recipientPack),
    ),
    packJson: writeExportFile(ctx, caseId, files.packJson, JSON.stringify(recipientPack, null, 2)),
  };
  writeExportFile(ctx, caseId, files.localArchive, JSON.stringify(archivePack, null, 2));
  // What a later download is checked against: the files of this approval, by hash. The
  // attachments are the ones verified against the approval a moment ago, not a fresh selection.
  const recipientMaterials: ExportedMaterial[] = [
    { key: "message", filename: files.message, mime: "text/markdown", ...stored.message },
    {
      key: "pack-md",
      filename: files.packMarkdown,
      mime: "text/markdown",
      ...stored.packMarkdown,
    },
    { key: "pack-json", filename: files.packJson, mime: "application/json", ...stored.packJson },
  ];
  const attachments: ExportedAttachment[] = approvedAttachments.map((a) => ({
    evidenceId: a.evidenceId,
    filename: a.filename,
    mime: a.mime,
    sha256: a.sha256,
    sizeBytes: a.bytes.length,
  }));
  return {
    exported: true as const,
    provenance: "synthetic" as const,
    files,
    recipientFiles: [files.message, files.packJson, files.packMarkdown],
    recipientMaterials,
    attachments,
    draftVersion: payload.draftVersion,
    draftHash: payload.draftHash,
    packHash: recipientPack.packHash,
    note: "Exported locally. Nothing was sent; you send the message and the recipient pack yourself. The local archive stays with you.",
  };
}

export function persistObservation(
  ctx: AppContext,
  rec: CaseRecord,
  observation: ProviderObservation,
): CaseRecord {
  const updated: CaseRecord = {
    ...rec,
    providerObservation: observation,
    updatedAt: ctx.clock.now().toISOString(),
  };
  cases.update(ctx.db, updated);
  return updated;
}

/** Re-read the provider case. Never regresses on older snapshots; marks stale on failure. */
export async function refreshProviderObservation(
  ctx: AppContext,
  caseId: string,
  disputeId: string | null,
): Promise<{ observation: ProviderObservation | null; error: string | null }> {
  const rec = cases.get(ctx.db, caseId);
  if (!rec) throw new AppError("CASE_NOT_FOUND", "Case not found.", 404);
  const id = disputeId ?? rec.providerObservation?.disputeId ?? createdDisputeId(ctx, caseId);
  if (!id)
    return {
      observation: rec.providerObservation,
      error: "No provider case reference to refresh.",
    };
  const read = await ctx.adapter.getDispute(id);
  if (!read.ok) {
    // The attached resource may have changed while the read was in flight. A failure for the
    // previous dispute must neither restore its snapshot nor mark the replacement stale.
    const latest = cases.get(ctx.db, caseId);
    if (!latest) throw new AppError("CASE_NOT_FOUND", "Case not found.", 404);
    if (latest.providerObservation?.disputeId && latest.providerObservation.disputeId !== id) {
      logAudit(ctx, {
        action: "provider.observation_ignored",
        caseId,
        reasonCode: "ignored_other_resource",
      });
      return { observation: latest.providerObservation, error: read.error.message };
    }
    const stale = latest.providerObservation
      ? { ...latest.providerObservation, stale: true }
      : null;
    if (stale) persistObservation(ctx, latest, stale);
    logAudit(ctx, {
      action: "provider.refresh_failed",
      caseId,
      reasonCode: read.error.code,
      details: { correlationId: read.error.correlationId, httpStatus: read.error.httpStatus },
    });
    return { observation: stale, error: read.error.message };
  }
  const applied = applyObservation(ctx, caseId, read.data.observation, {
    correlationId: read.correlationId,
    toolkitCrossCheck: read.data.summary.toolkitCrossCheck,
  });
  return { observation: applied.observation, error: null };
}

/**
 * Merge a provider read into the case: never regress on older snapshots, release the claim
 * when the provider reports the case resolved, and start a new review when anything an
 * approval binds changed (status, stage, capabilities, requested evidence, deadline, outcome).
 * A read that only moves the observation time changes nothing material.
 */
export function applyObservation(
  ctx: AppContext,
  caseId: string,
  incoming: ProviderObservation,
  meta: { correlationId: string | null; toolkitCrossCheck: unknown },
): { observation: ProviderObservation; materialChanged: boolean } {
  const rec = cases.get(ctx.db, caseId);
  if (!rec) throw new AppError("CASE_NOT_FOUND", "Case not found.", 404);
  const before = rec.providerObservation;
  const merged = mergeObservation(before, incoming);
  if (merged.kind === "ignored_other_resource") {
    logAudit(ctx, { action: "provider.observation_ignored", caseId, reasonCode: merged.kind });
    return { observation: merged.observation, materialChanged: false };
  }
  persistObservation(ctx, rec, merged.observation);
  if (
    merged.kind === "applied" &&
    merged.observation.status === "RESOLVED" &&
    merged.observation.disputeId
  ) {
    releaseClaimOnProviderResolution(ctx, {
      chargeId: rec.chargeId,
      caseId,
      providerRef: merged.observation.disputeId,
      status: merged.observation.status,
    });
  }
  logAudit(ctx, {
    action: "provider.refreshed",
    caseId,
    reasonCode: merged.kind,
    details: {
      status: merged.observation.status,
      stage: merged.observation.stage,
      allowedActions: merged.observation.allowedActions,
      provenance: merged.observation.provenance,
      correlationId: meta.correlationId,
      toolkitCrossCheck: meta.toolkitCrossCheck,
    },
  });
  const materialChanged =
    JSON.stringify(providerMaterial(before ?? null)) !==
    JSON.stringify(providerMaterial(merged.observation));
  if (materialChanged) bumpSnapshot(ctx, cases.get(ctx.db, caseId)!, "provider_state_changed");
  return { observation: merged.observation, materialChanged };
}

/**
 * On startup or before listing:
 *  - a DISPATCHING operation whose lease expired becomes UNKNOWN (never resent; it keeps any
 *    claim reservation because the request may have been applied);
 *  - a PREPARED operation whose approval expired was verifiably never dispatched (the dispatch
 *    reservation was never acquired), so it fails and frees its claim reservation.
 */
export function sweepExpiredLeases(ctx: AppContext): OperationRecord[] {
  const now = ctx.clock.now().toISOString();
  const swept: OperationRecord[] = [];
  for (const op of operationRepo.listByStatus(ctx.db, "PREPARED")) {
    const approval = op.approvalId ? approvalRepo.get(ctx.db, op.approvalId) : null;
    if (approval && approval.expiresAt > now) continue;
    const rec = cases.get(ctx.db, op.caseId);
    const failed = ctx.db.transaction(() => {
      const f = finish(ctx, op, {
        status: "FAILED",
        errorCode: "NEVER_DISPATCHED",
        errorMessage:
          "The approval expired before this prepared operation was dispatched; nothing was sent.",
      });
      if (rec && actionOpensClaim(op.action))
        releaseClaimForOperation(ctx, rec.chargeId, op.id, op.caseId, "NEVER_DISPATCHED");
      return f;
    })();
    swept.push(failed);
  }
  for (const op of operationRepo.listByStatus(ctx.db, "DISPATCHING")) {
    if (op.leaseUntil && op.leaseUntil < now) {
      const updated = finish(ctx, op, {
        status: "UNKNOWN",
        errorCode: "LEASE_EXPIRED",
        errorMessage: "The process stopped while dispatching; the provider result is unknown.",
      });
      const rec = cases.get(ctx.db, op.caseId);
      if (rec && roleState(rec, op.role) === "EXECUTING")
        applyWorkflow(ctx, rec, op.role, { type: "DISPATCH_UNKNOWN" });
      swept.push(updated);
    }
  }
  return swept;
}

interface RecoveryReadbackSummary {
  at: string;
  readOk: boolean;
  candidateCount: number | null;
  candidateDisputeId: string | null;
  /** True only when the list read was known to hold every case of its query */
  listComplete?: boolean;
  /** True when the list was narrowed to this operation's transaction */
  filteredByTransaction?: boolean;
}

/**
 * The read-back and the recovery decision below understand the three case actions only. A
 * Sandbox setup or test-control operation has another payload and, for setup, no case at all;
 * treating it as a case action would describe it wrongly and could change the ledger before
 * failing. It is refused here, before anything is read or written.
 */
const CASE_RECOVERY_ACTIONS: readonly string[] = [
  "export_refund_request",
  "buyer_create_dispute",
  "merchant_provide_evidence",
];

function assertCaseRecovery(op: OperationRecord): void {
  if (CASE_RECOVERY_ACTIONS.includes(op.action)) return;
  throw new AppError(
    "RECOVERY_NOT_SUPPORTED",
    "This is a Sandbox setup or test-control operation. The case recovery steps do not cover it, so nothing was read, recorded or changed; it stays UNKNOWN.",
    409,
  );
}

export interface RecoveryReadback {
  operationId: string;
  findings: string[];
  candidateDisputeId: string | null;
  canAutoConfirm: false;
}

/** Gather read-back evidence for an UNKNOWN operation. It informs a human decision; it never resends. */
export async function readBackForRecovery(
  ctx: AppContext,
  operationId: string,
): Promise<RecoveryReadback> {
  const op = operationRepo.get(ctx.db, operationId);
  if (!op) throw new AppError("OPERATION_NOT_FOUND", "Operation not found.", 404);
  if (op.status !== "UNKNOWN")
    throw new AppError("NOT_UNKNOWN", "Only UNKNOWN operations have a recovery read-back.", 409);
  assertCaseRecovery(op);
  const payload = op.payload as ActionPayload;
  const findings: string[] = [];
  let candidateDisputeId: string | null = null;
  let candidateCount: number | null = null;
  let readOk = false;
  let listComplete: boolean | undefined;
  let filteredByTransaction: boolean | undefined;
  if (payload.kind === "buyer_create_dispute") {
    // A reference the buyer typed in is not sent as a filter: PayPal may know the payment by
    // another ID, and a filter that matches nothing would look like "no case".
    filteredByTransaction = payload.buyerTransactionProvenance === "sandbox_api";
    const list = await ctx.adapter.listDisputes({
      pageSize: 20,
      disputedTransactionId: filteredByTransaction ? payload.buyerTransactionId : undefined,
    });
    if (!list.ok) {
      findings.push(`Read-back failed: ${list.error.message}`);
    } else {
      readOk = true;
      const matches = list.data.items.filter(
        (d) =>
          d.reason === payload.reason &&
          d.amountValue === (payload.disputeAmountCents / 100).toFixed(2) &&
          (d.createTime ?? "") >= op.createdAt,
      );
      candidateCount = matches.length;
      listComplete = list.data.complete;
      if (matches.length === 1) {
        candidateDisputeId = matches[0]!.disputeId;
        findings.push(
          `Read-back found one case created after this operation with the same reason and amount (status ${matches[0]!.status ?? "unknown"}). This is consistent with success but does not prove this exact request created it.`,
        );
      } else if (matches.length > 1) {
        findings.push(
          `Read-back found ${matches.length} candidate cases; a human must identify the right one.`,
        );
      } else {
        const read = list.data.items.length;
        findings.push(
          list.data.complete
            ? `Read-back listed ${read} case(s)${filteredByTransaction ? " for this transaction" : ""} and none matches this operation.`
            : `Read-back could read only ${read} of ${list.data.total ?? "an unknown number of"} case(s), and none of those matches this operation.`,
        );
        findings.push(
          "That does not show the request was not applied: a new case can take time to appear, and a list can miss it. The operation stays unknown and keeps its claim on this charge, so no second case can be created. If the case appears, record success with its case ID; until then, keep it for manual review.",
        );
      }
    }
  } else if (payload.kind === "merchant_provide_evidence") {
    const read = await ctx.adapter.getDispute(payload.disputeId);
    if (!read.ok) findings.push(`Read-back failed: ${read.error.message}`);
    else {
      readOk = true;
      findings.push(
        `Case status is now ${read.data.observation.status ?? "unknown"} (stage ${read.data.observation.stage ?? "unknown"}); evidence count ${read.data.summary.evidenceCount ?? "unknown"}.`,
      );
      findings.push(
        "A changed status or evidence count is not proof that this exact payload was received; confirm against the provider's case view before recording success.",
      );
    }
  } else {
    // Only a local export reaches this branch (see assertCaseRecovery).
    findings.push("Local export operations do not need provider read-back.");
  }
  const at = ctx.clock.now().toISOString();
  operationRepo.update(ctx.db, {
    ...op,
    result: {
      ...((op.result as object | null) ?? {}),
      recoveryReadback: {
        at,
        readOk,
        candidateCount,
        candidateDisputeId,
        listComplete,
        filteredByTransaction,
      },
    },
    updatedAt: at,
  });
  logAudit(ctx, {
    action: "operation.recovery_readback",
    role: op.role,
    caseId: op.caseId,
    operationId: op.id,
    details: { findings, candidateCount, readOk },
  });
  return { operationId: op.id, findings, candidateDisputeId, canAutoConfirm: false };
}

export async function resolveUnknownOperation(
  ctx: AppContext,
  input: {
    operationId: string;
    decision: RecoveryDecision;
    note: string;
    disputeId?: string | null;
  },
): Promise<OperationRecord> {
  const op = operationRepo.get(ctx.db, input.operationId);
  if (!op) throw new AppError("OPERATION_NOT_FOUND", "Operation not found.", 404);
  if (op.status !== "UNKNOWN")
    throw new AppError(
      "NOT_UNKNOWN",
      "Only UNKNOWN operations can receive a recovery decision.",
      409,
    );
  assertCaseRecovery(op);
  if (!input.note.trim())
    throw new AppError("NOTE_REQUIRED", "Record why you reached this decision.");
  const rec = cases.get(ctx.db, op.caseId)!;
  const opensClaim = actionOpensClaim(op.action);
  const readback = (op.result as { recoveryReadback?: RecoveryReadbackSummary } | null)
    ?.recoveryReadback;
  const disputeId = input.disputeId?.trim() || null;
  if (input.decision === "confirmed_succeeded" && opensClaim) {
    if (!disputeId || !/^[A-Za-z0-9-]{4,64}$/.test(disputeId))
      throw new AppError(
        "DISPUTE_ID_REQUIRED",
        "Confirming success of a case creation needs the provider case ID you verified; otherwise record needs_manual_review.",
        400,
      );
  }
  if (input.decision === "confirmed_failed" && opensClaim) {
    // Recording a failure would release the claim on the charge and allow a second case. No
    // read-back proves that the first request was not applied: a failed read, a partial page,
    // a filter that matches nothing and even a complete empty list all leave room for a case
    // that exists or appears later. So a case creation is never recorded as failed from here;
    // it stays UNKNOWN, with its claim, until a case is found and success is recorded.
    throw new AppError(
      "RECOVERY_EVIDENCE_REQUIRED",
      readback && readback.readOk && (readback.candidateCount ?? 0) > 0
        ? "Read-back found a case that may have been created by this request; it cannot be recorded as failed."
        : "A case creation cannot be recorded as failed: a read-back that shows no case does not prove PayPal did not create one, and releasing the claim could open a second case for the same charge. Keep it for manual review; if the case appears, record success with its case ID.",
      409,
    );
  }
  let updated: OperationRecord;
  if (input.decision === "confirmed_succeeded") {
    updated = ctx.db.transaction(() => {
      const done = finish(ctx, op, {
        status: "SUCCEEDED",
        recoveryDecision: input.decision,
        recoveryNote: input.note,
        result: {
          ...(op.result as object | null),
          recoveredByHuman: true,
          disputeId,
        },
      });
      if (opensClaim) {
        openClaimForOperation(ctx, {
          chargeId: rec.chargeId,
          caseId: op.caseId,
          operationId: op.id,
          providerRef: disputeId,
        });
        const latest = cases.get(ctx.db, op.caseId);
        if (latest && disputeId && latest.providerObservation?.disputeId !== disputeId)
          persistObservation(
            ctx,
            latest,
            minimalReference(
              disputeId,
              op.environment === "fixture" ? "synthetic" : "sandbox_api",
              null,
              (op.payload as { reason?: string }).reason ?? null,
              ctx.clock.now().toISOString(),
            ),
          );
      }
      return done;
    })();
    applyWorkflow(ctx, cases.get(ctx.db, op.caseId)!, op.role, {
      type: "RECOVERY_CONFIRMED_SUCCESS",
    });
    await refreshProviderObservation(ctx, op.caseId, opensClaim ? disputeId : null);
  } else if (input.decision === "confirmed_failed") {
    updated = ctx.db.transaction(() => {
      const f = finish(ctx, op, {
        status: "FAILED",
        recoveryDecision: input.decision,
        recoveryNote: input.note,
        errorCode: op.errorCode ?? "RECOVERY_CONFIRMED_FAILED",
      });
      if (opensClaim)
        releaseClaimForOperation(ctx, rec.chargeId, op.id, op.caseId, "RECOVERY_CONFIRMED_FAILED");
      return f;
    })();
    applyWorkflow(ctx, rec, op.role, {
      type: "RECOVERY_CONFIRMED_FAILURE",
      reason: "human_recovery",
    });
  } else {
    updated = {
      ...op,
      recoveryDecision: input.decision,
      recoveryNote: input.note,
      updatedAt: ctx.clock.now().toISOString(),
    };
    operationRepo.update(ctx.db, updated);
  }
  logAudit(ctx, {
    action: "operation.recovery_decision",
    role: op.role,
    caseId: op.caseId,
    operationId: op.id,
    reasonCode: input.decision,
    details: { note: input.note.slice(0, 300) },
  });
  return updated;
}
