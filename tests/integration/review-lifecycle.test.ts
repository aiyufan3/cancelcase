import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/context";
import {
  decideApproval,
  generateDraft,
  recordCancellation,
  requireBundle,
  transferChannel,
} from "@/server/services/case-service";
import { readDemoHints } from "@/server/services/fixture-seed";
import {
  dispatchOperation,
  prepareOperation,
  refreshProviderObservation,
} from "@/server/services/operation-service";
import {
  approvals,
  audit,
  cases,
  claims,
  drafts,
  evidence as evidenceRepo,
} from "@/server/db/repos";
import { startCaseThread, resumeCaseThread } from "@/graph/case-graph";
import { AppError } from "@/server/services/errors";
import { buildCaseView } from "@/server/services/case-view";
import { overwriteEvidenceBytesForTest } from "@/server/services/evidence-store";
import type { AppContext } from "@/server/context";

/**
 * Review, version and approval must describe the same content (independent audit AUD10, AUD13
 * at service level, and the A1/A2 lifecycle findings): approvals only for a pending review,
 * a real regenerate, exact-version approval, a material binding that ignores observation time,
 * re-verification after asynchronous preflight, and provider results saved before local
 * bookkeeping.
 */

let h: TestHarness;
afterEach(() => h?.cleanup());

async function asyncCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : String(err);
  }
}
function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : String(err);
  }
}

function escalate(ctx: AppContext, caseId: string) {
  transferChannel(ctx, { caseId, role: "buyer", channel: "paypal", reason: "escalation" });
}

/** Buyer opens a simulated provider case so the merchant has something to answer. */
async function openSimulatedCase(ctx: AppContext, caseId: string) {
  escalate(ctx, caseId);
  const draft = await generateDraft(ctx, { caseId, role: "buyer", action: "buyer_create_dispute" });
  const a = decideApproval(ctx, {
    caseId,
    role: "buyer",
    action: "buyer_create_dispute",
    draftId: draft.id,
    decision: "approved",
  });
  const { operation } = prepareOperation(ctx, {
    caseId,
    role: "buyer",
    action: "buyer_create_dispute",
    approvalId: a.id,
  });
  const done = await dispatchOperation(ctx, operation.id);
  expect(done.status).toBe("SUCCEEDED");
  return (done.result as { disputeId: string }).disputeId;
}

async function approveMerchant(ctx: AppContext, caseId: string) {
  const draft = await generateDraft(ctx, {
    caseId,
    role: "merchant",
    action: "merchant_provide_evidence",
  });
  return decideApproval(ctx, {
    caseId,
    role: "merchant",
    action: "merchant_provide_evidence",
    draftId: draft.id,
    decision: "approved",
  });
}

function countWrites(ctx: AppContext) {
  const counter = { evidence: 0, creates: 0 };
  const pe = ctx.adapter.provideEvidence.bind(ctx.adapter);
  ctx.adapter.provideEvidence = async (...args) => {
    counter.evidence += 1;
    return pe(...args);
  };
  const cd = ctx.adapter.createBuyerDispute.bind(ctx.adapter);
  ctx.adapter.createBuyerDispute = async (...args) => {
    counter.creates += 1;
    return cd(...args);
  };
  return counter;
}

describe("approval only while a review is pending", () => {
  it("AUD10/A1: after a FAILED submission no approval is issued until a new version is reviewed; then it goes through", async () => {
    h = createTestHarness();
    escalate(h.ctx, h.caseId);
    const t1 = await startCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
    });
    const v1 = t1.interruptPayload!.draftId!;
    const a1 = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      draftId: v1,
      decision: "approved",
    });
    const failed = await resumeCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      decision: { kind: "approve", approvalId: a1.id, simulate: "unsupported" },
    });
    expect(failed.state.operationStatus).toBe("FAILED");
    expect(requireBundle(h.ctx, h.caseId).caseRecord.buyerState).toBe("BLOCKED");
    expect(
      code(() =>
        decideApproval(h.ctx, {
          caseId: h.caseId,
          role: "buyer",
          action: "buyer_create_dispute",
          draftId: v1,
          decision: "approved",
        }),
      ),
    ).toBe("REVIEW_NOT_PENDING");
    // "Generate"/"Regenerate" after the failure starts a new review with a new version.
    const t2 = await startCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
    });
    expect(t2.regenerated).toBe(true);
    const v2 = t2.interruptPayload!.draftId!;
    expect(v2).not.toBe(v1);
    const a2 = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      draftId: v2,
      decision: "approved",
    });
    const ok = await resumeCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      decision: { kind: "approve", approvalId: a2.id },
    });
    expect(ok.state.operationStatus).toBe("SUCCEEDED");
  });

  it("A2: regenerate during a pending review really produces a new version and revokes the earlier approval", async () => {
    h = createTestHarness();
    const t1 = await startCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const v1 = t1.interruptPayload!.draftId!;
    const a1 = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: v1,
      decision: "approved",
    });
    const same = await startCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    expect(same.regenerated).toBe(false);
    const t2 = await startCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      regenerate: true,
    });
    expect(t2.regenerated).toBe(true);
    expect(t2.interrupted).toBe(true);
    const v2 = t2.interruptPayload!.draftId!;
    expect(v2).not.toBe(v1);
    expect(drafts.get(h.ctx.db, v2)!.version).toBe(drafts.get(h.ctx.db, v1)!.version + 1);
    expect(approvals.get(h.ctx.db, a1.id)!.revokedReason).toBe("draft_changed");
  });

  it("a decision names the exact version: an older version or a different hash is refused", async () => {
    h = createTestHarness();
    const v1 = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const v2 = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    expect(
      code(() =>
        decideApproval(h.ctx, {
          caseId: h.caseId,
          role: "buyer",
          action: "export_refund_request",
          draftId: v1.id,
          decision: "approved",
          expectedContentHash: v1.contentHash,
        }),
      ),
    ).toBe("DRAFT_STALE");
    expect(
      code(() =>
        decideApproval(h.ctx, {
          caseId: h.caseId,
          role: "buyer",
          action: "export_refund_request",
          draftId: v2.id,
          decision: "approved",
          expectedContentHash: v1.contentHash,
        }),
      ),
    ).toBe("DRAFT_CHANGED");
    const approved = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: v2.id,
      decision: "approved",
      expectedContentHash: v2.contentHash,
    });
    expect(approved.binding.payloadVersion).toBe(v2.version);
  });

  it("same-millisecond approvals for one draft resolve to the later insertion", async () => {
    h = createTestHarness();
    const v1 = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const first = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: v1.id,
      decision: "approved",
    });
    const second = { ...first, id: `${first.id}-second`, revokedReason: null };
    approvals.insert(h.ctx.db, second);
    expect(approvals.latestForDraft(h.ctx.db, v1.id)?.id).toBe(second.id);
  });
});

describe("material binding", () => {
  it("a change to the cancellation basis evidence revokes approval even if reconciliation is unchanged", async () => {
    h = createTestHarness();
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const a = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: draft.id,
      decision: "approved",
    });
    const hints = readDemoHints(h.ctx)!;
    const receipt = evidenceRepo
      .listForCase(h.ctx.db, h.caseId, requireBundle(h.ctx, h.caseId).subscription.id)
      .find((e) => e.kind === "receipt")!;
    const before = requireBundle(h.ctx, h.caseId).caseRecord.classification;
    recordCancellation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      event: {
        type: "RECORD_CONFIRMATION",
        receivedAt: hints.confirmation.receivedAt,
        effectiveAt: hints.confirmation.effectiveAt,
        basis: hints.confirmation.basis,
        evidenceIds: [...hints.confirmation.evidenceIds, receipt.id],
      },
    });
    expect(requireBundle(h.ctx, h.caseId).caseRecord.classification).toBe(before);
    expect(approvals.get(h.ctx.db, a.id)!.revokedReason).not.toBeNull();
  });

  it("a refresh that only moves the observation time keeps the approval; new requested evidence revokes it", async () => {
    h = createTestHarness();
    const disputeId = await openSimulatedCase(h.ctx, h.caseId);
    const a = await approveMerchant(h.ctx, h.caseId);
    h.clock.advanceMinutes(1);
    await refreshProviderObservation(h.ctx, h.caseId, disputeId);
    expect(approvals.get(h.ctx.db, a.id)!.revokedReason).toBeNull();
    // The provider now asks for more evidence.
    const read = h.ctx.adapter.getDispute.bind(h.ctx.adapter);
    h.ctx.adapter.getDispute = async (id) => {
      const r = await read(id);
      if (!r.ok) return r;
      return {
        ...r,
        data: {
          ...r.data,
          observation: {
            ...r.data.observation,
            requestedEvidenceTypes: [
              ...r.data.observation.requestedEvidenceTypes,
              "PROOF_OF_REFUND",
            ],
          },
        },
      };
    };
    h.clock.advanceMinutes(1);
    await refreshProviderObservation(h.ctx, h.caseId, disputeId);
    expect(approvals.get(h.ctx.db, a.id)!.revokedReason).toBe("provider_state_changed");
  });
});

describe("asynchronous preflight", () => {
  it("facts changed during the pre-submit read stop the write; nothing is sent", async () => {
    h = createTestHarness();
    const disputeId = await openSimulatedCase(h.ctx, h.caseId);
    const writes = countWrites(h.ctx);
    const a = await approveMerchant(h.ctx, h.caseId);
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
      approvalId: a.id,
    });
    const read = h.ctx.adapter.getDispute.bind(h.ctx.adapter);
    h.ctx.adapter.getDispute = async (id) => {
      const r = await read(id);
      if (!r.ok) return r;
      // While the preflight read is in flight, the provider adds a requirement.
      return {
        ...r,
        data: {
          ...r.data,
          observation: { ...r.data.observation, requestedEvidenceTypes: ["PROOF_OF_FULFILLMENT"] },
        },
      };
    };
    const result = await dispatchOperation(h.ctx, operation.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("PREFLIGHT_MATERIAL_CHANGED");
    expect(writes.evidence).toBe(0);
    void disputeId;
  });

  it("attachment bytes replaced during the preflight read are caught before sending", async () => {
    h = createTestHarness();
    await openSimulatedCase(h.ctx, h.caseId);
    const writes = countWrites(h.ctx);
    const a = await approveMerchant(h.ctx, h.caseId);
    const approved = approvals.get(h.ctx.db, a.id)!;
    expect(approved.binding.attachmentHashes.length).toBeGreaterThan(0);
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
      approvalId: a.id,
    });
    const draft = drafts.latest(h.ctx.db, h.caseId, "merchant", "merchant_provide_evidence")!;
    const target = evidenceRepo.get(h.ctx.db, draft.content.attachmentEvidenceIds[0]!)!;
    const read = h.ctx.adapter.getDispute.bind(h.ctx.adapter);
    h.ctx.adapter.getDispute = async (id) => {
      overwriteEvidenceBytesForTest(
        h.ctx,
        target,
        new TextEncoder().encode("tampered during preflight"),
      );
      return read(id);
    };
    const result = await dispatchOperation(h.ctx, operation.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toMatch(/^ATTACHMENT_/);
    expect(writes.evidence).toBe(0);
  });

  it("an approved operation whose review state moved on is not dispatched", async () => {
    h = createTestHarness();
    const writes = countWrites(h.ctx);
    escalate(h.ctx, h.caseId);
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
    });
    const a = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      draftId: draft.id,
      decision: "approved",
    });
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      approvalId: a.id,
    });
    const rec = cases.get(h.ctx.db, h.caseId)!;
    cases.update(h.ctx.db, { ...rec, buyerState: "READY_FOR_REVIEW" });
    const result = await dispatchOperation(h.ctx, operation.id);
    expect(result.errorCode).toBe("REVIEW_STATE_CHANGED");
    expect(writes.creates).toBe(0);
    expect(claims.get(h.ctx.db, rec.chargeId)).toBeNull();
  });
});

describe("provider success is never rewritten by local bookkeeping", () => {
  it("a success that arrives while the local state moved is saved, claimed and flagged, not thrown", async () => {
    h = createTestHarness();
    escalate(h.ctx, h.caseId);
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
    });
    const a = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      draftId: draft.id,
      decision: "approved",
    });
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      approvalId: a.id,
    });
    const create = h.ctx.adapter.createBuyerDispute.bind(h.ctx.adapter);
    h.ctx.adapter.createBuyerDispute = async (payload, writeCtx) => {
      const out = await create(payload, writeCtx);
      // Something moved the local workflow while the provider call was in flight.
      const rec = cases.get(h.ctx.db, h.caseId)!;
      cases.update(h.ctx.db, { ...rec, buyerState: "READY_FOR_REVIEW" });
      return out;
    };
    const result = await dispatchOperation(h.ctx, operation.id);
    expect(result.status).toBe("SUCCEEDED");
    expect((result.result as { localStateIssue?: string }).localStateIssue).toMatch(
      /READY_FOR_REVIEW/,
    );
    const charge = requireBundle(h.ctx, h.caseId).charge.id;
    expect(claims.get(h.ctx.db, charge)?.state).toBe("OPEN");
    expect(
      audit
        .listForCase(h.ctx.db, h.caseId, 500)
        .some((e) => e.action === "workflow.local_state_mismatch"),
    ).toBe(true);
  });
});

describe("server-derived readiness", () => {
  it("the merchant learns early that there is no provider case; dispatch stays authoritative", async () => {
    h = createTestHarness();
    expect(
      await asyncCode(() =>
        generateDraft(h.ctx, {
          caseId: h.caseId,
          role: "merchant",
          action: "merchant_provide_evidence",
        }),
      ),
    ).toBe("NO_PROVIDER_CASE");
    const view = buildCaseView(h.ctx, h.caseId, "merchant");
    expect(view.readiness.merchant_provide_evidence?.generate?.code).toBe("NO_PROVIDER_CASE");
    expect(view.readiness.merchant_provide_evidence?.approve?.code).toBe("NO_PROVIDER_CASE");
  });
});
