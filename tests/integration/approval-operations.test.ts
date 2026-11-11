import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/context";
import {
  addCaseEvidence,
  decideApproval,
  editDraft,
  generateDraft,
  recordCancellation,
  requireBundle,
  transferChannel,
} from "@/server/services/case-service";
import { buildRoleSnapshot } from "@/server/services/snapshot";
import {
  dispatchOperation,
  prepareOperation,
  readBackForRecovery,
  resolveUnknownOperation,
  sweepExpiredLeases,
} from "@/server/services/operation-service";
import { approvals, audit, operations } from "@/server/db/repos";
import { deleteCase } from "@/server/services/deletion";
import {
  EvidenceError,
  overwriteEvidenceBytesForTest,
  validateEvidenceBytes,
} from "@/server/services/evidence-store";
import { AppError } from "@/server/services/errors";
import { evidence as evidenceRepo } from "@/server/db/repos";
import { buildActionPayload, pickEvidenceType, refundVerified } from "@/server/services/payloads";
import { actionReadiness } from "@/server/services/readiness";

let h: TestHarness;
beforeEach(() => {
  h = createTestHarness();
});
afterEach(() => h.cleanup());

const PNG_HEADER = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
]);

describe("fixture seed and role scoping (CC01, CC20)", () => {
  it("seeds one candidate case with synthetic provenance and scoped snapshots", () => {
    const bundle = requireBundle(h.ctx, h.caseId);
    expect(bundle.caseRecord.classification).toBe("CANDIDATE_AFTER_CANCEL");
    expect(bundle.caseRecord.claimableCents).toBe(1999);
    expect(bundle.allEvidence.every((e) => e.provenance === "synthetic")).toBe(true);
    const buyer = buildRoleSnapshot(h.ctx, bundle, "buyer");
    const merchant = buildRoleSnapshot(h.ctx, bundle, "merchant");
    const buyerPrivate = bundle.allEvidence.find(
      (e) => e.ownerRole === "buyer" && e.visibility === "private",
    )!;
    const merchantPrivate = bundle.allEvidence.find(
      (e) => e.ownerRole === "merchant" && e.visibility === "private",
    )!;
    expect(buyer.sources.map((s) => s.id)).toContain(buyerPrivate.id);
    expect(merchant.sources.map((s) => s.id)).not.toContain(buyerPrivate.id);
    expect(merchant.sources.map((s) => s.id)).toContain(merchantPrivate.id);
    expect(buyer.sources.map((s) => s.id)).not.toContain(merchantPrivate.id);
    expect(merchant.facts.some((f) => f.id === "fact_buyer_private_chat_attempt")).toBe(false);
    expect(buyer.facts.some((f) => f.id === "fact_buyer_private_chat_attempt")).toBe(true);
    // Shared cancellation evidence works for both roles.
    expect(merchant.facts.some((f) => f.kind === "cancellation_effective")).toBe(true);
    // Ops/audit: no operation was created by seeding.
    expect(operations.listForCase(h.ctx.db, h.caseId)).toHaveLength(0);
  });
});

describe("approval binding and submission (CC12, CC13, CC14)", () => {
  it("export requires a valid, unexpired, matching approval and is executed once", async () => {
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    expect(draft.validation.ok).toBe(true);
    expect(draft.origin).toBe("fixture_template");

    // CC12: no approval at all
    expect(() =>
      prepareOperation(h.ctx, {
        caseId: h.caseId,
        role: "buyer",
        action: "export_refund_request",
        approvalId: "fx_appr_missing",
      }),
    ).toThrow(AppError);

    const approval = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: draft.id,
      decision: "approved",
    });
    expect(approval.decision).toBe("approved");

    // CC12: another role/action cannot use it
    expect(() =>
      prepareOperation(h.ctx, {
        caseId: h.caseId,
        role: "merchant",
        action: "merchant_provide_evidence",
        approvalId: approval.id,
      }),
    ).toThrow(AppError);
    expect(() =>
      prepareOperation(h.ctx, {
        caseId: h.caseId,
        role: "buyer",
        action: "buyer_create_dispute",
        approvalId: approval.id,
      }),
    ).toThrow(AppError);

    const first = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      approvalId: approval.id,
    });
    expect(first.created).toBe(true);
    const second = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      approvalId: approval.id,
    });
    expect(second.created).toBe(false);
    expect(second.operation.id).toBe(first.operation.id);

    const [a, b] = await Promise.all([
      dispatchOperation(h.ctx, first.operation.id),
      dispatchOperation(h.ctx, first.operation.id),
    ]);
    expect(a.status).toBe("SUCCEEDED");
    expect(b.status).toBe("SUCCEEDED");
    expect(a.attempts).toBe(1);
    expect(operations.listForCase(h.ctx.db, h.caseId)).toHaveLength(1);
    const bundle = requireBundle(h.ctx, h.caseId);
    expect(bundle.caseRecord.buyerState).toBe("SYNCED");
    expect(bundle.caseRecord.claimActive).toBe(false); // an export is not a claim
    const entries = audit.listForCase(h.ctx.db, h.caseId);
    expect(entries.some((e) => e.action === "operation.denied")).toBe(true);
  });

  it("an expired approval is denied", async () => {
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const approval = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: draft.id,
      decision: "approved",
    });
    h.clock.advanceMinutes(16);
    expect(() =>
      prepareOperation(h.ctx, {
        caseId: h.caseId,
        role: "buyer",
        action: "export_refund_request",
        approvalId: approval.id,
      }),
    ).toThrow(/EXPIRED/);
  });

  it("a rejected approval cannot be used and the thread is REJECTED", async () => {
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const rejected = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: draft.id,
      decision: "rejected",
      reason: "wording",
    });
    expect(() =>
      prepareOperation(h.ctx, {
        caseId: h.caseId,
        role: "buyer",
        action: "export_refund_request",
        approvalId: rejected.id,
      }),
    ).toThrow(AppError);
    expect(requireBundle(h.ctx, h.caseId).caseRecord.buyerState).toBe("REJECTED");
  });

  it("editing the draft, adding evidence, or changing material facts invalidates the approval (CC13)", async () => {
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const approval = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: draft.id,
      decision: "approved",
    });
    const edited = editDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      claims: [
        { id: draft.content.claims[0]!.id, text: draft.content.claims[0]!.text + " (edited)" },
      ],
    });
    expect(edited.version).toBe(draft.version + 1);
    expect(edited.origin).toBe("human_edit");
    expect(() =>
      prepareOperation(h.ctx, {
        caseId: h.caseId,
        role: "buyer",
        action: "export_refund_request",
        approvalId: approval.id,
      }),
    ).toThrow(AppError);
    expect(approvals.get(h.ctx.db, approval.id)!.revokedReason).toBe("draft_changed");

    const approval2 = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: edited.id,
      decision: "approved",
    });
    addCaseEvidence(h.ctx, "buyer", {
      caseId: h.caseId,
      visibility: "private",
      provenance: "user_attestation",
      kind: "note",
      label: "Extra note",
      filename: "note.txt",
      declaredMime: "text/plain",
      bytes: new TextEncoder().encode("A later note."),
      capturedAt: "2026-11-09T09:30:00Z",
      eventTime: null,
      facts: [],
    });
    expect(approvals.get(h.ctx.db, approval2.id)!.revokedReason).toBe("evidence_added");
    expect(() =>
      prepareOperation(h.ctx, {
        caseId: h.caseId,
        role: "buyer",
        action: "export_refund_request",
        approvalId: approval2.id,
      }),
    ).toThrow(AppError);
  });

  it("changed attachment bytes are detected at dispatch (CC13, CC21)", async () => {
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const approval = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: draft.id,
      decision: "approved",
    });
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      approvalId: approval.id,
    });
    const attachmentId = draft.content.attachmentEvidenceIds[0]!;
    overwriteEvidenceBytesForTest(
      h.ctx,
      evidenceRepo.get(h.ctx.db, attachmentId)!,
      new TextEncoder().encode("tampered"),
    );
    const result = await dispatchOperation(h.ctx, operation.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toMatch(/ATTACHMENT_HASH_MISMATCH|ATTACHMENT_CHANGED/);
  });
});

describe("provider write path, recovery and deletion (CC07, CC15, CC16, CC17, CC24)", () => {
  async function approveBuyerDispute() {
    transferChannel(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      channel: "paypal",
      reason: "merchant did not respond within 7 days (fixture scenario)",
    });
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
    });
    expect(draft.validation.ok).toBe(true);
    return decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      draftId: draft.id,
      decision: "approved",
    });
  }

  it("a successful simulated buyer case activates the claim and reads back a synthetic observation", async () => {
    const approval = await approveBuyerDispute();
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      approvalId: approval.id,
    });
    const done = await dispatchOperation(h.ctx, operation.id);
    expect(done.status).toBe("SUCCEEDED");
    const bundle = requireBundle(h.ctx, h.caseId);
    expect(bundle.caseRecord.claimActive).toBe(true);
    expect(bundle.caseRecord.providerObservation?.provenance).toBe("synthetic");
    expect(bundle.caseRecord.providerObservation?.disputeId).toMatch(/^FX-DISPUTE-/);
    expect(bundle.caseRecord.providerObservation?.status).toBe("WAITING_FOR_SELLER_RESPONSE");
    // CC07: while the provider case is open, a local transfer (to another channel or the same
    // one) is refused and never clears the open claim.
    for (const channel of ["chargeback", "paypal"] as const) {
      expect(() =>
        transferChannel(h.ctx, {
          caseId: h.caseId,
          role: "buyer",
          channel,
          reason: "try another route",
        }),
      ).toThrow(/provider case is open/i);
    }
    expect(requireBundle(h.ctx, h.caseId).caseRecord.claimActive).toBe(true);
    expect(requireBundle(h.ctx, h.caseId).caseRecord.channel).toBe("paypal");
  });

  it("an ambiguous timeout becomes UNKNOWN, is never resent, and needs a human recovery decision (CC16)", async () => {
    const approval = await approveBuyerDispute();
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      approvalId: approval.id,
      simulate: "timeout",
    });
    const unknown = await dispatchOperation(h.ctx, operation.id);
    expect(unknown.status).toBe("UNKNOWN");
    expect(unknown.errorCode).toBe("NETWORK_TIMEOUT");
    expect(requireBundle(h.ctx, h.caseId).caseRecord.buyerState).toBe("UNKNOWN");
    // A second dispatch call does not resend.
    const again = await dispatchOperation(h.ctx, operation.id);
    expect(again.status).toBe("UNKNOWN");
    expect(again.attempts).toBe(1);
    // Deletion is blocked while unknown (CC24).
    await expect(deleteCase(h.ctx, h.caseId, "buyer", async () => {})).rejects.toThrow(
      /unresolved/,
    );
    // Read-back finds the simulated case but cannot auto-confirm.
    const readback = await readBackForRecovery(h.ctx, operation.id);
    expect(readback.canAutoConfirm).toBe(false);
    expect(readback.candidateDisputeId).toMatch(/^FX-DISPUTE-/);
    await expect(
      resolveUnknownOperation(h.ctx, {
        operationId: operation.id,
        decision: "confirmed_succeeded",
        note: "",
      }),
    ).rejects.toThrow(/why/);
    const resolved = await resolveUnknownOperation(h.ctx, {
      operationId: operation.id,
      decision: "confirmed_succeeded",
      note: "Read-back shows the case; confirmed in the provider view.",
      disputeId: readback.candidateDisputeId,
    });
    expect(resolved.status).toBe("SUCCEEDED");
    expect(resolved.recoveryDecision).toBe("confirmed_succeeded");
    expect(requireBundle(h.ctx, h.caseId).caseRecord.buyerState).toBe("SYNCED");
    expect(requireBundle(h.ctx, h.caseId).caseRecord.providerObservation?.disputeId).toBe(
      readback.candidateDisputeId,
    );
  });

  it("a crash while DISPATCHING becomes UNKNOWN after the lease expires, without a resend (CC16)", async () => {
    const approval = await approveBuyerDispute();
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      approvalId: approval.id,
    });
    // Simulate a crash: reserve the dispatch and stop.
    const now = h.clock.now().toISOString();
    expect(
      operations.acquireDispatch(
        h.ctx.db,
        operation.id,
        new Date(h.clock.now().getTime() + 120_000).toISOString(),
        now,
      ),
    ).toBe(true);
    expect(sweepExpiredLeases(h.ctx)).toHaveLength(0);
    h.clock.advanceMinutes(3);
    const swept = sweepExpiredLeases(h.ctx);
    expect(swept).toHaveLength(1);
    expect(swept[0]!.status).toBe("UNKNOWN");
    expect(swept[0]!.errorCode).toBe("LEASE_EXPIRED");
    const after = await dispatchOperation(h.ctx, operation.id);
    expect(after.status).toBe("UNKNOWN");
  });

  it("merchant evidence requires current capability; unsupported state blocks before any write (CC17)", async () => {
    const approval = await approveBuyerDispute();
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      approvalId: approval.id,
    });
    await dispatchOperation(h.ctx, operation.id);
    h.clock.advanceMinutes(1); // observations are ordered by time; a later read must be newer

    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
    });
    expect(draft.validation.ok).toBe(true);
    expect(draft.content.claims.every((c) => !/private note/i.test(c.text))).toBe(true);
    const blockedApproval = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
      draftId: draft.id,
      decision: "approved",
    });
    const blocked = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
      approvalId: blockedApproval.id,
      simulate: "unsupported",
    });
    const blockedResult = await dispatchOperation(h.ctx, blocked.operation.id);
    expect(blockedResult.status).toBe("FAILED");
    expect(blockedResult.errorCode).toBe("CAPABILITY_BLOCKED");
    expect(requireBundle(h.ctx, h.caseId).caseRecord.merchantState).toBe("BLOCKED");

    // Reopen, regenerate, approve again and submit for real (simulated).
    const draft2 = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
    });
    const approval2 = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
      draftId: draft2.id,
      decision: "approved",
    });
    const ok = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
      approvalId: approval2.id,
    });
    h.clock.advanceMinutes(1);
    const okResult = await dispatchOperation(h.ctx, ok.operation.id);
    expect(okResult.status).toBe("SUCCEEDED");
    const bundle = requireBundle(h.ctx, h.caseId);
    expect(bundle.caseRecord.merchantState).toBe("SYNCED");
    expect(bundle.caseRecord.providerObservation?.status).toBe("UNDER_REVIEW");
    // Submitting evidence never implies resolution.
    expect(bundle.caseRecord.providerObservation?.status).not.toBe("RESOLVED");
  });

  it("labels evidence honestly: no proof of refund without a verified refund (CC17)", () => {
    // Shape observed on a Sandbox chargeback for a refund-not-processed reason.
    expect(pickEvidenceType(["PROOF_OF_REFUND", "OTHER"], false)).toBe("OTHER");
    expect(pickEvidenceType(["PROOF_OF_FULFILLMENT"], false)).toBe("OTHER");
    expect(pickEvidenceType([], false)).toBe("OTHER");
    // A verified refund still does not select PROOF_OF_REFUND: no refund reference is sent.
    expect(pickEvidenceType(["PROOF_OF_REFUND", "OTHER"], true)).toBe("OTHER");
    expect(pickEvidenceType(["PROOF_OF_REFUND"], true, true)).toBe("OTHER");
    expect(pickEvidenceType(["OTHER", "CANCELLATION_DETAILS"], false)).toBe("OTHER");
    expect(pickEvidenceType(["OTHER", "CANCELLATION_DETAILS"], false, true)).toBe(
      "CANCELLATION_DETAILS",
    );
    expect(refundVerified({ refundStateKnown: false, refundedCents: 1999 })).toBe(false);
    expect(refundVerified({ refundStateKnown: true, refundedCents: 0 })).toBe(false);
    expect(refundVerified({ refundStateKnown: true, refundedCents: 1999 })).toBe(true);
  });

  it.each(["buyer_create_dispute", "merchant_provide_evidence"] as const)(
    "never silently truncates the %s note approved on screen (CC12, CC13)",
    async (action) => {
      if (action === "merchant_provide_evidence") {
        const buyer = await approveBuyerDispute();
        const prepared = prepareOperation(h.ctx, {
          caseId: h.caseId,
          role: "buyer",
          action: "buyer_create_dispute",
          approvalId: buyer.id,
        });
        await dispatchOperation(h.ctx, prepared.operation.id);
      } else
        transferChannel(h.ctx, {
          caseId: h.caseId,
          role: "buyer",
          channel: "paypal",
          reason: "reviewed escalation",
        });
      const role = action === "merchant_provide_evidence" ? "merchant" : "buyer";
      const original = await generateDraft(h.ctx, {
        caseId: h.caseId,
        role,
        action,
      });
      const draft = editDraft(h.ctx, {
        caseId: h.caseId,
        role,
        action,
        claims: [original.content.claims[0]!, original.content.claims.at(-1)!].map((c) => ({
          id: c.id,
          text: "Please consider the cited records. ".repeat(34),
        })),
      });
      expect(draft.validation.ok).toBe(true);
      expect(draft.renderedText.length).toBeGreaterThan(2000);
      expect(
        actionReadiness(h.ctx, requireBundle(h.ctx, h.caseId), role, action).approve?.code,
      ).toBe("PROVIDER_NOTE_TOO_LONG");
      const payload = buildActionPayload(
        h.ctx,
        requireBundle(h.ctx, h.caseId),
        draft,
        role,
        action,
      );
      expect(payload).toMatchObject(
        action === "buyer_create_dispute"
          ? { note: draft.renderedText }
          : { notes: draft.renderedText },
      );
      expect(() =>
        decideApproval(h.ctx, {
          caseId: h.caseId,
          role,
          action,
          draftId: draft.id,
          decision: "approved",
        }),
      ).toThrow(/2,000/);
      expect(
        decideApproval(h.ctx, {
          caseId: h.caseId,
          role,
          action,
          draftId: draft.id,
          decision: "rejected",
          reason: "Shorten the provider response first.",
        }).decision,
      ).toBe("rejected");
    },
  );

  it("merchant evidence offers only files the provider accepts; dispatch re-checks (CC17, CC21)", async () => {
    const approval = await approveBuyerDispute();
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      approvalId: approval.id,
    });
    await dispatchOperation(h.ctx, operation.id);
    h.clock.advanceMinutes(1);

    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
    });
    const mimeOf = (id: string) => evidenceRepo.get(h.ctx.db, id)?.mime;
    const accepted = ["application/pdf", "image/png", "image/jpeg"];
    expect(draft.content.attachmentEvidenceIds.length).toBeGreaterThan(0);
    expect(draft.content.attachmentEvidenceIds.every((id) => accepted.includes(mimeOf(id)!))).toBe(
      true,
    );
    const textFile = requireBundle(h.ctx, h.caseId).allEvidence.find(
      (e) => e.mime === "text/plain" && e.visibility === "shared",
    )!;
    expect(textFile).toBeDefined();
    expect(draft.content.attachmentEvidenceIds).not.toContain(textFile.id);
    expect(() =>
      editDraft(h.ctx, {
        caseId: h.caseId,
        role: "merchant",
        action: "merchant_provide_evidence",
        claims: [],
        attachmentEvidenceIds: [...draft.content.attachmentEvidenceIds, textFile.id],
      }),
    ).toThrow(/PDF, PNG and JPEG/);

    // Defence in depth: a file whose stored type is not accepted never reaches the provider.
    const approved = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
      draftId: draft.id,
      decision: "approved",
    });
    const prepared = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
      approvalId: approved.id,
    });
    expect(prepared.operation.payload).toMatchObject({ evidenceType: "CANCELLATION_DETAILS" });
    const before = requireBundle(h.ctx, h.caseId).caseRecord.providerObservation?.status;
    h.ctx.db
      .prepare("UPDATE evidence SET mime = 'text/plain' WHERE id = ?")
      .run(draft.content.attachmentEvidenceIds[0]);
    const result = await dispatchOperation(h.ctx, prepared.operation.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("ATTACHMENT_TYPE_NOT_ACCEPTED");
    expect(requireBundle(h.ctx, h.caseId).caseRecord.providerObservation?.status).toBe(before);
  });

  it("deletion cascades evidence, drafts, approvals, operations and checkpoints (CC24)", async () => {
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const approval = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: draft.id,
      decision: "approved",
    });
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      approvalId: approval.id,
    });
    await dispatchOperation(h.ctx, operation.id);
    const deletedThreads: string[] = [];
    const result = await deleteCase(h.ctx, h.caseId, "buyer", async (ids) => {
      deletedThreads.push(...ids);
    });
    expect(result.evidenceFiles).toBe(5);
    expect(result.drafts).toBe(1);
    expect(result.operations).toBe(1);
    expect(deletedThreads).toHaveLength(6);
    expect(() => requireBundle(h.ctx, h.caseId)).toThrow(/not found/);
    const marker = h.ctx.db
      .prepare("SELECT action, details_json FROM audit_log WHERE case_id = ?")
      .all(h.caseId) as { action: string; details_json: string | null }[];
    expect(marker).toEqual([{ action: "case.deleted", details_json: null }]);
  });
});

describe("cancellation attestation does not prove provider mandate state (CC02)", () => {
  it("records user attestation separately and re-reconciles", async () => {
    const before = requireBundle(h.ctx, h.caseId);
    expect(before.subscription.cancellation.basis).toBe("merchant_confirmation_document");
    // A provider mandate observation can only come from a provider read, never from manual input.
    expect(() =>
      recordCancellation(h.ctx, {
        caseId: h.caseId,
        role: "buyer",
        event: {
          type: "OBSERVE_PROVIDER_MANDATE",
          status: "ACTIVE",
          observedAt: "2026-11-09T09:05:00Z",
        },
      }),
    ).toThrow(/provider read-back/);
    const { refreshSubscriptionObservation } = await import("@/server/services/setup-service");
    await refreshSubscriptionObservation(h.ctx, h.caseId);
    const after = requireBundle(h.ctx, h.caseId);
    expect(after.subscription.cancellation.state).toBe("CANCEL_CONFIRMED");
    expect(after.subscription.cancellation.providerMandateStatus).toBe("ACTIVE");
    expect(() =>
      recordCancellation(h.ctx, {
        caseId: h.caseId,
        role: "merchant",
        event: { type: "REOPEN_REVIEW", reason: "MISSING_EVIDENCE" },
      }),
    ).toThrow(/buyer/);
  });
});

describe("evidence validation (CC21)", () => {
  it("rejects traversal names, spoofed types, oversize and markup", () => {
    expect(() =>
      validateEvidenceBytes({
        bytes: new TextEncoder().encode("hello"),
        declaredMime: "text/plain",
        filename: "../../etc/passwd",
      }),
    ).toThrow(EvidenceError);
    expect(() =>
      validateEvidenceBytes({
        bytes: new TextEncoder().encode("hello"),
        declaredMime: "application/pdf",
        filename: "a.pdf",
      }),
    ).toThrow(/does not match/);
    expect(() =>
      validateEvidenceBytes({
        bytes: new Uint8Array(5 * 1024 * 1024 + 1),
        declaredMime: null,
        filename: "big.bin",
      }),
    ).toThrow(/limit/);
    expect(() =>
      validateEvidenceBytes({
        bytes: new TextEncoder().encode("<html><script>alert(1)</script></html>"),
        declaredMime: null,
        filename: "page.txt",
      }),
    ).toThrow(/markup/);
    expect(() =>
      validateEvidenceBytes({
        bytes: new TextEncoder().encode("<svg xmlns='x'></svg>"),
        declaredMime: null,
        filename: "img.svg",
      }),
    ).toThrow(EvidenceError);
    expect(() =>
      validateEvidenceBytes({
        bytes: Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]),
        declaredMime: null,
        filename: "tool.exe",
      }),
    ).toThrow(EvidenceError);
    expect(
      validateEvidenceBytes({ bytes: PNG_HEADER, declaredMime: "image/png", filename: "shot.png" })
        .mime,
    ).toBe("image/png");
    expect(
      validateEvidenceBytes({
        bytes: new TextEncoder().encode("%PDF-1.4\n%fixture"),
        declaredMime: null,
        filename: "doc.pdf",
      }).mime,
    ).toBe("application/pdf");
  });
});
