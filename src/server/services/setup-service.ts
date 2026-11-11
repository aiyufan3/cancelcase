import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../context";
import {
  approvals as approvalRepo,
  cases,
  charges,
  operations as operationRepo,
  subscriptions,
} from "../db/repos";
import type {
  ApprovalRecord,
  CaseRecord,
  ChargeRecord,
  OperationRecord,
  SubscriptionRecord,
} from "../records";
import { newId } from "../ids";
import { logAudit } from "./audit";
import { AppError } from "./errors";
import { bumpSnapshot, reconcileCase } from "./case-service";
import {
  applyObservation,
  refreshProviderObservation,
  sweepExpiredLeases,
} from "./operation-service";
import {
  chargeFactsFrom,
  chargeFactsFromTransaction,
  syncChargeFromTransactions,
} from "./charge-sync";
import { registerExistingClaim, releaseClaimOnProviderResolution } from "./claim-service";
import { initialCancellation, reduceCancellation } from "@/domain/cancellation";
import { hashCanonical, sha256Hex } from "@/domain/canonical";
import { approvalExpiry, bindingFingerprint, materialFingerprint } from "@/domain/approval";
import type { ProviderAllowedAction, ProviderRef } from "@/domain/types";
import {
  ADJUDICATION_OUTCOMES,
  type AdjudicationOutcome,
  type SetupPreview,
  type WriteOutcome,
} from "@/paypal/adapter";
import { addMinutes, compareInstants } from "@/domain/time";
import { centsToDecimalString } from "@/domain/money";

/**
 * Sandbox setup and import. These are explicit operator (CLI) actions in sandbox mode:
 *   - create a synthetic product/plan/subscription and return the buyer approval URL,
 *   - read the subscription back after the owner approves it in the browser,
 *   - import a real Sandbox dispute that was created manually (tier B fallback),
 *   - optionally cancel the Sandbox subscription as a separately approved test mutation.
 *
 * Every provider write goes through the operation ledger with a CLI approval record, so the
 * same durability and recovery rules apply as in the UI. Real identifiers are kept in the
 * private setup manifest under the sandbox data directory; public captures use aliases.
 */

export const SETUP_CASE_SENTINEL = "sb_setup";

export type SetupStageName = "product" | "plan" | "subscription";
export const SETUP_STAGES: readonly SetupStageName[] = ["product", "plan", "subscription"];
const STAGE_ACTION: Record<SetupStageName, OperationRecord["action"]> = {
  product: "sandbox_setup_product",
  plan: "sandbox_setup_plan",
  subscription: "sandbox_setup_subscription",
};

export type SetupStageStatus = "pending" | "in_flight" | "succeeded" | "failed" | "unknown";

export interface SetupStage {
  status: SetupStageStatus;
  resourceId: string | null;
  operationId: string | null;
  attempt: number;
  at: string | null;
  error: string | null;
}

/**
 * The setup intent is recorded before the first provider write and never changes afterwards:
 * the same preview (including the subscription custom_id derived from the intent) is used for
 * every stage and every retry, so repeating a command continues the same resource set.
 */
export interface SetupIntent {
  id: string;
  createdAt: string;
  previewHash: string;
}

export interface SetupManifest {
  version: 2;
  createdAt: string;
  updatedAt: string;
  intent: SetupIntent;
  preview: SetupPreview;
  stages: Record<SetupStageName, SetupStage>;
  productId: string | null;
  planId: string | null;
  subscriptionId: string | null;
  approveUrl: string | null;
  lastStatus: string | null;
  lastStatusAt: string | null;
  operations: { id: string; action: string; status: string; at: string }[];
  importedCaseId: string | null;
  importedDisputeId: string | null;
  /** Earlier intents whose product, plan and subscription all exist (see startNewSetupIntent). */
  previousIntentIds?: string[];
  /** Delayed start only: the first-billing instant the succeeded subscription request asked for. */
  requestedStartTime?: string;
}

/** Payload of each stage operation. It carries the whole intent so the ledger alone can rebuild it. */
interface StagePayload {
  intentId: string;
  stage: SetupStageName;
  attempt: number;
  preview: SetupPreview;
  productId: string | null;
  planId: string | null;
  /**
   * Subscription stage of a delayed-start intent only: the first-billing instant requested by
   * this attempt. It is fixed when the attempt is prepared, so the approval covers exactly what
   * is sent, and a retry is a new attempt with its own, later instant.
   */
  startTime?: string;
}

interface ManifestV1 {
  version: 1;
  createdAt: string;
  updatedAt: string;
  preview: SetupPreview;
  productId: string | null;
  planId: string | null;
  subscriptionId: string | null;
  approveUrl: string | null;
  lastStatus: string | null;
  lastStatusAt: string | null;
  operations: SetupManifest["operations"];
  importedCaseId: string | null;
  importedDisputeId: string | null;
}

function emptyStage(): SetupStage {
  return {
    status: "pending",
    resourceId: null,
    operationId: null,
    attempt: 0,
    at: null,
    error: null,
  };
}

/** A v1 manifest (one combined setup call) reads as an intent whose known resources succeeded. */
function normalizeManifest(raw: SetupManifest | ManifestV1): SetupManifest {
  if (raw.version === 2) return raw;
  const done = (id: string | null): SetupStage =>
    id
      ? {
          status: "succeeded",
          resourceId: id,
          operationId: null,
          attempt: 1,
          at: raw.updatedAt,
          error: null,
        }
      : emptyStage();
  return {
    ...raw,
    version: 2,
    intent: {
      id: `legacy-${sha256Hex(raw.preview.subscription.customId).slice(0, 12)}`,
      createdAt: raw.createdAt,
      previewHash: hashCanonical(raw.preview),
    },
    stages: {
      product: done(raw.productId),
      plan: done(raw.planId),
      subscription: done(raw.subscriptionId),
    },
  };
}

export function manifestPath(ctx: AppContext): string {
  return path.join(ctx.config.envDir, "setup-manifest.json");
}

export function readManifest(ctx: AppContext): SetupManifest | null {
  const file = manifestPath(ctx);
  if (!fs.existsSync(file)) return null;
  return normalizeManifest(JSON.parse(fs.readFileSync(file, "utf8")) as SetupManifest | ManifestV1);
}

export function writeManifest(ctx: AppContext, manifest: SetupManifest): void {
  fs.mkdirSync(ctx.config.envDir, { recursive: true });
  fs.writeFileSync(manifestPath(ctx), JSON.stringify(manifest, null, 2), { mode: 0o600 });
}

/** The subscription custom_id is fixed by the intent, so retries never describe a new purchase. */
export function intentCustomId(intentId: string): string {
  return `cancelcase-sandbox-${intentId.split("_").pop()}`;
}

export type SetupInterval = "MONTH" | "DAY";

/** A delayed start must leave time to approve in the browser and stay within a test's horizon. */
export const START_DELAY_MINUTES = { min: 5, max: 30 * 24 * 60 } as const;
/** A prepared request whose start time is closer than this is refused locally; nothing is sent. */
const START_TIME_SEND_MARGIN_MS = 60 * 1000;

/** Parse the operator's --start-in value: whole minutes within the allowed range. */
export function parseStartDelayMinutes(raw: string): number {
  const minutes = /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (
    !Number.isInteger(minutes) ||
    minutes < START_DELAY_MINUTES.min ||
    minutes > START_DELAY_MINUTES.max
  )
    throw new AppError(
      "INVALID_START_DELAY",
      `--start-in takes whole minutes between ${START_DELAY_MINUTES.min} and ${START_DELAY_MINUTES.max}.`,
      400,
    );
  return minutes;
}

/** The first-billing instant for an attempt prepared at `now`: UTC, second precision. */
export function startTimeAfter(now: Date, delayMinutes: number): string {
  return new Date(now.getTime() + delayMinutes * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Whether a prepared start time is still far enough ahead to be sent. */
export function startTimeSendable(startTime: string, now: Date): boolean {
  const at = Date.parse(startTime);
  return Number.isFinite(at) && at - now.getTime() >= START_TIME_SEND_MARGIN_MS;
}

export function defaultPreview(
  appOrigin: string,
  intentId?: string,
  interval: SetupInterval = "MONTH",
  startDelayMinutes?: number,
): SetupPreview {
  const daily = interval === "DAY";
  return {
    product: {
      name: "Example Studio Pro (CancelCase Sandbox test)",
      description:
        "Synthetic subscription product created by CancelCase for Sandbox testing. Not a real service.",
      type: "SERVICE",
      category: "SOFTWARE",
    },
    plan: {
      name: daily
        ? "Example Studio Pro — daily (Sandbox test)"
        : "Example Studio Pro — monthly (Sandbox test)",
      description: daily
        ? "Synthetic daily plan for the CancelCase charged-after-cancellation test: it bills again a day after approval."
        : "Synthetic monthly plan for the CancelCase charged-after-cancellation test.",
      priceValue: "19.99",
      currency: "USD",
      intervalUnit: interval,
      intervalCount: 1,
    },
    subscription: {
      customId: intentId
        ? intentCustomId(intentId)
        : "cancelcase-sandbox-<assigned-with-the-intent>",
      returnUrl: `${appOrigin}/sandbox/approved`,
      cancelUrl: `${appOrigin}/sandbox/cancelled`,
      // The key is absent for an ordinary intent, so its recorded preview hash is unchanged.
      ...(startDelayMinutes === undefined ? {} : { startDelayMinutes }),
    },
  };
}

function isStagePayload(p: unknown): p is StagePayload {
  const v = p as Partial<StagePayload> | null;
  return (
    !!v &&
    typeof v.intentId === "string" &&
    typeof v.attempt === "number" &&
    (SETUP_STAGES as readonly unknown[]).includes(v.stage)
  );
}

function stageOperations(ctx: AppContext): OperationRecord[] {
  return operationRepo
    .listForCase(ctx.db, SETUP_CASE_SENTINEL)
    .filter((op) => isStagePayload(op.payload));
}

/** Operations from the earlier single-call setup that never settled. They block new writes. */
function unresolvedLegacyOperations(ctx: AppContext): OperationRecord[] {
  return operationRepo
    .listForCase(ctx.db, SETUP_CASE_SENTINEL)
    .filter(
      (op) =>
        op.action === "sandbox_setup_subscription" &&
        !isStagePayload(op.payload) &&
        op.status !== "SUCCEEDED" &&
        op.status !== "FAILED",
    );
}

function stageFromLedger(ops: OperationRecord[], stage: SetupStageName): SetupStage | null {
  const mine = ops
    .filter((o) => (o.payload as StagePayload).stage === stage)
    .sort((a, b) => (a.payload as StagePayload).attempt - (b.payload as StagePayload).attempt);
  const last = mine.at(-1);
  if (!last) return null;
  const result = (last.result ?? {}) as { resourceId?: unknown };
  const status: SetupStageStatus =
    last.status === "SUCCEEDED"
      ? "succeeded"
      : last.status === "FAILED"
        ? "failed"
        : last.status === "UNKNOWN"
          ? "unknown"
          : last.status === "DISPATCHING"
            ? "in_flight"
            : "pending";
  return {
    status,
    resourceId:
      status === "succeeded" && typeof result.resourceId === "string" ? result.resourceId : null,
    operationId: last.id,
    attempt: (last.payload as StagePayload).attempt,
    at: last.updatedAt,
    error: last.errorCode ? `${last.errorCode}: ${last.errorMessage ?? ""}`.trim() : null,
  };
}

/** The operation ledger is the source of truth; the manifest is a readable checkpoint of it. */
function applyLedger(manifest: SetupManifest, ops: OperationRecord[]): SetupManifest {
  for (const stage of SETUP_STAGES) {
    const fromLedger = stageFromLedger(ops, stage);
    if (fromLedger) manifest.stages[stage] = fromLedger;
  }
  manifest.productId = manifest.stages.product.resourceId ?? manifest.productId;
  manifest.planId = manifest.stages.plan.resourceId ?? manifest.planId;
  manifest.subscriptionId = manifest.stages.subscription.resourceId ?? manifest.subscriptionId;
  const subOp = ops
    .filter((o) => (o.payload as StagePayload).stage === "subscription" && o.status === "SUCCEEDED")
    .sort((a, b) => (a.payload as StagePayload).attempt - (b.payload as StagePayload).attempt)
    .at(-1);
  const requestedStart = subOp ? (subOp.payload as StagePayload).startTime : undefined;
  if (requestedStart) manifest.requestedStartTime = requestedStart;
  else delete manifest.requestedStartTime;
  if (subOp && !manifest.lastStatus) {
    const r = (subOp.result ?? {}) as { approveUrl?: string | null; status?: string | null };
    manifest.approveUrl = manifest.approveUrl ?? r.approveUrl ?? null;
    manifest.lastStatus = r.status ?? null;
    manifest.lastStatusAt = subOp.updatedAt;
  }
  return manifest;
}

/** Find the connected case already created for a provider subscription, if any. */
function caseForProviderSubscription(
  ctx: AppContext,
  providerSubscriptionId: string,
): string | null {
  for (const rec of cases.list(ctx.db)) {
    if (rec.environment !== ctx.config.mode) continue;
    const sub = subscriptions.get(ctx.db, rec.subscriptionId);
    if (
      sub?.providerRefs.some(
        (r) => r.kind === "subscription_id" && r.value === providerSubscriptionId,
      )
    )
      return rec.id;
  }
  return null;
}

function caseMatchesProviderSubscription(
  ctx: AppContext,
  caseId: string,
  providerSubscriptionId: string,
): boolean {
  const rec = cases.get(ctx.db, caseId);
  if (!rec || rec.environment !== ctx.config.mode) return false;
  return (
    subscriptions
      .get(ctx.db, rec.subscriptionId)
      ?.providerRefs.some(
        (r) => r.kind === "subscription_id" && r.value === providerSubscriptionId,
      ) ?? false
  );
}

/**
 * Current setup state: the private manifest reconciled with the operation ledger. When the
 * manifest is missing or belongs to another intent, it is rebuilt from the ledger, so moving
 * the file aside never hides an unknown or partial write.
 */
export function loadSetupState(ctx: AppContext): SetupManifest | null {
  sweepExpiredLeases(ctx);
  const file = readManifest(ctx);
  const byIntent = new Map<string, OperationRecord[]>();
  for (const op of stageOperations(ctx)) {
    const id = (op.payload as StagePayload).intentId;
    byIntent.set(id, [...(byIntent.get(id) ?? []), op]);
  }
  if (byIntent.size === 0) return file;
  // A new intent recorded after completed ones has no operation yet; it stays current as long
  // as every intent in the ledger is one it explicitly follows.
  if (
    file &&
    !byIntent.has(file.intent.id) &&
    (file.previousIntentIds?.length ?? 0) > 0 &&
    Array.from(byIntent.keys()).every((id) => file.previousIntentIds!.includes(id))
  )
    return file;
  let manifest = file;
  let rebuilt = false;
  if (!manifest || !byIntent.has(manifest.intent.id)) {
    const intentId = Array.from(byIntent.keys()).at(-1)!;
    const first = byIntent.get(intentId)![0]!;
    const payload = first.payload as StagePayload;
    const now = ctx.clock.now().toISOString();
    manifest = {
      version: 2,
      createdAt: first.createdAt,
      updatedAt: now,
      intent: {
        id: intentId,
        createdAt: first.createdAt,
        previewHash: hashCanonical(payload.preview),
      },
      preview: payload.preview,
      stages: { product: emptyStage(), plan: emptyStage(), subscription: emptyStage() },
      productId: null,
      planId: null,
      subscriptionId: null,
      approveUrl: null,
      lastStatus: null,
      lastStatusAt: null,
      operations: [],
      importedCaseId: null,
      importedDisputeId: null,
    };
    rebuilt = true;
  }
  applyLedger(manifest, byIntent.get(manifest.intent.id)!);
  if (rebuilt) {
    if (manifest.subscriptionId)
      manifest.importedCaseId = caseForProviderSubscription(ctx, manifest.subscriptionId);
    writeManifest(ctx, manifest);
    logAudit(ctx, {
      action: "setup.manifest_rebuilt",
      role: "merchant",
      caseId: SETUP_CASE_SENTINEL,
      details: { intentId: manifest.intent.id, replacedFile: file !== null },
    });
  }
  return manifest;
}

function checkpoint(ctx: AppContext, manifest: SetupManifest): SetupManifest {
  const ops = stageOperations(ctx).filter(
    (o) => (o.payload as StagePayload).intentId === manifest.intent.id,
  );
  applyLedger(manifest, ops);
  manifest.updatedAt = ctx.clock.now().toISOString();
  writeManifest(ctx, manifest);
  return manifest;
}

function cliApproval(
  ctx: AppContext,
  action: ApprovalRecord["action"],
  payloadHash: string,
  resourceId: string,
): ApprovalRecord {
  const now = ctx.clock.now().toISOString();
  const binding = {
    actor: "cli-operator",
    role: "merchant" as const,
    environment: ctx.config.mode,
    accountAlias: "sandbox-merchant",
    resourceId,
    action,
    payloadHash,
    payloadVersion: 1,
    evidenceSnapshotVersion: 0,
    attachmentHashes: [] as string[],
  };
  const record: ApprovalRecord = {
    id: newId(ctx.config.mode, "appr"),
    environment: ctx.config.mode,
    caseId: SETUP_CASE_SENTINEL,
    role: "merchant",
    action,
    draftId: null,
    fingerprint: bindingFingerprint(binding),
    binding,
    materialFingerprint: materialFingerprint({
      environment: ctx.config.mode,
      evidenceSnapshotVersion: 0,
      channel: "n/a",
      claimableCents: null,
      requestedCents: null,
      charge: {
        status: "n/a",
        amountCents: null,
        refundedCents: null,
        refundStateKnown: false,
        eventTime: null,
      },
      cancellation: { state: "n/a", effectiveAt: null, basis: null, evidenceIds: [] },
      provider: null,
    }),
    decision: "approved",
    decidedAt: now,
    expiresAt: approvalExpiry(now),
    approver: "cli-operator",
    consumedByOperationId: null,
    revokedReason: null,
    createdAt: now,
  };
  approvalRepo.insert(ctx.db, record);
  return record;
}

function reserveSetupOperation(
  ctx: AppContext,
  action: OperationRecord["action"],
  logicalKey: string,
  payload: unknown,
  approval: ApprovalRecord,
): { op: OperationRecord; created: boolean } {
  const now = ctx.clock.now().toISOString();
  const txn = ctx.db.transaction(() => {
    const existing = operationRepo.getByLogicalKey(ctx.db, logicalKey);
    if (existing) return { op: existing, created: false };
    const op: OperationRecord = {
      id: newId(ctx.config.mode, "op"),
      logicalKey,
      environment: ctx.config.mode,
      caseId: SETUP_CASE_SENTINEL,
      role: "merchant",
      action,
      resourceId: logicalKey,
      payload,
      payloadHash: hashCanonical(payload),
      payloadVersion: 1,
      attachmentHashes: [],
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
    if (!approvalRepo.consume(ctx.db, approval.id, op.id, now))
      throw new AppError("APPROVAL_INVALID", "CLI approval could not be consumed.", 409);
    return { op, created: true };
  });
  return txn();
}

function finishSetupOperation(
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
    action: `setup.${updated.status.toLowerCase()}`,
    role: "merchant",
    caseId: SETUP_CASE_SENTINEL,
    operationId: op.id,
    reasonCode: updated.errorCode,
    details: { actionKind: op.action },
  });
  return updated;
}

/**
 * Record the setup intent (once) before any provider write. An existing intent — including one
 * rebuilt from the ledger — is returned unchanged; the preview argument is then ignored.
 */
export function prepareSetupIntent(ctx: AppContext, preview: SetupPreview): SetupManifest {
  if (ctx.config.mode !== "sandbox")
    throw new AppError("WRONG_MODE", "Setup runs in sandbox mode only.", 400);
  const existing = loadSetupState(ctx);
  if (existing) return existing;
  assertNoLegacySetupInFlight(ctx);
  return recordIntent(ctx, preview, []);
}

function recordIntent(
  ctx: AppContext,
  preview: SetupPreview,
  previousIntentIds: string[],
): SetupManifest {
  const now = ctx.clock.now().toISOString();
  const id = newId(ctx.config.mode, "setup");
  const fixed: SetupPreview = {
    ...preview,
    subscription: { ...preview.subscription, customId: intentCustomId(id) },
  };
  const manifest: SetupManifest = {
    version: 2,
    createdAt: now,
    updatedAt: now,
    intent: { id, createdAt: now, previewHash: hashCanonical(fixed) },
    preview: fixed,
    stages: { product: emptyStage(), plan: emptyStage(), subscription: emptyStage() },
    productId: null,
    planId: null,
    subscriptionId: null,
    approveUrl: null,
    lastStatus: null,
    lastStatusAt: null,
    operations: [],
    importedCaseId: null,
    importedDisputeId: null,
    ...(previousIntentIds.length > 0 ? { previousIntentIds } : {}),
  };
  writeManifest(ctx, manifest);
  logAudit(ctx, {
    action: "setup.intent_recorded",
    role: "merchant",
    caseId: SETUP_CASE_SENTINEL,
    details: { intentId: id, previousIntentIds },
  });
  return manifest;
}

/**
 * Record a further setup intent (for example a daily plan) after the current one is complete.
 * Refused while the current intent still has a stage to create, recover or settle, so a new
 * intent can never hide an unknown or partial write. The completed manifest is archived next to
 * the current one; the ledger keeps every operation of every intent.
 */
export function startNewSetupIntent(ctx: AppContext, preview: SetupPreview): SetupManifest {
  if (ctx.config.mode !== "sandbox")
    throw new AppError("WRONG_MODE", "Setup runs in sandbox mode only.", 400);
  const current = loadSetupState(ctx);
  if (!current) return prepareSetupIntent(ctx, preview);
  assertNoLegacySetupInFlight(ctx);
  const unsettled = stageOperations(ctx).filter(
    (op) => op.status !== "SUCCEEDED" && op.status !== "FAILED",
  );
  if (
    unsettled.length > 0 ||
    !SETUP_STAGES.every((stage) => current.stages[stage].status === "succeeded")
  )
    throw new AppError(
      "SETUP_INCOMPLETE",
      "The current setup still has a stage to create, recover or settle. Finish it (--confirm, --recover) before starting a new intent.",
      409,
    );
  fs.writeFileSync(
    path.join(ctx.config.envDir, `setup-manifest.${current.intent.id}.json`),
    JSON.stringify(current, null, 2),
    { mode: 0o600 },
  );
  return recordIntent(ctx, preview, [...(current.previousIntentIds ?? []), current.intent.id]);
}

function assertNoLegacySetupInFlight(ctx: AppContext): void {
  if (unresolvedLegacyOperations(ctx).length > 0)
    throw new AppError(
      "LEGACY_SETUP_UNRESOLVED",
      "An earlier setup operation has an unknown result. Check the Sandbox Developer Dashboard and resolve it before creating anything else.",
      409,
    );
}

export interface SetupRunResult {
  manifest: SetupManifest;
  /** The last stage operation this call touched (or the blocking one). */
  operation: OperationRecord | null;
  /** The stage that stopped the run, or null when all three stages have succeeded. */
  stoppedAt: SetupStageName | null;
  reason: "UNKNOWN" | "IN_FLIGHT" | "FAILED" | null;
}

/**
 * Create the product, then the plan, then the subscription of the recorded intent. Each stage
 * is its own ledger operation (logical key per intent, stage and attempt) and the manifest is
 * checkpointed after each one, so a crash or failure keeps what already exists:
 *  - a succeeded stage is never repeated;
 *  - a definitively failed stage is retried as a new attempt on the next run;
 *  - an unknown or in-flight stage stops the run until it is read back or recovered.
 */
export async function runSubscriptionSetup(
  ctx: AppContext,
  preview?: SetupPreview,
): Promise<SetupRunResult> {
  let manifest = prepareSetupIntent(ctx, preview ?? defaultPreview(ctx.config.appOrigin));
  assertNoLegacySetupInFlight(ctx);
  if (SETUP_STAGES.every((stage) => manifest.stages[stage].status === "succeeded"))
    throw new AppError(
      "ALREADY_SET_UP",
      "The Sandbox product, plan and subscription of this setup already exist. Use --resume to read the subscription back.",
      409,
    );
  let last: OperationRecord | null = null;
  for (const stage of SETUP_STAGES) {
    const before = manifest.stages[stage];
    if (before.status === "succeeded") continue;
    if (before.status === "unknown" || before.status === "in_flight")
      return {
        manifest,
        operation: before.operationId ? operationRepo.get(ctx.db, before.operationId) : null,
        stoppedAt: stage,
        reason: before.status === "unknown" ? "UNKNOWN" : "IN_FLIGHT",
      };
    const attempt = before.status === "failed" ? before.attempt + 1 : Math.max(1, before.attempt);
    last = await runStage(ctx, manifest, stage, attempt);
    manifest.operations.push({
      id: last.id,
      action: last.action,
      status: last.status,
      at: last.updatedAt,
    });
    manifest = checkpoint(ctx, manifest);
    const after = manifest.stages[stage];
    if (after.status !== "succeeded")
      return {
        manifest,
        operation: last,
        stoppedAt: stage,
        reason:
          after.status === "unknown"
            ? "UNKNOWN"
            : after.status === "in_flight"
              ? "IN_FLIGHT"
              : "FAILED",
      };
  }
  return { manifest, operation: last, stoppedAt: null, reason: null };
}

type StageOutcome = WriteOutcome<{
  resourceId: string;
  approveUrl?: string | null;
  status?: string | null;
}>;

async function callStage(
  ctx: AppContext,
  manifest: SetupManifest,
  stage: SetupStageName,
  wctx: { operationId: string; requestId: string },
  startTime: string | null,
): Promise<StageOutcome> {
  if (stage === "product") {
    const o = await ctx.adapter.createCatalogProduct(manifest.preview, wctx);
    return o.kind === "succeeded" ? { ...o, result: { resourceId: o.result.productId } } : o;
  }
  if (stage === "plan") {
    if (!manifest.productId)
      return {
        kind: "failed",
        error: {
          code: "MISSING_PRODUCT",
          message: "The plan needs the product from the first stage; nothing was sent.",
          correlationId: null,
          httpStatus: null,
        },
      };
    const o = await ctx.adapter.createBillingPlan(manifest.productId, manifest.preview, wctx);
    return o.kind === "succeeded" ? { ...o, result: { resourceId: o.result.planId } } : o;
  }
  if (!manifest.planId)
    return {
      kind: "failed",
      error: {
        code: "MISSING_PLAN",
        message: "The subscription needs the plan from the second stage; nothing was sent.",
        correlationId: null,
        httpStatus: null,
      },
    };
  if (startTime && !startTimeSendable(startTime, ctx.clock.now()))
    return {
      kind: "failed",
      error: {
        code: "START_TIME_PASSED",
        message:
          "The start time fixed for this attempt has passed or is under a minute away; nothing was sent. Run --confirm again: the next attempt gets a new start time.",
        correlationId: null,
        httpStatus: null,
      },
    };
  const o = await ctx.adapter.createSubscription(manifest.planId, manifest.preview, wctx, {
    startTime,
  });
  return o.kind === "succeeded"
    ? {
        ...o,
        result: {
          resourceId: o.result.subscriptionId,
          approveUrl: o.result.approveUrl,
          status: o.result.status,
        },
      }
    : o;
}

async function runStage(
  ctx: AppContext,
  manifest: SetupManifest,
  stage: SetupStageName,
  attempt: number,
): Promise<OperationRecord> {
  const key = `${ctx.config.mode}:setup:${manifest.intent.id}:${stage}:${attempt}`;
  let op = operationRepo.getByLogicalKey(ctx.db, key);
  if (!op) {
    const delay = manifest.preview.subscription.startDelayMinutes;
    const payload: StagePayload = {
      intentId: manifest.intent.id,
      stage,
      attempt,
      preview: manifest.preview,
      productId: stage === "product" ? null : manifest.productId,
      planId: stage === "subscription" ? manifest.planId : null,
      ...(stage === "subscription" && delay !== undefined
        ? { startTime: startTimeAfter(ctx.clock.now(), delay) }
        : {}),
    };
    const approval = cliApproval(ctx, STAGE_ACTION[stage], hashCanonical(payload), key);
    op = reserveSetupOperation(ctx, STAGE_ACTION[stage], key, payload, approval).op;
  }
  if (op.status !== "PREPARED") return op;
  const now = ctx.clock.now().toISOString();
  if (!operationRepo.acquireDispatch(ctx.db, op.id, addMinutes(now, 2), now))
    return operationRepo.get(ctx.db, op.id) ?? op;
  let outcome: StageOutcome;
  try {
    outcome = await callStage(
      ctx,
      manifest,
      stage,
      { operationId: op.id, requestId: `cc-${sha256Hex(op.id).slice(0, 20)}` },
      // What is sent is what the ledger holds for this attempt, never a value recomputed now.
      (op.payload as StagePayload).startTime ?? null,
    );
  } catch (err) {
    // The request may have reached the provider before the exception.
    outcome = {
      kind: "unknown",
      error: {
        code: "EXCEPTION",
        message: err instanceof Error ? err.message.slice(0, 200) : "Unexpected error.",
        correlationId: null,
        httpStatus: null,
      },
    };
  }
  const current = operationRepo.get(ctx.db, op.id)!;
  if (outcome.kind === "succeeded")
    return finishSetupOperation(ctx, current, {
      status: "SUCCEEDED",
      result: { ...outcome.result, correlationId: outcome.correlationId },
      providerRequestId: outcome.providerRequestId,
    });
  return finishSetupOperation(ctx, current, {
    status: outcome.kind === "failed" ? "FAILED" : "UNKNOWN",
    errorCode: outcome.error.code,
    errorMessage: outcome.error.message,
    result: { correlationId: outcome.error.correlationId, httpStatus: outcome.error.httpStatus },
  });
}

/**
 * Settle an unknown stage after the operator checked the Sandbox Developer Dashboard. "succeeded"
 * records the resource that exists (the run then continues with it); "failed" records that
 * nothing was created (the next run creates the resource as a new attempt). A note is required
 * and both decisions are kept on the operation and in the audit log.
 */
export function recoverSetupStage(
  ctx: AppContext,
  stage: SetupStageName,
  decision: { outcome: "succeeded"; resourceId: string } | { outcome: "failed" },
  note: string,
): SetupManifest {
  if (ctx.config.mode !== "sandbox")
    throw new AppError("WRONG_MODE", "Setup runs in sandbox mode only.", 400);
  const manifest = loadSetupState(ctx);
  if (!manifest) throw new AppError("NO_MANIFEST", "No setup has been recorded.", 404);
  const current = manifest.stages[stage];
  if (current.status !== "unknown" || !current.operationId)
    throw new AppError(
      "STAGE_NOT_UNKNOWN",
      `The ${stage} stage is ${current.status}; only a stage with an unknown result is recovered.`,
      409,
    );
  const trimmed = note.trim();
  if (trimmed.length < 10)
    throw new AppError(
      "RECOVERY_NOTE_REQUIRED",
      "Describe what you checked (at least 10 characters).",
      400,
    );
  const op = operationRepo.get(ctx.db, current.operationId)!;
  if (decision.outcome === "succeeded") {
    const id = decision.resourceId.trim();
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(id))
      throw new AppError("INVALID_RESOURCE_ID", "That does not look like a provider ID.", 400);
    finishSetupOperation(ctx, op, {
      status: "SUCCEEDED",
      result: { ...((op.result as object | null) ?? {}), resourceId: id, recovered: true },
      recoveryDecision: "confirmed_succeeded",
      recoveryNote: trimmed,
    });
  } else {
    finishSetupOperation(ctx, op, {
      status: "FAILED",
      errorCode: "CONFIRMED_NOT_CREATED",
      errorMessage: "The operator confirmed that nothing was created.",
      recoveryDecision: "confirmed_failed",
      recoveryNote: trimmed,
    });
  }
  logAudit(ctx, {
    action: "setup.recovered",
    role: "merchant",
    caseId: SETUP_CASE_SENTINEL,
    operationId: op.id,
    reasonCode: decision.outcome,
    details: { stage },
  });
  return checkpoint(ctx, manifest);
}

export interface ResumeResult {
  manifest: SetupManifest;
  status: string | null;
  transactions: {
    id: string;
    status: string | null;
    time: string | null;
    amountValue: string | null;
    amountCurrency: string | null;
  }[];
  caseId: string | null;
  /** Cases created in this read for later payments of the same subscription. */
  laterPaymentCaseIds: string[];
  /** When PayPal plans the next billing, as read (null when unknown). */
  nextBillingTime: string | null;
  error: string | null;
}

/** Read the Sandbox subscription back; when it is active and paid, create the connected case. */
export async function resumeSubscriptionSetup(
  ctx: AppContext,
  options: { buyerAlias: string; merchantAlias: string },
): Promise<ResumeResult> {
  if (ctx.config.mode !== "sandbox")
    throw new AppError("WRONG_MODE", "Setup runs in sandbox mode only.", 400);
  const manifest = loadSetupState(ctx);
  if (!manifest?.subscriptionId)
    throw new AppError(
      "NO_MANIFEST",
      "No Sandbox subscription has been created yet. Run sandbox:setup --confirm first.",
      404,
    );
  const read = await ctx.adapter.getSubscription(manifest.subscriptionId);
  if (!read.ok) {
    const gone = isNotFound(read.error);
    if (gone) {
      // Read-back evidence that PayPal no longer has this subscription (an unapproved
      // subscription is dropped after a few hours). Recorded, never inferred.
      manifest.lastStatus = SUBSCRIPTION_NOT_FOUND;
      manifest.lastStatusAt = ctx.clock.now().toISOString();
      manifest.updatedAt = manifest.lastStatusAt;
      writeManifest(ctx, manifest);
      logAudit(ctx, {
        action: "setup.subscription_not_found",
        role: "merchant",
        caseId: SETUP_CASE_SENTINEL,
        details: { stageAttempt: manifest.stages.subscription.attempt },
      });
    }
    return {
      manifest,
      status: gone ? SUBSCRIPTION_NOT_FOUND : null,
      transactions: [],
      caseId: manifest.importedCaseId,
      laterPaymentCaseIds: [],
      nextBillingTime: null,
      error: `${read.error.code}: ${read.error.message}`,
    };
  }
  manifest.lastStatus = read.data.status;
  manifest.lastStatusAt = read.observedAt;
  manifest.approveUrl = read.data.approveUrl ?? manifest.approveUrl;
  const end = ctx.clock.now();
  const start = new Date(end.getTime() - 90 * 24 * 3600 * 1000);
  const txs = await ctx.adapter.listSubscriptionTransactions(
    manifest.subscriptionId,
    start.toISOString(),
    end.toISOString(),
  );
  const transactions = txs.ok ? txs.data : [];
  // The checkpoint can name a deleted case or a separately imported dispute. Recover from
  // the actual subscription records rather than letting a stale pointer stop payment discovery.
  let caseId =
    manifest.importedCaseId &&
    caseMatchesProviderSubscription(ctx, manifest.importedCaseId, manifest.subscriptionId)
      ? manifest.importedCaseId
      : caseForProviderSubscription(ctx, manifest.subscriptionId);
  let laterPaymentCaseIds: string[] = [];
  // A mandate that has ended still has payment history. Only ACTIVE may create the
  // pre-payment placeholder; another status needs an explicit transaction from this read.
  const hasObservedPayment = transactions.some((t) => t.id);
  if (!caseId && (read.data.status === "ACTIVE" || hasObservedPayment)) {
    caseId = createConnectedCaseFromSubscription(ctx, manifest, read.data, transactions, options);
  }
  if (caseId) {
    const sub = subscriptions.get(ctx.db, cases.get(ctx.db, caseId)?.subscriptionId ?? "");
    if (sub) {
      subscriptions.update(ctx.db, {
        ...sub,
        providerStatus: read.data.status,
        providerStatusObservedAt: read.observedAt,
        lastSyncAt: read.observedAt,
        updatedAt: ctx.clock.now().toISOString(),
      });
    }
    // Every existing payment may acquire new facts, including a refund in a later cycle.
    // Sync them all before discovering additional payments, so each case invalidates its own
    // drafts and approvals when its charge changes.
    if (txs.ok) {
      const subscriptionId = cases.get(ctx.db, caseId)!.subscriptionId;
      for (const rec of cases.list(ctx.db)) {
        if (rec.subscriptionId === subscriptionId)
          syncChargeFromTransactions(ctx, rec.id, transactions, txs.provenance, "setup_resume");
      }
      laterPaymentCaseIds = trackLaterPayments(
        ctx,
        caseId,
        transactions,
        options,
        manifest.preview.plan.name,
      );
    }
  }
  manifest.importedCaseId = caseId;
  manifest.updatedAt = ctx.clock.now().toISOString();
  writeManifest(ctx, manifest);
  return {
    manifest,
    status: read.data.status,
    transactions,
    caseId,
    laterPaymentCaseIds,
    nextBillingTime: read.data.nextBillingTime,
    error: txs.ok ? null : `${txs.error.code}: ${txs.error.message}`,
  };
}

export const SUBSCRIPTION_NOT_FOUND = "NOT_FOUND";

function isNotFound(error: { code: string; httpStatus: number | null }): boolean {
  return error.httpStatus === 404 || error.code === "RESOURCE_NOT_FOUND";
}

/**
 * Create a replacement subscription for the same product and plan, after PayPal stopped
 * returning the previous one before anyone approved it. Guarded so it can never duplicate a
 * live subscription:
 *  - the previous subscription stage succeeded and no connected case was created from it;
 *  - a fresh read right now returns "not found" (any other answer refuses);
 *  - the replacement is the next attempt of the same recorded subscription stage, so an
 *    unknown or failed replacement follows the normal setup recovery.
 */
export async function replaceExpiredSubscription(ctx: AppContext): Promise<SetupRunResult> {
  if (ctx.config.mode !== "sandbox")
    throw new AppError("WRONG_MODE", "Setup runs in sandbox mode only.", 400);
  let manifest = loadSetupState(ctx);
  if (!manifest?.subscriptionId)
    throw new AppError("NO_MANIFEST", "No Sandbox subscription has been created yet.", 404);
  const stage = manifest.stages.subscription;
  if (
    manifest.stages.product.status !== "succeeded" ||
    manifest.stages.plan.status !== "succeeded" ||
    stage.status !== "succeeded"
  )
    throw new AppError(
      "SETUP_INCOMPLETE",
      "The setup is not complete; run --confirm (and --recover for unknown stages) instead.",
      409,
    );
  if (caseForProviderSubscription(ctx, manifest.subscriptionId))
    throw new AppError(
      "SUBSCRIPTION_IN_USE",
      "A connected case was created from this subscription; it is not replaced.",
      409,
    );
  const read = await ctx.adapter.getSubscription(manifest.subscriptionId);
  if (read.ok)
    throw new AppError(
      "SUBSCRIPTION_EXISTS",
      `PayPal still returns this subscription (status ${read.data.status ?? "unknown"}); nothing was created. Approve it or run --resume.`,
      409,
    );
  if (!isNotFound(read.error))
    throw new AppError(
      "SUBSCRIPTION_STATE_UNCONFIRMED",
      `The subscription could not be read (${read.error.code}); a replacement is only created when PayPal reports it as not found.`,
      409,
    );
  logAudit(ctx, {
    action: "setup.subscription_replaced",
    role: "merchant",
    caseId: SETUP_CASE_SENTINEL,
    details: { previousAttempt: stage.attempt },
  });
  // The new attempt brings its own approval link and status.
  manifest.lastStatus = null;
  manifest.lastStatusAt = null;
  manifest.approveUrl = null;
  manifest.importedCaseId = null;
  const op = await runStage(ctx, manifest, "subscription", stage.attempt + 1);
  manifest.operations.push({ id: op.id, action: op.action, status: op.status, at: op.updatedAt });
  manifest = checkpoint(ctx, manifest);
  const after = manifest.stages.subscription;
  return {
    manifest,
    operation: op,
    stoppedAt: after.status === "succeeded" ? null : "subscription",
    reason:
      after.status === "succeeded"
        ? null
        : after.status === "unknown"
          ? "UNKNOWN"
          : after.status === "in_flight"
            ? "IN_FLIGHT"
            : "FAILED",
  };
}

/** Sort provider payment instants chronologically; an absent time remains unknown. */
function comparePaymentTimes(
  a: ResumeResult["transactions"][number],
  b: ResumeResult["transactions"][number],
): number {
  const aTime = Date.parse(a.time ?? "");
  const bTime = Date.parse(b.time ?? "");
  const aKnown = Number.isFinite(aTime);
  const bKnown = Number.isFinite(bTime);
  if (aKnown && bKnown) return aTime - bTime || a.id.localeCompare(b.id);
  if (aKnown !== bKnown) return aKnown ? 1 : -1;
  return a.id.localeCompare(b.id);
}

function createConnectedCaseFromSubscription(
  ctx: AppContext,
  manifest: SetupManifest,
  sub: {
    subscriptionId: string;
    status: string | null;
    planId: string | null;
    createTime: string | null;
    statusUpdateTime: string | null;
    nextBillingTime: string | null;
    lastPayment: {
      time: string | null;
      amountValue: string | null;
      amountCurrency: string | null;
    } | null;
  },
  transactions: ResumeResult["transactions"],
  options: { buyerAlias: string; merchantAlias: string },
): string {
  return ctx.db
    .transaction(() => {
      const existingCase = caseForProviderSubscription(ctx, sub.subscriptionId);
      if (existingCase) return existingCase;
      for (const payment of transactions) {
        if (payment.id) assertUnrecordedPayment(ctx, payment.id);
      }
      const now = ctx.clock.now().toISOString();
      const subscriptionId = newId("sandbox", "sub");
      const latest =
        [...transactions]
          .filter((t) => t.id)
          .sort(comparePaymentTimes)
          .pop() ?? null;
      // Without a transaction only the subscription's last-payment time and amount are known; the
      // payment status and refund state stay unknown.
      const facts = latest
        ? chargeFactsFromTransaction(latest)
        : chargeFactsFrom({
            status: null,
            time: sub.lastPayment?.time ?? null,
            amountValue: sub.lastPayment?.amountValue ?? null,
            amountCurrency: sub.lastPayment?.amountCurrency ?? null,
          });
      const amount = facts.amountCents === null ? null : { cents: facts.amountCents };
      const subscription: SubscriptionRecord = {
        id: subscriptionId,
        environment: "sandbox",
        accountAlias: "sandbox-buyer",
        ownerAlias: options.buyerAlias,
        merchantAlias: options.merchantAlias,
        label: manifest.preview.plan.name,
        amountCents: amount?.cents ?? null,
        currency: "USD",
        providerRefs: [
          { kind: "subscription_id", value: sub.subscriptionId, provenance: "sandbox_api" },
          ...(sub.planId
            ? [{ kind: "plan_id" as const, value: sub.planId, provenance: "sandbox_api" as const }]
            : []),
        ],
        providerStatus: sub.status,
        providerStatusObservedAt: now,
        cancellation: initialCancellation(),
        sourceIds: [],
        lastSyncAt: now,
        createdAt: now,
        updatedAt: now,
      };
      subscriptions.insert(ctx.db, subscription);
      return insertPaymentCase(ctx, {
        subscriptionId,
        label: manifest.preview.plan.name,
        sale: latest,
        facts,
        parties: options,
        originNote:
          "Created from a Sandbox subscription set up by the operator; buyer approval was manual in the browser. Cancellation facts must be recorded explicitly; a post-cancellation charge may be a simulated association.",
        auditDetails: { origin: "sandbox_setup", transactionCount: transactions.length },
      });
    })
    .immediate();
}

/** Reject a second local identity rather than silently moving a payment across subscriptions. */
function assertUnrecordedPayment(ctx: AppContext, saleId: string): void {
  const matches = charges.findByPaymentRefs(ctx.db, "sandbox", "sandbox-buyer", [
    { kind: "subscription_sale_id", value: saleId, provenance: "sandbox_api" },
  ]);
  if (matches.length > 0 || charges.getByDedupeKey(ctx.db, "sandbox", "sandbox-buyer", saleId))
    throw new AppError(
      "PAYMENT_ALREADY_RECORDED",
      "This payment already belongs to a local case. Review that case before associating it with this subscription; nothing was merged or duplicated.",
      409,
    );
}

/** One charge and its case for one payment of a local subscription record. */
function insertPaymentCase(
  ctx: AppContext,
  input: {
    subscriptionId: string;
    label: string;
    sale: { id: string } | null;
    facts: ReturnType<typeof chargeFactsFrom>;
    parties: { buyerAlias: string; merchantAlias: string };
    originNote: string;
    auditDetails: Record<string, unknown>;
  },
): string {
  return ctx.db
    .transaction(() => {
      if (input.sale) assertUnrecordedPayment(ctx, input.sale.id);
      return insertPaymentCaseRecord(ctx, input);
    })
    .immediate();
}

function insertPaymentCaseRecord(
  ctx: AppContext,
  input: Parameters<typeof insertPaymentCase>[1],
): string {
  const now = ctx.clock.now().toISOString();
  const chargeId = newId("sandbox", "charge");
  const caseId = newId("sandbox", "case");
  const { facts, sale } = input;
  const charge: ChargeRecord = {
    id: chargeId,
    environment: "sandbox",
    accountAlias: "sandbox-buyer",
    merchantAlias: input.parties.merchantAlias,
    subscriptionId: input.subscriptionId,
    matchMethod: "provider_subscription_transaction",
    providerRefs: sale
      ? [{ kind: "subscription_sale_id", value: sale.id, provenance: "sandbox_api" }]
      : [],
    description: `${input.label} (Sandbox subscription transaction)`,
    eventTime: facts.eventTime,
    postedTime: null,
    ingestedTime: now,
    status: facts.status,
    amountCents: facts.amountCents,
    currency: "USD",
    refundedCents: facts.refundedCents,
    refundStateKnown: facts.refundStateKnown,
    servicePeriodStart: null,
    servicePeriodEnd: null,
    arrearsIndicator: null,
    sourceIds: [],
    dedupeKey: sale?.id ?? chargeId,
    createdAt: now,
    updatedAt: now,
  };
  charges.insert(ctx.db, charge);
  const rec: CaseRecord = {
    id: caseId,
    environment: "sandbox",
    accountAlias: "sandbox-buyer",
    chargeId,
    subscriptionId: input.subscriptionId,
    buyerAlias: input.parties.buyerAlias,
    merchantAlias: input.parties.merchantAlias,
    channel: "paypal",
    claimActive: false,
    claimClosedReason: null,
    buyerState: "FLAGGED",
    merchantState: "FLAGGED",
    classification: "NEEDS_REVIEW",
    reasonCodes: [],
    claimableCents: null,
    requestedCents: null,
    evidenceSnapshotVersion: 1,
    providerObservation: null,
    origin: "sandbox_setup",
    originNote: input.originNote,
    createdAt: now,
    updatedAt: now,
  };
  cases.insert(ctx.db, rec);
  logAudit(ctx, { action: "setup.case_created", caseId, details: input.auditDetails });
  reconcileCase(ctx, caseId, "sandbox_setup_import");
  return caseId;
}

/**
 * A recurring subscription bills once per cycle. Every payment PayPal reports for the
 * subscription that no local charge of the same subscription record holds yet becomes its own
 * charge and case on that record, so the cancellation recorded once applies to every later
 * payment and each payment is reconciled on its own facts. Payments are never merged into an
 * existing charge, and one sale never gets a second charge.
 */
function trackLaterPayments(
  ctx: AppContext,
  firstCaseId: string,
  transactions: ResumeResult["transactions"],
  parties: { buyerAlias: string; merchantAlias: string },
  label: string,
): string[] {
  const first = cases.get(ctx.db, firstCaseId);
  if (!first) return [];
  const known = new Set<string>();
  for (const c of charges.list(ctx.db)) {
    if (c.subscriptionId !== first.subscriptionId) continue;
    for (const r of c.providerRefs)
      if (r.kind === "subscription_sale_id" || r.kind === "seller_transaction_id")
        known.add(r.value);
    known.add(c.dedupeKey ?? c.id);
  }
  const created: string[] = [];
  const later = [...transactions].filter((t) => t.id && !known.has(t.id)).sort(comparePaymentTimes);
  for (const sale of later) {
    const existing = charges.getByDedupeKey(ctx.db, "sandbox", "sandbox-buyer", sale.id);
    if (existing?.subscriptionId === first.subscriptionId) continue;
    created.push(
      insertPaymentCase(ctx, {
        subscriptionId: first.subscriptionId,
        label,
        sale,
        facts: chargeFactsFromTransaction(sale),
        parties,
        originNote:
          "A later payment of a Sandbox subscription set up by the operator, read from the subscription's transactions. It shares the subscription's recorded cancellation facts.",
        auditDetails: { origin: "sandbox_setup", laterPayment: true },
      }),
    );
  }
  return created;
}

/** Tier B: import a dispute created manually in the Sandbox Resolution Center. */
export async function importDispute(
  ctx: AppContext,
  disputeId: string,
  options: { buyerAlias: string; merchantAlias: string; caseId?: string | null },
): Promise<{
  caseId: string;
  status: string | null;
  stage: string | null;
  allowedActions: string[];
}> {
  if (ctx.config.mode !== "sandbox")
    throw new AppError("WRONG_MODE", "Import runs in sandbox mode only.", 400);
  const read = await ctx.adapter.getDispute(disputeId);
  if (!read.ok)
    throw new AppError(
      `READBACK_${read.error.code}`,
      `Could not read the dispute: ${read.error.message}`,
      502,
    );
  const { observation, summary } = read.data;
  if (
    read.provenance !== "sandbox_api" ||
    observation.provenance !== "sandbox_api" ||
    observation.disputeId !== disputeId ||
    summary.disputeId !== disputeId
  )
    throw new AppError(
      "IMPORT_READ_MISMATCH",
      "The read did not identify the requested Sandbox dispute.",
      409,
    );
  const now = ctx.clock.now().toISOString();
  const tx = summary.transaction;
  const transactionRefs: ProviderRef[] = [];
  if (tx?.sellerTransactionId)
    transactionRefs.push({
      kind: "seller_transaction_id",
      value: tx.sellerTransactionId,
      provenance: "sandbox_api",
    });
  if (tx?.buyerTransactionId)
    transactionRefs.push({
      kind: "buyer_transaction_id",
      value: tx.buyerTransactionId,
      provenance: "sandbox_api",
    });
  const refs: ProviderRef[] = [
    { kind: "dispute_id", value: disputeId, provenance: "sandbox_api" },
    ...transactionRefs,
  ];
  const originNote =
    "The buyer case was opened manually in the PayPal Sandbox Resolution Center and imported by the operator. This import sends no buyer case creation request.";
  // All identity checks, attachments, claim registration and observation invalidation commit
  // together. An existing dispute/payment is resolved before any subscription row is inserted.
  return ctx.db
    .transaction(() => {
      const scopedCharges = charges
        .list(ctx.db)
        .filter(
          (charge) => charge.environment === "sandbox" && charge.accountAlias === "sandbox-buyer",
        );
      const disputeChargeIds = new Set(
        scopedCharges
          .filter(
            (charge) =>
              charge.dedupeKey === `dispute:${disputeId}` ||
              charge.providerRefs.some(
                (ref) => ref.kind === "dispute_id" && ref.value === disputeId,
              ),
          )
          .map((charge) => charge.id),
      );
      const existingCases = cases
        .list(ctx.db)
        .filter(
          (rec) =>
            rec.environment === "sandbox" &&
            rec.accountAlias === "sandbox-buyer" &&
            (disputeChargeIds.has(rec.chargeId) ||
              rec.providerObservation?.disputeId === disputeId),
        );
      if (existingCases.length > 1)
        throw new AppError(
          "IMPORT_AMBIGUOUS_PAYMENT",
          "This dispute has multiple local records; select and review the existing records before importing.",
          409,
        );
      if (options.caseId && existingCases[0] && existingCases[0].id !== options.caseId)
        throw new AppError(
          "DISPUTE_ALREADY_ATTACHED",
          "This dispute is already attached to a different local case.",
          409,
        );
      let caseId = options.caseId ?? existingCases[0]?.id ?? null;
      const paymentMatches = charges.findByPaymentRefs(
        ctx.db,
        "sandbox",
        "sandbox-buyer",
        transactionRefs,
      );
      if (!caseId && paymentMatches.length > 0) {
        if (paymentMatches.length > 1)
          throw new AppError(
            "IMPORT_AMBIGUOUS_PAYMENT",
            "Multiple local charges identify this payment; specify the matching case explicitly.",
            409,
          );
        const matchingCases = cases.listForCharge(ctx.db, paymentMatches[0]!.id);
        if (matchingCases.length !== 1)
          throw new AppError(
            "IMPORT_AMBIGUOUS_PAYMENT",
            "The matching payment does not identify one local case.",
            409,
          );
        caseId = matchingCases[0]!.id;
      }
      if (caseId) {
        const rec = cases.get(ctx.db, caseId);
        if (!rec) throw new AppError("CASE_NOT_FOUND", "Case not found.", 404);
        const charge = charges.get(ctx.db, rec.chargeId);
        const subscription = subscriptions.get(ctx.db, rec.subscriptionId);
        if (
          rec.environment !== "sandbox" ||
          rec.accountAlias !== "sandbox-buyer" ||
          charge?.environment !== rec.environment ||
          charge.accountAlias !== rec.accountAlias ||
          subscription?.environment !== rec.environment ||
          subscription.accountAlias !== rec.accountAlias
        )
          throw new AppError(
            "IMPORT_SCOPE_MISMATCH",
            "The case, charge and subscription must belong to this Sandbox account.",
            409,
          );
        if (transactionRefs.length === 0 && (options.caseId || existingCases.length === 0))
          throw new AppError(
            "IMPORT_TRANSACTION_MISSING",
            "The dispute has no transaction reference to match to the selected charge.",
            409,
          );
        if (
          transactionRefs.length > 0 &&
          !paymentMatches.some((match) => match.id === charge.id) &&
          // A previously imported, unidentified payment can acquire its first provider identity
          // from the same dispute on a later read. Explicit --case still needs a payment match.
          (options.caseId || charge.providerRefs.some((ref) => ref.kind !== "dispute_id"))
        )
          throw new AppError(
            "IMPORT_TRANSACTION_MISMATCH",
            "The dispute transaction does not match this case's charge.",
            409,
          );
        if (rec.providerObservation?.disputeId && rec.providerObservation.disputeId !== disputeId)
          throw new AppError(
            "IMPORT_DISPUTE_CONFLICT",
            "This local case is already attached to a different provider dispute.",
            409,
          );
      } else {
        if (disputeChargeIds.size > 0)
          throw new AppError(
            "IMPORT_AMBIGUOUS_PAYMENT",
            "The dispute already has a charge but no single local case.",
            409,
          );
        const subscriptionId = newId("sandbox", "sub");
        const chargeId = newId("sandbox", "charge");
        caseId = newId("sandbox", "case");
        // The payment time and status come only from the disputed transaction in the read. The
        // case creation time is not a payment time, and an absent status stays UNKNOWN.
        const facts = tx
          ? chargeFactsFrom({
              status: tx.status,
              time: tx.createTime,
              amountValue: tx.grossValue,
              amountCurrency: tx.grossCurrency,
            })
          : chargeFactsFrom({ status: null, time: null, amountValue: null, amountCurrency: null });
        const amount = facts.amountCents === null ? null : { cents: facts.amountCents };
        subscriptions.insert(ctx.db, {
          id: subscriptionId,
          environment: "sandbox",
          accountAlias: "sandbox-buyer",
          ownerAlias: options.buyerAlias,
          merchantAlias: options.merchantAlias,
          label: "Imported Sandbox case subscription",
          amountCents: amount?.cents ?? null,
          currency: "USD",
          providerRefs: [],
          providerStatus: null,
          providerStatusObservedAt: null,
          cancellation: initialCancellation(),
          sourceIds: [],
          lastSyncAt: null,
          createdAt: now,
          updatedAt: now,
        });
        charges.insert(ctx.db, {
          id: chargeId,
          environment: "sandbox",
          accountAlias: "sandbox-buyer",
          merchantAlias: options.merchantAlias,
          subscriptionId,
          matchMethod: "explicit_reviewed_association",
          providerRefs: refs,
          description: "Disputed Sandbox transaction (imported with the case)",
          eventTime: facts.eventTime,
          postedTime: null,
          ingestedTime: now,
          status: facts.status,
          amountCents: facts.amountCents,
          currency: "USD",
          refundedCents: facts.refundedCents,
          refundStateKnown: facts.refundStateKnown,
          servicePeriodStart: null,
          servicePeriodEnd: null,
          arrearsIndicator: null,
          sourceIds: [],
          dedupeKey: `dispute:${disputeId}`,
          createdAt: now,
          updatedAt: now,
        });
        cases.insert(ctx.db, {
          id: caseId,
          environment: "sandbox",
          accountAlias: "sandbox-buyer",
          chargeId,
          subscriptionId,
          buyerAlias: options.buyerAlias,
          merchantAlias: options.merchantAlias,
          channel: "paypal",
          claimActive: true,
          claimClosedReason: null,
          buyerState: "SYNCED",
          merchantState: "FLAGGED",
          classification: "NEEDS_REVIEW",
          reasonCodes: [],
          claimableCents: null,
          requestedCents: null,
          evidenceSnapshotVersion: 1,
          providerObservation: null,
          origin: "sandbox_import",
          originNote,
          createdAt: now,
          updatedAt: now,
        });
      }
      const rec = cases.get(ctx.db, caseId)!;
      const charge = charges.get(ctx.db, rec.chargeId)!;
      const mergedRefs = new Map(
        charge.providerRefs.map((ref) => [`${ref.kind}:${ref.value}`, ref]),
      );
      for (const ref of refs) mergedRefs.set(`${ref.kind}:${ref.value}`, ref);
      const providerRefs = Array.from(mergedRefs.values());
      const identityChanged = JSON.stringify(providerRefs) !== JSON.stringify(charge.providerRefs);
      let paymentFacts = {
        status: charge.status,
        eventTime: charge.eventTime,
        amountCents: charge.amountCents,
        refundedCents: charge.refundedCents,
        refundStateKnown: charge.refundStateKnown,
      };
      const previousFacts = JSON.stringify(paymentFacts);
      const orderedAfter = (at: string) => {
        const order = compareInstants(observation.observedAt, at);
        return order === "after" || order === "equal";
      };
      if (
        tx &&
        orderedAfter(charge.updatedAt) &&
        (!rec.providerObservation || orderedAfter(rec.providerObservation.observedAt))
      ) {
        const incoming = chargeFactsFrom({
          status: tx.status ?? charge.status,
          time: tx.createTime ?? charge.eventTime,
          amountValue:
            tx.grossValue ??
            (charge.amountCents === null ? null : centsToDecimalString(charge.amountCents)),
          amountCurrency: tx.grossCurrency ?? charge.currency,
        });
        // Omission can enrich a previously unidentified payment, but a later import must not
        // erase a verified refund/reversal or turn an unresolved partial refund back into $0.
        const refundWouldRegress =
          (charge.status === "REFUNDED" && incoming.status !== "REFUNDED") ||
          (charge.status === "PARTIALLY_REFUNDED" &&
            !["PARTIALLY_REFUNDED", "REFUNDED"].includes(incoming.status)) ||
          (charge.status === "REVERSED" && !["REVERSED", "REFUNDED"].includes(incoming.status)) ||
          (charge.refundedCents !== null &&
            incoming.refundedCents !== null &&
            incoming.refundedCents < charge.refundedCents);
        paymentFacts = refundWouldRegress
          ? {
              ...incoming,
              status: charge.status,
              refundedCents: charge.refundedCents,
              refundStateKnown: charge.refundStateKnown,
            }
          : incoming;
      }
      const factsChanged = JSON.stringify(paymentFacts) !== previousFacts;
      charges.update(ctx.db, { ...charge, ...paymentFacts, providerRefs, updatedAt: now });
      if (factsChanged) {
        for (const related of cases.listForCharge(ctx.db, charge.id)) {
          const reconciled = reconcileCase(ctx, related.id, "dispute_import_payment_facts");
          if (reconciled.caseRecord.evidenceSnapshotVersion === related.evidenceSnapshotVersion)
            bumpSnapshot(ctx, reconciled.caseRecord, "dispute_import_payment_facts");
        }
      }
      // Registration rejects conflicting OPEN/UNKNOWN/PREPARED slots before any imported state
      // commits. A resolved observation releases only this same provider claim below.
      registerExistingClaim(ctx, { chargeId: rec.chargeId, caseId, providerRef: disputeId });
      const originChanged = rec.origin !== "sandbox_import" || rec.originNote !== originNote;
      cases.update(ctx.db, {
        ...cases.get(ctx.db, caseId)!,
        channel: "paypal",
        origin: "sandbox_import",
        originNote,
        updatedAt: now,
      });
      const applied = applyObservation(ctx, caseId, observation, {
        correlationId: read.correlationId,
        toolkitCrossCheck: summary.toolkitCrossCheck,
      });
      // Use the merged observation: an older re-import must not reopen a claim whose latest
      // provider read already resolved it. Unknown provider states remain conservatively open.
      const resolved = applied.observation.status === "RESOLVED";
      if (resolved)
        releaseClaimOnProviderResolution(ctx, {
          chargeId: rec.chargeId,
          caseId,
          providerRef: disputeId,
          status: "RESOLVED",
        });
      cases.update(ctx.db, {
        ...cases.get(ctx.db, caseId)!,
        claimActive: !resolved,
        claimClosedReason: resolved ? "Provider reported the case RESOLVED." : null,
        updatedAt: now,
      });
      if (!applied.materialChanged && (identityChanged || originChanged))
        bumpSnapshot(ctx, cases.get(ctx.db, caseId)!, "dispute_import_identity_changed");
      logAudit(ctx, {
        action: "setup.dispute_imported",
        caseId,
        details: {
          status: observation.status,
          stage: observation.stage,
          allowedActions: observation.allowedActions,
          correlationId: read.correlationId,
        },
      });
      return {
        caseId,
        status: applied.observation.status,
        stage: applied.observation.stage,
        allowedActions: applied.observation.allowedActions,
      };
    })
    .immediate();
}

/** Separately approved Sandbox test mutation: cancel the manifest subscription at the provider. */
export async function cancelSandboxSubscription(
  ctx: AppContext,
  reason: string,
): Promise<OperationRecord> {
  const manifest = readManifest(ctx);
  if (!manifest?.subscriptionId)
    throw new AppError("NO_MANIFEST", "No Sandbox subscription in the private manifest.", 404);
  const key = `${ctx.config.mode}:setup:cancel:${manifest.subscriptionId}`;
  const payload = { subscriptionId: manifest.subscriptionId, reason };
  const approval = cliApproval(ctx, "sandbox_cancel_subscription", hashCanonical(payload), key);
  const { op, created } = reserveSetupOperation(
    ctx,
    "sandbox_cancel_subscription",
    key,
    payload,
    approval,
  );
  if (!created && op.status !== "PREPARED") return op;
  const now = ctx.clock.now().toISOString();
  if (!operationRepo.acquireDispatch(ctx.db, op.id, addMinutes(now, 2), now))
    return operationRepo.get(ctx.db, op.id) ?? op;
  const outcome = await ctx.adapter.cancelSubscription(manifest.subscriptionId, reason, {
    operationId: op.id,
    requestId: `cc-${sha256Hex(op.id).slice(0, 20)}`,
  });
  const current = operationRepo.get(ctx.db, op.id)!;
  const finished =
    outcome.kind === "succeeded"
      ? finishSetupOperation(ctx, current, {
          status: "SUCCEEDED",
          result: { ...outcome.result, correlationId: outcome.correlationId },
        })
      : outcome.kind === "failed"
        ? finishSetupOperation(ctx, current, {
            status: "FAILED",
            errorCode: outcome.error.code,
            errorMessage: outcome.error.message,
          })
        : finishSetupOperation(ctx, current, {
            status: "UNKNOWN",
            errorCode: outcome.error.code,
            errorMessage: outcome.error.message,
          });
  manifest.operations.push({
    id: finished.id,
    action: finished.action,
    status: finished.status,
    at: finished.updatedAt,
  });
  manifest.updatedAt = ctx.clock.now().toISOString();
  writeManifest(ctx, manifest);
  return finished;
}

export interface EvidenceSimulationResult {
  operation: OperationRecord;
  /** Provider status read immediately before the request. */
  statusBefore: string | null;
  /** Provider status read after a succeeded request (null when the request did not succeed). */
  statusAfter: string | null;
  allowedAfter: ProviderAllowedAction[];
}

/**
 * Sandbox test mutation: ask PayPal to move a case that is under review back to waiting for the
 * seller's evidence, so the evidence path can be exercised again. This is PayPal's Sandbox
 * simulation of its own decision, never a product action:
 *  - sandbox mode only, and only for a case whose provider reference came from the API;
 *  - a fresh read must list the require_evidence capability right now, otherwise nothing is sent;
 *  - one ledger operation with a CLI approval per attempt, exactly one request, and no new
 *    attempt while an earlier one is unsettled;
 *  - after a succeeded request the case is read back, so the case shows what PayPal reports.
 */
export async function requestSellerEvidenceSimulation(
  ctx: AppContext,
  caseId: string,
): Promise<EvidenceSimulationResult> {
  if (ctx.config.mode !== "sandbox")
    throw new AppError(
      "WRONG_MODE",
      "The evidence-request simulation runs in sandbox mode only.",
      400,
    );
  const rec = cases.get(ctx.db, caseId);
  if (!rec) throw new AppError("CASE_NOT_FOUND", "Case not found.", 404);
  const known = rec.providerObservation;
  if (!known?.disputeId || known.provenance !== "sandbox_api")
    throw new AppError(
      "NO_PROVIDER_CASE",
      "This case has no provider case read from PayPal Sandbox; nothing was sent.",
      409,
    );
  const disputeId = known.disputeId;
  const before = await refreshProviderObservation(ctx, caseId, disputeId);
  if (before.error || !before.observation || before.observation.stale)
    throw new AppError(
      "PROVIDER_READ_FAILED",
      `The provider case could not be read right now (${before.error ?? "stale"}); nothing was sent.`,
      409,
    );
  if (!before.observation.allowedActions.includes("require_evidence"))
    throw new AppError(
      "SIMULATION_NOT_OFFERED",
      `PayPal does not offer the evidence-request simulation for this case right now (status ${before.observation.status ?? "unknown"}); nothing was sent.`,
      409,
    );
  const earlier = operationRepo
    .listForCase(ctx.db, SETUP_CASE_SENTINEL)
    .filter(
      (op) =>
        op.action === "sandbox_require_evidence" &&
        (op.payload as { disputeId?: unknown }).disputeId === disputeId,
    );
  if (earlier.some((op) => op.status !== "SUCCEEDED" && op.status !== "FAILED"))
    throw new AppError(
      "SIMULATION_UNSETTLED",
      "An earlier evidence-request simulation for this case has no known result. Read the case in the Sandbox Resolution Center before trying again; nothing was sent.",
      409,
    );
  const attempt = earlier.length + 1;
  const key = `${ctx.config.mode}:setup:require-evidence:${disputeId}:${attempt}`;
  const payload = { disputeId, caseId, party: "SELLER_EVIDENCE" as const, attempt };
  const approval = cliApproval(ctx, "sandbox_require_evidence", hashCanonical(payload), key);
  const { op, created } = reserveSetupOperation(
    ctx,
    "sandbox_require_evidence",
    key,
    payload,
    approval,
  );
  const unsent = { statusBefore: before.observation.status, statusAfter: null, allowedAfter: [] };
  if (!created && op.status !== "PREPARED") return { operation: op, ...unsent };
  const now = ctx.clock.now().toISOString();
  if (!operationRepo.acquireDispatch(ctx.db, op.id, addMinutes(now, 2), now))
    return { operation: operationRepo.get(ctx.db, op.id) ?? op, ...unsent };
  let outcome: WriteOutcome<{ disputeId: string }>;
  try {
    outcome = await ctx.adapter.requireEvidence(disputeId, payload.party, {
      operationId: op.id,
      requestId: `cc-${sha256Hex(op.id).slice(0, 20)}`,
    });
  } catch (err) {
    // The request may have reached the provider before the exception.
    outcome = {
      kind: "unknown",
      error: {
        code: "EXCEPTION",
        message: err instanceof Error ? err.message.slice(0, 200) : "Unexpected error.",
        correlationId: null,
        httpStatus: null,
      },
    };
  }
  const current = operationRepo.get(ctx.db, op.id)!;
  const operation =
    outcome.kind === "succeeded"
      ? finishSetupOperation(ctx, current, {
          status: "SUCCEEDED",
          result: { ...outcome.result, correlationId: outcome.correlationId },
        })
      : finishSetupOperation(ctx, current, {
          status: outcome.kind === "failed" ? "FAILED" : "UNKNOWN",
          errorCode: outcome.error.code,
          errorMessage: outcome.error.message,
          result: {
            correlationId: outcome.error.correlationId,
            httpStatus: outcome.error.httpStatus,
          },
        });
  logAudit(ctx, {
    action: "sandbox.evidence_request_simulated",
    role: "merchant",
    caseId,
    operationId: operation.id,
    reasonCode: operation.status,
    details: { attempt, testMutation: true },
  });
  if (operation.status !== "SUCCEEDED") return { operation, ...unsent };
  const after = await refreshProviderObservation(ctx, caseId, disputeId);
  // A failed or uncertain read-back reports nothing rather than repeating the earlier state.
  const readBack = !after.error && after.observation && !after.observation.stale;
  return {
    operation,
    statusBefore: before.observation.status,
    statusAfter: readBack ? after.observation!.status : null,
    allowedAfter: readBack ? after.observation!.allowedActions : [],
  };
}

export interface AdjudicationSimulationResult {
  operation: OperationRecord;
  /** Provider status read immediately before the request. */
  statusBefore: string | null;
  /** Provider status read after a succeeded request (null when the request did not succeed). */
  statusAfter: string | null;
  /** The provider's outcome code read after a succeeded request. */
  outcomeAfter: string | null;
  allowedAfter: ProviderAllowedAction[];
}

/**
 * Sandbox test mutation: ask PayPal to settle a case that is under review in one party's favour
 * (POST …/adjudicate). This is PayPal's Sandbox simulation of its own decision, never a product
 * action, and it has no Live counterpart. The same rules as the evidence-request simulation:
 *  - sandbox mode only, and only for a case whose provider reference came from the API;
 *  - the outcome is one of the two documented values, chosen by the operator;
 *  - a fresh read must list the adjudicate capability right now, otherwise nothing is sent;
 *  - one ledger operation with a CLI approval per attempt, exactly one request, and no new
 *    attempt while an earlier one is unsettled;
 *  - after a succeeded request the case is read back, so the case shows what PayPal reports.
 */
export async function requestAdjudicationSimulation(
  ctx: AppContext,
  caseId: string,
  outcome: AdjudicationOutcome,
): Promise<AdjudicationSimulationResult> {
  if (ctx.config.mode !== "sandbox")
    throw new AppError("WRONG_MODE", "The settlement simulation runs in sandbox mode only.", 400);
  if (!ADJUDICATION_OUTCOMES.includes(outcome))
    throw new AppError(
      "INVALID_OUTCOME",
      "The settlement simulation takes BUYER_FAVOR or SELLER_FAVOR; nothing was sent.",
      400,
    );
  const rec = cases.get(ctx.db, caseId);
  if (!rec) throw new AppError("CASE_NOT_FOUND", "Case not found.", 404);
  const known = rec.providerObservation;
  if (!known?.disputeId || known.provenance !== "sandbox_api")
    throw new AppError(
      "NO_PROVIDER_CASE",
      "This case has no provider case read from PayPal Sandbox; nothing was sent.",
      409,
    );
  const disputeId = known.disputeId;
  const before = await refreshProviderObservation(ctx, caseId, disputeId);
  if (before.error || !before.observation || before.observation.stale)
    throw new AppError(
      "PROVIDER_READ_FAILED",
      `The provider case could not be read right now (${before.error ?? "stale"}); nothing was sent.`,
      409,
    );
  if (!before.observation.allowedActions.includes("adjudicate"))
    throw new AppError(
      "SIMULATION_NOT_OFFERED",
      `PayPal does not offer the settlement simulation for this case right now (status ${before.observation.status ?? "unknown"}); nothing was sent.`,
      409,
    );
  const earlier = operationRepo
    .listForCase(ctx.db, SETUP_CASE_SENTINEL)
    .filter(
      (op) =>
        op.action === "sandbox_adjudicate" &&
        (op.payload as { disputeId?: unknown }).disputeId === disputeId,
    );
  if (earlier.some((op) => op.status !== "SUCCEEDED" && op.status !== "FAILED"))
    throw new AppError(
      "SIMULATION_UNSETTLED",
      "An earlier settlement simulation for this case has no known result. Read the case in the Sandbox Resolution Center before trying again; nothing was sent.",
      409,
    );
  const attempt = earlier.length + 1;
  const key = `${ctx.config.mode}:setup:adjudicate:${disputeId}:${attempt}`;
  const payload = { disputeId, caseId, outcome, attempt };
  const approval = cliApproval(ctx, "sandbox_adjudicate", hashCanonical(payload), key);
  const { op, created } = reserveSetupOperation(ctx, "sandbox_adjudicate", key, payload, approval);
  const unsent = {
    statusBefore: before.observation.status,
    statusAfter: null,
    outcomeAfter: null,
    allowedAfter: [],
  };
  if (!created && op.status !== "PREPARED") return { operation: op, ...unsent };
  const now = ctx.clock.now().toISOString();
  if (!operationRepo.acquireDispatch(ctx.db, op.id, addMinutes(now, 2), now))
    return { operation: operationRepo.get(ctx.db, op.id) ?? op, ...unsent };
  let result: WriteOutcome<{ disputeId: string }>;
  try {
    result = await ctx.adapter.adjudicate(disputeId, outcome, {
      operationId: op.id,
      requestId: `cc-${sha256Hex(op.id).slice(0, 20)}`,
    });
  } catch (err) {
    // The request may have reached the provider before the exception.
    result = {
      kind: "unknown",
      error: {
        code: "EXCEPTION",
        message: err instanceof Error ? err.message.slice(0, 200) : "Unexpected error.",
        correlationId: null,
        httpStatus: null,
      },
    };
  }
  const current = operationRepo.get(ctx.db, op.id)!;
  const operation =
    result.kind === "succeeded"
      ? finishSetupOperation(ctx, current, {
          status: "SUCCEEDED",
          result: { ...result.result, correlationId: result.correlationId },
        })
      : finishSetupOperation(ctx, current, {
          status: result.kind === "failed" ? "FAILED" : "UNKNOWN",
          errorCode: result.error.code,
          errorMessage: result.error.message,
          result: {
            correlationId: result.error.correlationId,
            httpStatus: result.error.httpStatus,
          },
        });
  logAudit(ctx, {
    action: "sandbox.settlement_simulated",
    role: "merchant",
    caseId,
    operationId: operation.id,
    reasonCode: operation.status,
    details: { attempt, outcome, testMutation: true },
  });
  if (operation.status !== "SUCCEEDED") return { operation, ...unsent };
  const after = await refreshProviderObservation(ctx, caseId, disputeId);
  // A failed or uncertain read-back reports nothing rather than repeating the earlier state.
  const readBack = !after.error && after.observation && !after.observation.stale;
  return {
    operation,
    statusBefore: before.observation.status,
    statusAfter: readBack ? after.observation!.status : null,
    outcomeAfter: readBack ? after.observation!.outcome : null,
    allowedAfter: readBack ? after.observation!.allowedActions : [],
  };
}

/**
 * Record the buyer-side PayPal transaction ID for a connected case's charge. The merchant API
 * cannot observe the buyer's perspective, so the operator reads it from the Sandbox buyer account
 * and records it here as an operator attestation (shape-checked; synthetic aliases refused).
 */
export function recordBuyerTransactionReference(
  ctx: AppContext,
  caseId: string,
  buyerTransactionId: string,
): ChargeRecord {
  if (ctx.config.mode !== "sandbox")
    throw new AppError("WRONG_MODE", "Buyer references are recorded in sandbox mode only.", 400);
  const value = buyerTransactionId.trim().toUpperCase();
  if (!/^[A-Z0-9]{17}$/.test(value))
    throw new AppError(
      "INVALID_REFERENCE",
      "A PayPal transaction ID is 17 upper-case alphanumeric characters.",
      400,
    );
  const rec = cases.get(ctx.db, caseId);
  if (!rec) throw new AppError("CASE_NOT_FOUND", "Case not found.", 404);
  const charge = charges.get(ctx.db, rec.chargeId);
  if (!charge) throw new AppError("CHARGE_NOT_FOUND", "Charge not found.", 404);
  const refs = charge.providerRefs.filter((r) => r.kind !== "buyer_transaction_id");
  refs.push({ kind: "buyer_transaction_id", value, provenance: "user_attestation" });
  const updated: ChargeRecord = {
    ...charge,
    providerRefs: refs,
    updatedAt: ctx.clock.now().toISOString(),
  };
  charges.update(ctx.db, updated);
  logAudit(ctx, {
    action: "setup.buyer_reference_recorded",
    caseId,
    details: { provenance: "user_attestation", masked: `${value.slice(0, 3)}…${value.slice(-3)}` },
  });
  return updated;
}

/** Read the provider subscription back and record the mandate observation beside the cancellation facts. */
export async function refreshSubscriptionObservation(
  ctx: AppContext,
  caseId: string,
): Promise<{
  status: string | null;
  observedAt: string | null;
  provenance: string;
  /** The provider's next planned billing as read (null when unknown or on a failed read). */
  nextBillingAt: string | null;
  error: string | null;
}> {
  const rec = cases.get(ctx.db, caseId);
  if (!rec) throw new AppError("CASE_NOT_FOUND", "Case not found.", 404);
  const sub = subscriptions.get(ctx.db, rec.subscriptionId);
  if (!sub) throw new AppError("SUBSCRIPTION_NOT_FOUND", "Subscription not found.", 404);
  const ref = sub.providerRefs.find((r) => r.kind === "subscription_id");
  if (!ref)
    return {
      status: null,
      observedAt: null,
      provenance: "none",
      nextBillingAt: null,
      error: "No provider subscription reference is recorded.",
    };
  const read = await ctx.adapter.getSubscription(ref.value);
  if (!read.ok) {
    logAudit(ctx, {
      action: "subscription.refresh_failed",
      caseId,
      reasonCode: read.error.code,
      details: { correlationId: read.error.correlationId },
    });
    return {
      status: sub.providerStatus,
      observedAt: sub.providerStatusObservedAt,
      provenance: ref.provenance,
      nextBillingAt: null,
      error: read.error.message,
    };
  }
  const cancellation = reduceCancellation(sub.cancellation, {
    type: "OBSERVE_PROVIDER_MANDATE",
    status: read.data.status ?? "UNKNOWN",
    observedAt: read.observedAt,
    provenance: read.provenance,
    nextBillingAt: read.data.nextBillingTime,
  });
  subscriptions.update(ctx.db, {
    ...sub,
    cancellation,
    providerStatus: read.data.status,
    providerStatusObservedAt: read.observedAt,
    lastSyncAt: read.observedAt,
    updatedAt: ctx.clock.now().toISOString(),
  });
  logAudit(ctx, {
    action: "subscription.refreshed",
    caseId,
    details: {
      status: read.data.status,
      provenance: read.provenance,
      correlationId: read.correlationId,
    },
  });
  return {
    status: read.data.status,
    observedAt: read.observedAt,
    provenance: read.provenance,
    nextBillingAt: read.data.nextBillingTime,
    error: null,
  };
}

export interface PaymentsReadResult {
  status: string | null;
  observedAt: string | null;
  nextBillingAt: string | null;
  /** Payments the provider lists for the subscription in the last 90 days. */
  transactionCount: number;
  /** Cases created in this read: one per payment no local charge held yet. */
  newCaseIds: string[];
}

/**
 * Read a subscription's mandate and payments from the provider for one case, from the app.
 * These are reads only; nothing is sent that changes anything at the provider:
 *  - the mandate observation (status, next planned billing) is recorded beside the cancellation
 *    facts, never merged into them;
 *  - every payment case of the subscription takes the facts of its own payment;
 *  - each payment no local charge holds yet becomes its own charge and case on the same
 *    subscription, so the cancellation recorded once is checked against it.
 * A failed read changes nothing and is reported; it never yields a partial result.
 */
export async function readSubscriptionPayments(
  ctx: AppContext,
  caseId: string,
  role: "buyer" | "merchant",
): Promise<PaymentsReadResult> {
  if (ctx.config.mode !== "sandbox")
    throw new AppError(
      "WRONG_MODE",
      "Payments are read from the provider in sandbox mode only.",
      400,
    );
  if (role !== "buyer")
    throw new AppError("ROLE_NOT_ALLOWED", "Only the buyer view reads payments into cases.", 403);
  const rec = cases.get(ctx.db, caseId);
  if (!rec) throw new AppError("CASE_NOT_FOUND", "Case not found.", 404);
  const sub = subscriptions.get(ctx.db, rec.subscriptionId);
  if (!sub) throw new AppError("SUBSCRIPTION_NOT_FOUND", "Subscription not found.", 404);
  const ref = sub.providerRefs.find(
    (r) => r.kind === "subscription_id" && r.provenance === "sandbox_api",
  );
  if (!ref)
    throw new AppError(
      "NO_PROVIDER_SUBSCRIPTION",
      "This case has no subscription that was read from PayPal Sandbox, so there are no payments to read.",
      409,
    );
  const end = ctx.clock.now();
  const start = new Date(end.getTime() - 90 * 24 * 3600 * 1000);
  // Read the payments first: if that fails nothing has been recorded yet.
  const txs = await ctx.adapter.listSubscriptionTransactions(
    ref.value,
    start.toISOString(),
    end.toISOString(),
  );
  if (!txs.ok) {
    logAudit(ctx, {
      action: "subscription.payments_read_failed",
      caseId,
      reasonCode: txs.error.code,
      details: { correlationId: txs.error.correlationId },
    });
    throw new AppError(
      "PROVIDER_READ_FAILED",
      `The subscription's payments could not be read (${txs.error.code}). Nothing was changed.`,
      502,
    );
  }
  const mandate = await refreshSubscriptionObservation(ctx, caseId);
  if (mandate.error)
    throw new AppError(
      "PROVIDER_READ_FAILED",
      `The subscription could not be read (${mandate.error}). Nothing was changed.`,
      502,
    );
  for (const other of cases.list(ctx.db)) {
    if (other.subscriptionId === sub.id)
      syncChargeFromTransactions(ctx, other.id, txs.data, txs.provenance, "payments_read");
  }
  const newCaseIds = trackLaterPayments(
    ctx,
    caseId,
    txs.data,
    { buyerAlias: rec.buyerAlias, merchantAlias: rec.merchantAlias },
    sub.label,
  );
  logAudit(ctx, {
    action: "subscription.payments_read",
    caseId,
    details: {
      transactionCount: txs.data.length,
      newCases: newCaseIds.length,
      provenance: txs.provenance,
    },
  });
  return {
    status: mandate.status,
    observedAt: mandate.observedAt,
    nextBillingAt: mandate.nextBillingAt,
    transactionCount: txs.data.length,
    newCaseIds,
  };
}
