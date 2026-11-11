import type { AppContext } from "../context";
import {
  approvals as approvalRepo,
  cases,
  charges,
  contacts,
  drafts as draftRepo,
  evidence as evidenceRepo,
  operations as operationRepo,
  subscriptions as subscriptionRepo,
} from "../db/repos";
import type {
  ApprovalRecord,
  CaseRecord,
  ChargeRecord,
  ContactEventRecord,
  DraftRecord,
  EvidenceRecord,
  SubscriptionRecord,
} from "../records";
import { newId } from "../ids";
import { logAudit } from "./audit";
import { AppError } from "./errors";
import {
  buildOutwardSnapshot,
  buildRoleSnapshot,
  loadCaseBundle,
  disclosureScope,
  referenceScope,
  transactionReference,
  type CaseBundle,
} from "./snapshot";
import {
  buildActionPayload,
  currentMaterialFingerprint,
  isProviderEvidenceMime,
  payloadHash,
} from "./payloads";
import { addEvidence, EVIDENCE_LIMITS, type AddEvidenceInput } from "./evidence-store";
import { reduceCancellation, type CancellationEvent } from "@/domain/cancellation";
import { reconcile } from "@/domain/reconcile";
import { transitionWorkflow, canTransition, isInFlight } from "@/domain/workflow";
import { validateDraft } from "@/domain/claims";
import { renderDraftText } from "@/domain/evidence-pack";
import { approvalExpiry, bindingFingerprint, type ApprovalBinding } from "@/domain/approval";
import { hashCanonical } from "@/domain/canonical";
import type {
  ActionKind,
  ChargeFacts,
  DraftContent,
  Role,
  SubscriptionFacts,
  WorkflowEvent,
  WorkflowState,
} from "@/domain/types";
import { PROVIDER_WRITE_ACTIONS } from "@/domain/types";
import { buildTemplateDraft } from "@/llm/fixture-drafter";
import { draftOriginLabel } from "@/llm/drafter";
import { claimForCharge } from "./claim-service";
import { actionReadiness } from "./readiness";

/* ------------------------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------------------- */

export function requireBundle(ctx: AppContext, caseId: string): CaseBundle {
  const bundle = loadCaseBundle(ctx, caseId);
  if (!bundle) throw new AppError("CASE_NOT_FOUND", `Case ${caseId} was not found.`, 404);
  if (bundle.caseRecord.environment !== ctx.config.mode) {
    throw new AppError(
      "ENVIRONMENT_MISMATCH",
      "This case belongs to a different environment.",
      409,
    );
  }
  return bundle;
}

function roleState(rec: CaseRecord, role: Role): WorkflowState {
  return role === "buyer" ? rec.buyerState : rec.merchantState;
}

function setRoleState(rec: CaseRecord, role: Role, state: WorkflowState): CaseRecord {
  return role === "buyer" ? { ...rec, buyerState: state } : { ...rec, merchantState: state };
}

export function applyWorkflow(
  ctx: AppContext,
  rec: CaseRecord,
  role: Role,
  event: WorkflowEvent,
): CaseRecord {
  const current = roleState(rec, role);
  const next = transitionWorkflow(current, event);
  const updated = setRoleState({ ...rec, updatedAt: ctx.clock.now().toISOString() }, role, next);
  cases.update(ctx.db, updated);
  logAudit(ctx, {
    action: `workflow.${event.type.toLowerCase()}`,
    role,
    caseId: rec.id,
    reasonCode: "reason" in event ? event.reason : null,
    details: { from: current, to: next },
  });
  return updated;
}

function tryWorkflow(
  ctx: AppContext,
  rec: CaseRecord,
  role: Role,
  event: WorkflowEvent,
): CaseRecord {
  return canTransition(roleState(rec, role), event.type)
    ? applyWorkflow(ctx, rec, role, event)
    : rec;
}

export function toSubscriptionFacts(sub: SubscriptionRecord): SubscriptionFacts {
  return {
    id: sub.id,
    environment: sub.environment,
    accountAlias: sub.accountAlias,
    merchantAlias: sub.merchantAlias,
    cancellation: sub.cancellation,
    sourceIds: sub.sourceIds,
  };
}

export function toChargeFacts(ch: ChargeRecord): ChargeFacts {
  return {
    id: ch.id,
    environment: ch.environment,
    accountAlias: ch.accountAlias,
    merchantAlias: ch.merchantAlias,
    subscriptionId: ch.subscriptionId,
    matchMethod: ch.matchMethod,
    eventTime: ch.eventTime,
    postedTime: ch.postedTime,
    ingestedTime: ch.ingestedTime,
    status: ch.status,
    amount: ch.amountCents === null ? null : { cents: ch.amountCents, currency: "USD" },
    refundedCents: ch.refundedCents,
    refundStateKnown: ch.refundStateKnown,
    currency: ch.currency,
    servicePeriodStart: ch.servicePeriodStart,
    servicePeriodEnd: ch.servicePeriodEnd,
    arrearsIndicator: ch.arrearsIndicator,
    sourceIds: ch.sourceIds,
  };
}

/** Any change in material facts: revoke open approvals and send reviewed drafts back to drafting. */
function invalidateReviews(ctx: AppContext, rec: CaseRecord, reason: string): CaseRecord {
  let updated = rec;
  for (const role of ["buyer", "merchant"] as const) {
    for (const action of [
      "export_refund_request",
      "buyer_create_dispute",
      "merchant_provide_evidence",
    ] as const) {
      const revoked = approvalRepo.revokeOpenForCase(ctx.db, rec.id, role, action, reason);
      if (revoked > 0)
        logAudit(ctx, {
          action: "approval.revoked",
          role,
          caseId: rec.id,
          reasonCode: reason,
          details: { count: revoked, actionKind: action },
        });
    }
    const state = roleState(updated, role);
    if (state === "READY_FOR_REVIEW" || state === "AWAITING_APPROVAL") {
      updated = applyWorkflow(ctx, updated, role, { type: "INVALIDATE", reason });
    }
  }
  return updated;
}

/** Material facts changed: new snapshot version, open approvals revoked, reviews sent back. */
export function bumpSnapshot(ctx: AppContext, rec: CaseRecord, reason: string): CaseRecord {
  const updated = {
    ...rec,
    evidenceSnapshotVersion: rec.evidenceSnapshotVersion + 1,
    updatedAt: ctx.clock.now().toISOString(),
  };
  cases.update(ctx.db, updated);
  return invalidateReviews(ctx, updated, reason);
}

/* ------------------------------------------------------------------------------------------
 * Cancellation and reconciliation
 * --------------------------------------------------------------------------------------- */

export function recordCancellation(
  ctx: AppContext,
  input: { caseId: string; role: Role; event: CancellationEvent },
): CaseBundle {
  if (input.role !== "buyer")
    throw new AppError(
      "ROLE_NOT_ALLOWED",
      "Only the buyer view records the buyer's cancellation facts.",
      403,
    );
  const bundle = requireBundle(ctx, input.caseId);
  assertManualCancellationEvidence(ctx, bundle, input.event);
  const before = bundle.subscription.cancellation;
  const after = reduceCancellation(before, input.event);
  // The cancellation is a fact about the subscription, so the documents it cites belong to the
  // subscription: every case of it (one per payment) sees them, and deleting one case keeps them
  // while another case of the subscription remains.
  let evidenceScopeChanged = false;
  for (const id of after.evidenceIds) {
    const promoted = ctx.db
      .prepare(
        "UPDATE evidence SET case_id = NULL WHERE id = ? AND subscription_id = ? AND case_id = ?",
      )
      .run(id, bundle.subscription.id, bundle.caseRecord.id);
    evidenceScopeChanged ||= promoted.changes > 0;
  }
  const subscription: SubscriptionRecord = {
    ...bundle.subscription,
    cancellation: after,
    updatedAt: ctx.clock.now().toISOString(),
  };
  subscriptionRepo.update(ctx.db, subscription);
  logAudit(ctx, {
    action: "cancellation.recorded",
    role: input.role,
    caseId: input.caseId,
    reasonCode: after.state,
    details: {
      eventType: input.event.type,
      from: before.state,
      to: after.state,
      reviewReasons: after.reviewReasons,
      basis: after.basis,
    },
  });
  // Every case of the subscription is reconciled against the new facts. The cancellation basis
  // and its evidence are part of what a reviewer approves, even when the reconciliation outcome
  // stays the same: any change starts a new review in each of those cases.
  const sharing = cases
    .list(ctx.db)
    .filter((c) => c.subscriptionId === bundle.subscription.id)
    .map((c) => c.id);
  for (const caseId of [input.caseId, ...sharing.filter((id) => id !== input.caseId)]) {
    const previous = requireBundle(ctx, caseId).caseRecord.evidenceSnapshotVersion;
    const reconciled = reconcileCase(ctx, caseId, "cancellation_recorded");
    if (
      (evidenceScopeChanged || cancellationMaterial(before) !== cancellationMaterial(after)) &&
      reconciled.caseRecord.evidenceSnapshotVersion === previous
    ) {
      bumpSnapshot(ctx, reconciled.caseRecord, "cancellation_facts_changed");
    }
  }
  return requireBundle(ctx, input.caseId);
}

/** Document kinds that can carry a merchant's cancellation confirmation. */
const CONFIRMATION_KINDS = new Set(["cancellation_confirmation", "communication", "screenshot"]);

/**
 * A manually recorded cancellation is a user attestation or a document the buyer kept. It may not
 * claim to be a provider observation, and every evidence reference must be a real evidence record
 * of this case that the buyer can see; a string from the browser is not proof. A merchant
 * confirmation document basis needs at least one confirmation-type document.
 */
function assertManualCancellationEvidence(
  ctx: AppContext,
  bundle: CaseBundle,
  event: CancellationEvent,
): void {
  if (event.type === "OBSERVE_PROVIDER_MANDATE" || event.type === "REOPEN_REVIEW") {
    if (event.type === "OBSERVE_PROVIDER_MANDATE")
      throw new AppError(
        "MANUAL_PROVENANCE_REJECTED",
        "Provider mandate observations come only from a provider read-back.",
        400,
      );
    return;
  }
  if (
    (event.type === "RECORD_CONFIRMATION" || event.type === "RESOLVE_REVIEW") &&
    event.basis === "provider_api_observation"
  )
    throw new AppError(
      "MANUAL_PROVENANCE_REJECTED",
      "A manually recorded cancellation cannot claim to be a provider observation. Record it as your attestation or as a merchant confirmation document.",
      400,
    );
  const ids = event.evidenceIds ?? [];
  const records = ids.map((id) => {
    const rec = evidenceRepo.get(ctx.db, id);
    const belongs =
      rec !== null &&
      (rec.caseId === bundle.caseRecord.id ||
        (rec.caseId === null && rec.subscriptionId === bundle.subscription.id));
    const visible = rec !== null && (rec.ownerRole === "buyer" || rec.visibility === "shared");
    if (!rec || !belongs || !visible)
      throw new AppError(
        "EVIDENCE_NOT_FOUND",
        `Evidence ${id} is not an evidence record of this case that the buyer can see.`,
        400,
      );
    return rec;
  });
  if (
    (event.type === "RECORD_CONFIRMATION" || event.type === "RESOLVE_REVIEW") &&
    event.basis === "merchant_confirmation_document" &&
    !records.some((r) => CONFIRMATION_KINDS.has(r.kind))
  )
    throw new AppError(
      "EVIDENCE_TYPE_REQUIRED",
      "A merchant confirmation basis needs at least one confirmation email, message or screenshot among the cited evidence.",
      400,
    );
}

function cancellationMaterial(c: SubscriptionRecord["cancellation"]): string {
  return hashCanonical({
    state: c.state,
    requestedAt: c.requestedAt,
    effectiveAt: c.effectiveAt,
    basis: c.basis,
    evidenceIds: [...c.evidenceIds].sort(),
  });
}

export function reconcileCase(ctx: AppContext, caseId: string, reason: string): CaseBundle {
  const bundle = requireBundle(ctx, caseId);
  const result = reconcile(toSubscriptionFacts(bundle.subscription), toChargeFacts(bundle.charge));
  const prev = bundle.caseRecord;
  const requested =
    result.claimableCents === null
      ? null
      : prev.requestedCents === null
        ? result.claimableCents
        : Math.min(prev.requestedCents, result.claimableCents);
  const materialChanged =
    prev.classification !== result.classification ||
    prev.claimableCents !== result.claimableCents ||
    prev.requestedCents !== requested ||
    JSON.stringify(prev.reasonCodes) !== JSON.stringify(result.reasonCodes);
  const updated: CaseRecord = {
    ...prev,
    classification: result.classification,
    reasonCodes: result.reasonCodes,
    claimableCents: result.claimableCents,
    requestedCents: requested,
    updatedAt: ctx.clock.now().toISOString(),
  };
  cases.update(ctx.db, updated);
  logAudit(ctx, {
    action: "case.reconciled",
    caseId,
    reasonCode: result.classification,
    details: {
      reasonCodes: result.reasonCodes,
      claimableCents: result.claimableCents,
      trigger: reason,
    },
  });
  if (materialChanged) bumpSnapshot(ctx, updated, `reconciliation:${reason}`);
  return requireBundle(ctx, caseId);
}

/* ------------------------------------------------------------------------------------------
 * Evidence and contact history
 * --------------------------------------------------------------------------------------- */

export function addCaseEvidence(
  ctx: AppContext,
  role: Role,
  input: Omit<AddEvidenceInput, "accountAlias" | "ownerRole" | "subscriptionId"> & {
    caseId: string;
  },
): EvidenceRecord {
  const bundle = requireBundle(ctx, input.caseId);
  const record = addEvidence(ctx, {
    ...input,
    accountAlias: bundle.caseRecord.accountAlias,
    ownerRole: role,
    subscriptionId: bundle.subscription.id,
    facts: input.facts.map((f) => ({
      ...f,
      visibleTo: input.visibility === "shared" ? ["buyer", "merchant"] : [role],
    })),
  });
  logAudit(ctx, {
    action: "evidence.added",
    role,
    caseId: input.caseId,
    details: {
      evidenceId: record.id,
      kind: record.kind,
      visibility: record.visibility,
      provenance: record.provenance,
      sha256: record.sha256,
    },
  });
  bumpSnapshot(ctx, bundle.caseRecord, "evidence_added");
  return record;
}

export function addContactEvent(
  ctx: AppContext,
  role: Role,
  input: {
    caseId: string;
    at: string;
    direction: ContactEventRecord["direction"];
    summary: string;
    sourceIds: string[];
    shared: boolean;
  },
): ContactEventRecord {
  const bundle = requireBundle(ctx, input.caseId);
  const record: ContactEventRecord = {
    id: newId(ctx.config.mode, "contact"),
    caseId: input.caseId,
    at: input.at,
    direction: input.direction,
    summary: input.summary.slice(0, 500),
    sourceIds: input.sourceIds,
    visibleTo: input.shared ? ["buyer", "merchant"] : [role],
    createdAt: ctx.clock.now().toISOString(),
  };
  contacts.insert(ctx.db, record);
  logAudit(ctx, {
    action: "contact.recorded",
    role,
    caseId: input.caseId,
    details: { direction: input.direction, shared: input.shared },
  });
  bumpSnapshot(ctx, bundle.caseRecord, "contact_recorded");
  return record;
}

export function setRequestedAmount(
  ctx: AppContext,
  role: Role,
  caseId: string,
  cents: number,
): CaseBundle {
  if (role !== "buyer")
    throw new AppError("ROLE_NOT_ALLOWED", "Only the buyer sets the requested amount.", 403);
  const bundle = requireBundle(ctx, caseId);
  const max = bundle.caseRecord.claimableCents;
  if (!Number.isInteger(cents) || cents <= 0)
    throw new AppError(
      "INVALID_AMOUNT",
      "Requested amount must be a positive integer number of cents.",
    );
  if (max === null)
    throw new AppError(
      "AMOUNT_NOT_COMPUTABLE",
      "The claimable amount is not known yet; refresh the charge facts first.",
      409,
    );
  if (cents > max)
    throw new AppError(
      "AMOUNT_EXCEEDS_CLAIMABLE",
      `Requested amount cannot exceed the remaining ${max} cents.`,
    );
  const updated = {
    ...bundle.caseRecord,
    requestedCents: cents,
    updatedAt: ctx.clock.now().toISOString(),
  };
  cases.update(ctx.db, updated);
  logAudit(ctx, { action: "case.requested_amount", role, caseId, details: { cents } });
  bumpSnapshot(ctx, updated, "requested_amount_changed");
  return requireBundle(ctx, caseId);
}

/* ------------------------------------------------------------------------------------------
 * Drafting
 * --------------------------------------------------------------------------------------- */

export function assertActionAllowedForRole(role: Role, action: ActionKind): void {
  const allowed: Record<Role, ActionKind[]> = {
    buyer: ["export_refund_request", "buyer_create_dispute"],
    merchant: ["merchant_provide_evidence"],
  };
  if (!allowed[role].includes(action))
    throw new AppError(
      "ACTION_NOT_ALLOWED_FOR_ROLE",
      `The ${role} role cannot perform ${action}.`,
      403,
    );
}

export interface DisclosureSelection {
  outward: ReturnType<typeof buildOutwardSnapshot>;
  includedPrivate: string[];
  attachments: string[];
}

/**
 * Work out what a draft may disclose. Shared sources are disclosable by default; a private
 * source only when the author owns it and included it explicitly. Attachments must be
 * file-backed and disclosed. With `strict`, an invalid explicit selection is an error instead
 * of being dropped silently.
 */
export function resolveDisclosure(
  ctx: AppContext,
  bundle: CaseBundle,
  role: Role,
  action: ActionKind,
  requestedPrivate: readonly string[],
  requestedAttachments: readonly string[] | null,
  options: { strict?: boolean } = {},
): DisclosureSelection {
  const roleSnapshot = buildRoleSnapshot(ctx, bundle, role);
  const ownPrivate = new Set(
    roleSnapshot.sources
      .filter((s) => s.visibility === "private" && s.ownerRole === role)
      .map((s) => s.id),
  );
  const invalidPrivate = requestedPrivate.filter((id) => !ownPrivate.has(id));
  if (options.strict && invalidPrivate.length > 0)
    throw new AppError(
      "DISCLOSURE_NOT_ALLOWED",
      `Only your own private sources can be included for disclosure (${invalidPrivate.join(", ")}).`,
      400,
    );
  const includedPrivate = Array.from(new Set(requestedPrivate.filter((id) => ownPrivate.has(id))));
  const outward = buildOutwardSnapshot(roleSnapshot, includedPrivate);
  // A provider evidence response can only carry file types the provider accepts; other files stay
  // citable sources and part of the export, but are not offered as documents to send.
  const sendable = (id: string) =>
    action !== "merchant_provide_evidence" ||
    isProviderEvidenceMime(evidenceRepo.get(ctx.db, id)?.mime);
  const files = new Set(outward.sources.filter((s) => s.sha256 && sendable(s.id)).map((s) => s.id));
  if (options.strict && requestedAttachments) {
    const unsendable = requestedAttachments.filter(
      (id) => outward.sources.some((s) => s.id === id && s.sha256) && !sendable(id),
    );
    if (unsendable.length > 0)
      throw new AppError(
        "ATTACHMENT_TYPE_NOT_ACCEPTED",
        `PayPal accepts PDF, PNG and JPEG evidence documents; ${unsendable.join(", ")} can be cited but not attached.`,
        400,
      );
  }
  const wanted =
    action === "buyer_create_dispute"
      ? []
      : requestedAttachments === null
        ? Array.from(files)
        : [...requestedAttachments];
  const invalidAttachments = wanted.filter((id) => !files.has(id));
  if (options.strict && invalidAttachments.length > 0)
    throw new AppError(
      "ATTACHMENT_NOT_DISCLOSED",
      `Attachments must be files selected for disclosure (${invalidAttachments.join(", ")}).`,
      400,
    );
  if (
    wanted.filter((id) => files.has(id)).length > EVIDENCE_LIMITS.maxFilesPerPack &&
    options.strict
  )
    throw new AppError(
      "PACK_TOO_MANY_FILES",
      `At most ${EVIDENCE_LIMITS.maxFilesPerPack} attachments can be sent together.`,
      400,
    );
  return {
    outward,
    includedPrivate,
    attachments: Array.from(new Set(wanted.filter((id) => files.has(id)))).slice(
      0,
      EVIDENCE_LIMITS.maxFilesPerPack,
    ),
  };
}

export async function generateDraft(
  ctx: AppContext,
  input: { caseId: string; role: Role; action: ActionKind; attachmentEvidenceIds?: string[] },
): Promise<DraftRecord> {
  assertActionAllowedForRole(input.role, input.action);
  let bundle = requireBundle(ctx, input.caseId);
  const blocked = actionReadiness(ctx, bundle, input.role, input.action).generate;
  if (blocked) throw new AppError(blocked.code, blocked.message, 409);
  // Only material authorized for disclosure reaches the drafter: shared sources plus any private
  // source the author explicitly included on the previous version (carried over on regenerate).
  const previous = draftRepo.latest(ctx.db, input.caseId, input.role, input.action);
  const disclosure = resolveDisclosure(
    ctx,
    bundle,
    input.role,
    input.action,
    previous?.content.privateSourceIdsIncluded ?? [],
    input.attachmentEvidenceIds ?? previous?.content.attachmentEvidenceIds ?? null,
  );
  const snapshot = disclosure.outward;
  const attachments = disclosure.attachments;

  bundle = {
    ...bundle,
    caseRecord: tryWorkflow(ctx, bundle.caseRecord, input.role, { type: "START_DRAFT" }),
  };

  let content: DraftContent;
  let origin: DraftRecord["origin"];
  const notes: string[] = [];
  const result = await ctx.drafter.draft({
    snapshot,
    action: input.action,
    role: input.role,
    attachmentEvidenceIds: attachments,
  });
  if (result.ok) {
    content = { ...result.content, privateSourceIdsIncluded: disclosure.includedPrivate };
    origin = result.origin;
    notes.push(...result.notes);
  } else {
    content = {
      ...buildTemplateDraft(snapshot, input.action, input.role, attachments),
      privateSourceIdsIncluded: disclosure.includedPrivate,
    };
    origin = "fixture_template";
    notes.push(
      `Connected model unavailable (${result.code}): ${result.message} A labelled template was used instead; no model output is included.`,
    );
    logAudit(ctx, {
      action: "draft.live_failed",
      role: input.role,
      caseId: input.caseId,
      reasonCode: result.code,
      details: { calls: result.calls },
    });
  }
  return persistDraft(
    ctx,
    bundle,
    input.role,
    input.action,
    content,
    origin,
    snapshot.version,
    notes,
  );
}

function persistDraft(
  ctx: AppContext,
  bundle: CaseBundle,
  role: Role,
  action: ActionKind,
  content: DraftContent,
  origin: DraftRecord["origin"],
  snapshotVersion: number,
  notes: string[],
): DraftRecord {
  const roleSnapshot = buildRoleSnapshot(ctx, bundle, role);
  const snapshot = buildOutwardSnapshot(roleSnapshot, content.privateSourceIdsIncluded ?? []);
  const validation = validateDraft(
    content,
    snapshot,
    role,
    disclosureScope(roleSnapshot, snapshot),
    referenceScope(bundle),
  );
  const recipient = role === "buyer" ? bundle.caseRecord.merchantAlias : "case reviewer";
  const sender = role === "buyer" ? bundle.caseRecord.buyerAlias : bundle.caseRecord.merchantAlias;
  const renderedText = renderDraftText(
    content,
    snapshot,
    recipient,
    sender,
    transactionReference(bundle, content),
  );
  const previous = draftRepo.latest(ctx.db, bundle.caseRecord.id, role, action);
  const record: DraftRecord = {
    id: newId(ctx.config.mode, "draft"),
    environment: ctx.config.mode,
    caseId: bundle.caseRecord.id,
    role,
    action,
    version: (previous?.version ?? 0) + 1,
    content,
    renderedText,
    // The hash identifies this version: identical text in another version is still a
    // different object to review and approve.
    contentHash: hashCanonical({ version: (previous?.version ?? 0) + 1, content, renderedText }),
    origin,
    // Neutral labels only: the configured service and model never enter stored drafts.
    providerLabel: draftOriginLabel(origin),
    modelLabel: null,
    validation: {
      ...validation,
      issues: [
        ...validation.issues,
        ...notes.map((n) => ({
          code: "NOTE" as const,
          claimId: null,
          message: n,
          blocking: false,
        })),
      ],
    },
    snapshotVersion,
    createdAt: ctx.clock.now().toISOString(),
  };
  // Notes are informational; they must not change the blocking verdict.
  record.validation.ok = validation.ok;
  draftRepo.insert(ctx.db, record);
  const revoked = approvalRepo.revokeOpenForCase(
    ctx.db,
    bundle.caseRecord.id,
    role,
    action,
    "draft_changed",
  );
  if (revoked > 0)
    logAudit(ctx, {
      action: "approval.revoked",
      role,
      caseId: bundle.caseRecord.id,
      reasonCode: "draft_changed",
      details: { count: revoked },
    });
  logAudit(ctx, {
    action: "draft.created",
    role,
    caseId: bundle.caseRecord.id,
    details: {
      draftId: record.id,
      version: record.version,
      origin,
      valid: validation.ok,
      issueCount: validation.issues.length,
    },
  });
  tryWorkflow(ctx, bundle.caseRecord, role, { type: "DRAFT_READY" });
  return record;
}

export function editDraft(
  ctx: AppContext,
  input: {
    caseId: string;
    role: Role;
    action: ActionKind;
    subject?: string;
    claims: { id: string; text: string }[];
    attachmentEvidenceIds?: string[];
    privateSourceIdsIncluded?: string[];
  },
): DraftRecord {
  assertActionAllowedForRole(input.role, input.action);
  let bundle = requireBundle(ctx, input.caseId);
  if (isInFlight(roleState(bundle.caseRecord, input.role)))
    throw new AppError("IN_FLIGHT", "An operation is executing or unresolved for this role.", 409);
  const previous = draftRepo.latest(ctx.db, input.caseId, input.role, input.action);
  if (!previous) throw new AppError("NO_DRAFT", "Generate a draft before editing it.", 409);
  const byId = new Map(input.claims.map((c) => [c.id, c.text]));
  const disclosure = resolveDisclosure(
    ctx,
    bundle,
    input.role,
    input.action,
    input.privateSourceIdsIncluded ?? previous.content.privateSourceIdsIncluded ?? [],
    input.attachmentEvidenceIds ?? previous.content.attachmentEvidenceIds,
    { strict: true },
  );
  const content: DraftContent = {
    ...previous.content,
    subject: (input.subject ?? previous.content.subject).slice(0, 200),
    claims: previous.content.claims.map((c) =>
      byId.has(c.id) ? { ...c, text: byId.get(c.id)!.slice(0, 1200) } : c,
    ),
    attachmentEvidenceIds: disclosure.attachments,
    privateSourceIdsIncluded: disclosure.includedPrivate,
  };
  bundle = {
    ...bundle,
    caseRecord: tryWorkflow(ctx, bundle.caseRecord, input.role, { type: "EDIT" }),
  };
  return persistDraft(
    ctx,
    bundle,
    input.role,
    input.action,
    content,
    "human_edit",
    bundle.caseRecord.evidenceSnapshotVersion,
    [],
  );
}

/* ------------------------------------------------------------------------------------------
 * Approvals
 * --------------------------------------------------------------------------------------- */

export interface ApprovalContext {
  bundle: CaseBundle;
  draft: DraftRecord;
  binding: ApprovalBinding;
  payload: ReturnType<typeof buildActionPayload>;
  attachmentHashes: string[];
}

export function computeApprovalContext(
  ctx: AppContext,
  caseId: string,
  role: Role,
  action: ActionKind,
  draftId: string,
): ApprovalContext {
  const bundle = requireBundle(ctx, caseId);
  const draft = draftRepo.get(ctx.db, draftId);
  if (!draft || draft.caseId !== caseId || draft.role !== role || draft.action !== action) {
    throw new AppError(
      "DRAFT_MISMATCH",
      "The draft does not belong to this case, role and action.",
      409,
    );
  }
  const latest = draftRepo.latest(ctx.db, caseId, role, action);
  if (!latest || latest.id !== draft.id)
    throw new AppError("DRAFT_STALE", "A newer draft exists; review the latest version.", 409);
  const payload = buildActionPayload(ctx, bundle, draft, role, action);
  const snapshot = buildOutwardSnapshot(
    buildRoleSnapshot(ctx, bundle, role),
    draft.content.privateSourceIdsIncluded ?? [],
  );
  const visible = new Set(snapshot.sources.map((s) => s.id));
  const attachmentIds =
    payload.kind === "buyer_create_dispute" ? [] : draft.content.attachmentEvidenceIds;
  if (attachmentIds.length > EVIDENCE_LIMITS.maxFilesPerPack) {
    throw new AppError(
      "PACK_TOO_MANY_FILES",
      `At most ${EVIDENCE_LIMITS.maxFilesPerPack} attachments can be submitted together.`,
      409,
    );
  }
  let packBytes = 0;
  const attachmentHashes = attachmentIds
    .map((id) => {
      if (!visible.has(id))
        throw new AppError(
          "ATTACHMENT_NOT_DISCLOSED",
          `Attachment ${id} is not visible to the ${role} role or not selected for disclosure.`,
          403,
        );
      const rec = evidenceRepo.get(ctx.db, id);
      if (!rec?.sha256)
        throw new AppError("ATTACHMENT_NOT_A_FILE", `Attachment ${id} has no file bytes.`, 409);
      packBytes += rec.sizeBytes ?? 0;
      return rec.sha256;
    })
    .sort();
  if (packBytes > EVIDENCE_LIMITS.maxTotalBytesPerPack) {
    throw new AppError(
      "PACK_TOO_LARGE",
      "The selected attachments exceed the 20 MB pack limit.",
      409,
    );
  }
  const binding: ApprovalBinding = {
    actor: ctx.actor,
    role,
    environment: ctx.config.mode,
    accountAlias: bundle.caseRecord.accountAlias,
    resourceId: caseId,
    action,
    payloadHash: payloadHash(payload),
    payloadVersion: draft.version,
    evidenceSnapshotVersion: bundle.caseRecord.evidenceSnapshotVersion,
    attachmentHashes,
  };
  return { bundle, draft, binding, payload, attachmentHashes };
}

export function decideApproval(
  ctx: AppContext,
  input: {
    caseId: string;
    role: Role;
    action: ActionKind;
    draftId: string;
    decision: "approved" | "rejected";
    reason?: string;
    /** Content hash of the version the person is looking at; required by the HTTP route */
    expectedContentHash?: string;
  },
): ApprovalRecord {
  assertActionAllowedForRole(input.role, input.action);
  const { bundle, draft, binding } = computeApprovalContext(
    ctx,
    input.caseId,
    input.role,
    input.action,
    input.draftId,
  );
  // The decision applies to exactly the version on screen: a newer or different version
  // (for example after an edit in another tab) needs its own review.
  if (input.expectedContentHash !== undefined && input.expectedContentHash !== draft.contentHash)
    throw new AppError(
      "DRAFT_CHANGED",
      "The draft changed since it was displayed. Review the current version before deciding.",
      409,
    );
  const readiness = actionReadiness(ctx, bundle, input.role, input.action);
  if (input.decision === "approved" && readiness.approve) {
    throw new AppError(
      readiness.approve.code,
      readiness.approve.message,
      409,
      readiness.approve.code === "DRAFT_INVALID" ? draft.validation.issues : null,
    );
  }
  if (input.decision === "rejected" && !readiness.reviewPending)
    throw new AppError(
      "REVIEW_NOT_PENDING",
      "There is no pending review to reject. Regenerate the draft to start a new review.",
      409,
    );
  const now = ctx.clock.now().toISOString();
  const record: ApprovalRecord = {
    id: newId(ctx.config.mode, "appr"),
    environment: ctx.config.mode,
    caseId: input.caseId,
    role: input.role,
    action: input.action,
    draftId: draft.id,
    fingerprint: bindingFingerprint(binding),
    binding,
    materialFingerprint: currentMaterialFingerprint(bundle),
    decision: input.decision,
    decidedAt: now,
    expiresAt: input.decision === "approved" ? approvalExpiry(now) : now,
    approver: ctx.actor,
    consumedByOperationId: null,
    revokedReason: null,
    createdAt: now,
  };
  // A new decision supersedes any older open approval for the same draft.
  approvalRepo.revokeOpenForCase(ctx.db, input.caseId, input.role, input.action, "superseded");
  approvalRepo.insert(ctx.db, record);
  let rec = bundle.caseRecord;
  if (roleState(rec, input.role) === "READY_FOR_REVIEW")
    rec = applyWorkflow(ctx, rec, input.role, { type: "REQUEST_APPROVAL" });
  if (input.decision === "approved") {
    tryWorkflow(ctx, rec, input.role, { type: "APPROVE" });
  } else {
    tryWorkflow(ctx, rec, input.role, { type: "REJECT", reason: input.reason ?? "rejected" });
  }
  logAudit(ctx, {
    action: `approval.${input.decision}`,
    role: input.role,
    caseId: input.caseId,
    approvalId: record.id,
    reasonCode: input.reason ?? null,
    details: {
      actionKind: input.action,
      draftId: draft.id,
      expiresAt: record.expiresAt,
      fingerprint: record.fingerprint,
      providerWrite: PROVIDER_WRITE_ACTIONS.includes(input.action),
    },
  });
  return record;
}

/* ------------------------------------------------------------------------------------------
 * Channel transfer and deletion
 * --------------------------------------------------------------------------------------- */

export function transferChannel(
  ctx: AppContext,
  input: { caseId: string; role: Role; channel: CaseRecord["channel"]; reason: string },
): CaseBundle {
  if (input.role !== "buyer")
    throw new AppError("ROLE_NOT_ALLOWED", "Only the buyer chooses the recovery channel.", 403);
  const bundle = requireBundle(ctx, input.caseId);
  const rec = bundle.caseRecord;
  if (!input.reason.trim())
    throw new AppError("REASON_REQUIRED", "A reason is required to close or transfer a channel.");
  // Independent of claimActive: anything prepared, executing or unknown blocks a transfer.
  const unsettled = operationRepo
    .listForCase(ctx.db, rec.id)
    .filter((o) => o.status === "PREPARED" || o.status === "DISPATCHING" || o.status === "UNKNOWN");
  if (unsettled.length > 0)
    throw new AppError(
      "IN_FLIGHT",
      "An operation for this case is prepared, executing or has an unknown result. Read it back and record a recovery decision before changing the channel.",
      409,
      { operations: unsettled.map((o) => ({ id: o.id, status: o.status })) },
    );
  // A local transfer never closes an external case, even when the same channel is selected.
  const claim = claimForCharge(ctx, rec.chargeId);
  if (claim)
    throw new AppError(
      claim.state === "OPEN" ? "PROVIDER_CLAIM_OPEN" : "IN_FLIGHT",
      claim.state === "OPEN"
        ? "A provider case is open for this charge. Changing the channel here would not close it; refresh the provider case and transfer only after the provider reports it resolved."
        : "A claim for this charge is reserved by an unsettled operation.",
      409,
      { state: claim.state, channel: claim.channel },
    );
  const updated: CaseRecord = {
    ...rec,
    channel: input.channel,
    claimActive: false,
    claimClosedReason: rec.claimClosedReason,
    updatedAt: ctx.clock.now().toISOString(),
  };
  cases.update(ctx.db, updated);
  logAudit(ctx, {
    action: "case.channel_transferred",
    role: input.role,
    caseId: rec.id,
    reasonCode: input.reason,
    details: { from: rec.channel, to: input.channel },
  });
  bumpSnapshot(ctx, updated, "channel_transferred");
  return requireBundle(ctx, input.caseId);
}

export interface DeletionResult {
  caseId: string;
  evidenceFiles: number;
  drafts: number;
  approvals: number;
  operations: number;
  checkpointsDeleted: boolean;
}

export function assertDeletable(ctx: AppContext, caseId: string): CaseBundle {
  const bundle = requireBundle(ctx, caseId);
  const inflight = operationRepo
    .listForCase(ctx.db, caseId)
    .filter((o) => o.status === "DISPATCHING" || o.status === "UNKNOWN");
  if (
    inflight.length > 0 ||
    isInFlight(bundle.caseRecord.buyerState) ||
    isInFlight(bundle.caseRecord.merchantState)
  ) {
    throw new AppError(
      "IN_FLIGHT",
      "This case has an executing or unresolved operation. Reconcile or record a recovery decision before deleting it.",
      409,
      {
        operations: inflight.map((o) => ({ id: o.id, status: o.status })),
      },
    );
  }
  return bundle;
}

export { charges, draftRepo as drafts, approvalRepo as approvals, operationRepo as operations };
