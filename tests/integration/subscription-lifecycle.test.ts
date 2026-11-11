import { afterEach, describe, expect, it } from "vitest";
import { createSandboxHarness, type SandboxHarness } from "../helpers/sandbox-provider";
import {
  addCaseEvidence,
  decideApproval,
  generateDraft,
  recordCancellation,
  requireBundle,
} from "@/server/services/case-service";
import { approvals, audit, cases, charges, evidence, subscriptions } from "@/server/db/repos";
import {
  defaultPreview,
  importDispute,
  resumeSubscriptionSetup,
  runSubscriptionSetup,
  startNewSetupIntent,
  writeManifest,
} from "@/server/services/setup-service";
import { deleteCase } from "@/server/services/deletion";
import { buildRoleSnapshot } from "@/server/services/snapshot";
import type { SubscriptionTransactionReadback } from "@/paypal/adapter";

let h: SandboxHarness;
afterEach(() => h?.cleanup());

const PARTIES = { buyerAlias: "Test Buyer", merchantAlias: "Test Merchant" };
const FIRST: SubscriptionTransactionReadback = {
  id: "SALE-SYN-1001",
  status: "COMPLETED",
  time: "2026-11-01T10:00:00Z",
  amountValue: "19.99",
  amountCurrency: "USD",
};
const SECOND = { ...FIRST, id: "SALE-SYN-1002", time: "2026-11-02T10:00:00Z" };
const THIRD = { ...FIRST, id: "SALE-SYN-1003", time: "2026-11-03T10:00:00Z" };

async function firstCase() {
  h = createSandboxHarness();
  await runSubscriptionSetup(h.ctx);
  h.provider.subscriptionStatus = "ACTIVE";
  h.provider.transactions = [FIRST];
  return (await resumeSubscriptionSetup(h.ctx, PARTIES)).caseId!;
}

function document(caseId: string, visibility: "shared" | "private" = "shared") {
  return addCaseEvidence(h.ctx, "buyer", {
    caseId,
    visibility,
    provenance: "user_attestation",
    kind: "cancellation_confirmation",
    label: "Synthetic cancellation confirmation",
    filename: "confirmation.txt",
    declaredMime: "text/plain",
    bytes: new TextEncoder().encode("Synthetic cancellation effective 2026-11-01 12:00 UTC."),
    capturedAt: "2026-11-01T12:00:00Z",
    eventTime: "2026-11-01T12:00:00Z",
    facts: [],
  });
}

function confirmation(caseId: string, documentId: string) {
  recordCancellation(h.ctx, {
    caseId,
    role: "buyer",
    event: {
      type: "RECORD_CONFIRMATION",
      receivedAt: "2026-11-01T12:00:00Z",
      effectiveAt: "2026-11-01T12:00:00Z",
      basis: "merchant_confirmation_document",
      evidenceIds: [documentId],
    },
  });
}

async function laterCase(first: string) {
  const doc = document(first);
  confirmation(first, doc.id);
  h.provider.transactions = [FIRST, SECOND];
  return (await resumeSubscriptionSetup(h.ctx, PARTIES)).laterPaymentCaseIds[0]!;
}

async function importPayment(sale: SubscriptionTransactionReadback, disputeId: string) {
  h.provider.disputes[disputeId] = {
    status: "WAITING_FOR_SELLER_RESPONSE",
    transaction: {
      sellerTransactionId: sale.id,
      buyerTransactionId: null,
      createTime: sale.time,
      status: sale.status,
      grossValue: sale.amountValue,
      grossCurrency: sale.amountCurrency,
    },
  };
  return importDispute(h.ctx, disputeId, PARTIES);
}

describe("AUD11/CC06/CC13/CC20/CC24 — subscription payment lifecycle", () => {
  it("AUD11/CC13: a later sale refund updates its case and revokes its approved export", async () => {
    const first = await firstCase();
    const later = await laterCase(first);
    const draft = await generateDraft(h.ctx, {
      caseId: later,
      role: "buyer",
      action: "export_refund_request",
    });
    const approval = decideApproval(h.ctx, {
      caseId: later,
      role: "buyer",
      action: "export_refund_request",
      draftId: draft.id,
      decision: "approved",
    });
    const version = requireBundle(h.ctx, later).caseRecord.evidenceSnapshotVersion;
    h.provider.transactions = [FIRST, { ...SECOND, status: "REFUNDED" }];
    await resumeSubscriptionSetup(h.ctx, PARTIES);
    const updated = requireBundle(h.ctx, later);
    expect(updated.charge.status).toBe("REFUNDED");
    expect(updated.charge.refundedCents).toBe(1999);
    expect(updated.caseRecord.claimableCents).toBe(0);
    expect(updated.caseRecord.evidenceSnapshotVersion).toBeGreaterThan(version);
    expect(approvals.get(h.ctx.db, approval.id)!.revokedReason).toBeTruthy();
    expect(requireBundle(h.ctx, first).charge.status).toBe("COMPLETED");
  });

  it("CC06: the first read imports every distinct payment, including one without a timestamp", async () => {
    h = createSandboxHarness();
    await runSubscriptionSetup(h.ctx);
    h.provider.subscriptionStatus = "ACTIVE";
    const undated = { ...THIRD, time: null };
    h.provider.transactions = [SECOND, FIRST, undated, { ...SECOND }];
    const result = await resumeSubscriptionSetup(h.ctx, PARTIES);
    expect(result.laterPaymentCaseIds).toHaveLength(2);
    expect(cases.list(h.ctx.db)).toHaveLength(3);
    const payments = cases.list(h.ctx.db).map((c) => requireBundle(h.ctx, c.id));
    expect(payments.map((b) => b.charge.providerRefs[0]!.value).sort()).toEqual(
      [FIRST.id, SECOND.id, THIRD.id].sort(),
    );
    const unknownTime = payments.find((b) => b.charge.providerRefs[0]!.value === THIRD.id)!;
    expect(unknownTime.charge.eventTime).toBeNull();
    const doc = document(result.caseId!);
    confirmation(result.caseId!, doc.id);
    expect(requireBundle(h.ctx, unknownTime.caseRecord.id).caseRecord.classification).toBe(
      "NEEDS_REVIEW",
    );
    expect((await resumeSubscriptionSetup(h.ctx, PARTIES)).laterPaymentCaseIds).toEqual([]);
  });

  it("AUD11: an undated first transaction remains one payment when its timestamp arrives", async () => {
    h = createSandboxHarness();
    await runSubscriptionSetup(h.ctx);
    h.provider.subscriptionStatus = "ACTIVE";
    h.provider.transactions = [{ ...FIRST, time: null }];
    const initial = await resumeSubscriptionSetup(h.ctx, PARTIES);
    expect(requireBundle(h.ctx, initial.caseId!).charge.providerRefs[0]?.value).toBe(FIRST.id);
    h.provider.transactions = [FIRST];
    await resumeSubscriptionSetup(h.ctx, PARTIES);
    expect(cases.list(h.ctx.db)).toHaveLength(1);
    expect(requireBundle(h.ctx, initial.caseId!).charge.eventTime).toBe(FIRST.time);
  });

  it("AUD11/CC06: a placeholder without a payment time adopts an undated transaction once", async () => {
    h = createSandboxHarness();
    await runSubscriptionSetup(h.ctx);
    h.provider.subscriptionStatus = "ACTIVE";
    const initial = await resumeSubscriptionSetup(h.ctx, PARTIES);
    h.provider.transactions = [{ ...FIRST, time: null }];
    const resumed = await resumeSubscriptionSetup(h.ctx, PARTIES);
    expect(resumed.laterPaymentCaseIds).toEqual([]);
    expect(cases.list(h.ctx.db)).toHaveLength(1);
    expect(requireBundle(h.ctx, initial.caseId!).charge.providerRefs[0]?.value).toBe(FIRST.id);
    expect(requireBundle(h.ctx, initial.caseId!).charge.eventTime).toBeNull();
  });

  it("AUD11/CC06/CC13: a known-time placeholder never adopts a sale already held by its undated sibling", async () => {
    h = createSandboxHarness();
    await runSubscriptionSetup(h.ctx);
    h.provider.subscriptionStatus = "ACTIVE";
    h.provider.lastPayment = {
      time: SECOND.time,
      amountValue: SECOND.amountValue,
      amountCurrency: SECOND.amountCurrency,
    };
    const initial = await resumeSubscriptionSetup(h.ctx, PARTIES);
    const doc = document(initial.caseId!);
    confirmation(initial.caseId!, doc.id);
    h.provider.transactions = [{ ...SECOND, time: null }];
    const undated = await resumeSubscriptionSetup(h.ctx, PARTIES);
    const saleCaseId = undated.laterPaymentCaseIds[0]!;
    h.provider.transactions = [SECOND];
    await expect(resumeSubscriptionSetup(h.ctx, PARTIES)).resolves.toMatchObject({
      laterPaymentCaseIds: [],
    });
    expect(requireBundle(h.ctx, initial.caseId!).charge.providerRefs).toEqual([]);
    expect(requireBundle(h.ctx, saleCaseId).charge.eventTime).toBe(SECOND.time);
    expect(
      charges.list(h.ctx.db).filter((c) => c.providerRefs.some((r) => r.value === SECOND.id)),
    ).toHaveLength(1);
    expect(audit.listForCase(h.ctx.db, initial.caseId!).map((entry) => entry.reasonCode)).toContain(
      "PAYMENT_ALREADY_RECORDED",
    );
    const draft = await generateDraft(h.ctx, {
      caseId: saleCaseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const approval = decideApproval(h.ctx, {
      caseId: saleCaseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: draft.id,
      decision: "approved",
    });
    await expect(resumeSubscriptionSetup(h.ctx, PARTIES)).resolves.toMatchObject({
      laterPaymentCaseIds: [],
    });
    expect(cases.list(h.ctx.db)).toHaveLength(2);
    expect(approvals.get(h.ctx.db, approval.id)!.revokedReason).toBeNull();
  });

  it("CC06/CC07: a payment imported before initial subscription resume cannot become a second charge", async () => {
    h = createSandboxHarness();
    const imported = await importPayment(FIRST, "PP-D-SYN-LIFECYCLE-1");
    await runSubscriptionSetup(h.ctx);
    h.provider.subscriptionStatus = "ACTIVE";
    h.provider.transactions = [FIRST];
    await expect(resumeSubscriptionSetup(h.ctx, PARTIES)).rejects.toMatchObject({
      code: "PAYMENT_ALREADY_RECORDED",
    });
    expect(subscriptions.list(h.ctx.db)).toHaveLength(1);
    expect(charges.list(h.ctx.db)).toHaveLength(1);
    expect(cases.list(h.ctx.db)).toHaveLength(1);
    expect(requireBundle(h.ctx, imported.caseId).charge.providerRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "seller_transaction_id", value: FIRST.id }),
      ]),
    );
  });

  it("CC06/CC07: a later payment imported first remains on its existing case", async () => {
    const first = await firstCase();
    const imported = await importPayment(SECOND, "PP-D-SYN-LIFECYCLE-2");
    const importedBefore = requireBundle(h.ctx, imported.caseId);
    h.provider.transactions = [FIRST, SECOND];
    await expect(resumeSubscriptionSetup(h.ctx, PARTIES)).rejects.toMatchObject({
      code: "PAYMENT_ALREADY_RECORDED",
    });
    expect(subscriptions.list(h.ctx.db)).toHaveLength(2);
    expect(charges.list(h.ctx.db)).toHaveLength(2);
    expect(cases.list(h.ctx.db)).toHaveLength(2);
    expect(requireBundle(h.ctx, imported.caseId)).toEqual(importedBefore);
    expect(requireBundle(h.ctx, first).charge.providerRefs[0]!.value).toBe(FIRST.id);
  });

  it("CC24: deleting the manifest's first case leaves later cycles discoverable", async () => {
    const first = await firstCase();
    const later = await laterCase(first);
    await deleteCase(h.ctx, first, "buyer", async () => {});
    h.provider.transactions = [SECOND, THIRD];
    const resumed = await resumeSubscriptionSetup(h.ctx, PARTIES);
    expect(resumed.caseId).toBe(later);
    expect(resumed.laterPaymentCaseIds).toHaveLength(1);
    expect(
      requireBundle(h.ctx, resumed.laterPaymentCaseIds[0]!).charge.providerRefs[0]!.value,
    ).toBe(THIRD.id);
  });

  it("AUD11/CC06: provider cancellation does not hide observed payments on the first resume", async () => {
    h = createSandboxHarness();
    await runSubscriptionSetup(h.ctx);
    h.provider.subscriptionStatus = "CANCELLED";
    h.provider.transactions = [FIRST, { ...SECOND, time: null }];
    const resumed = await resumeSubscriptionSetup(h.ctx, PARTIES);
    expect(resumed.caseId).toBeTruthy();
    expect(resumed.laterPaymentCaseIds).toHaveLength(1);
    expect(cases.list(h.ctx.db)).toHaveLength(2);
    const bundle = requireBundle(h.ctx, resumed.caseId!);
    expect(bundle.subscription.providerStatus).toBe("CANCELLED");
    expect(bundle.subscription.cancellation.state).toBe("TRACKING");
    expect(bundle.subscription.cancellation.effectiveAt).toBeNull();
    expect(bundle.charge.providerRefs[0]!.value).toBe(FIRST.id);
    const undated = requireBundle(h.ctx, resumed.laterPaymentCaseIds[0]!);
    expect(undated.charge.providerRefs[0]!.value).toBe(SECOND.id);
    expect(undated.charge.eventTime).toBeNull();
    expect((await resumeSubscriptionSetup(h.ctx, PARTIES)).laterPaymentCaseIds).toEqual([]);
  });

  it("AUD11: provider cancellation without observed transactions creates no payment placeholder", async () => {
    h = createSandboxHarness();
    await runSubscriptionSetup(h.ctx);
    h.provider.subscriptionStatus = "CANCELLED";
    const resumed = await resumeSubscriptionSetup(h.ctx, PARTIES);
    expect(resumed.caseId).toBeNull();
    expect(resumed.laterPaymentCaseIds).toEqual([]);
    expect(cases.list(h.ctx.db)).toHaveLength(0);
  });

  it("AUD11: a manifest pointer to another setup cannot redirect the current subscription's payments", async () => {
    const first = await firstCase();
    const firstSubscription = requireBundle(h.ctx, first).subscription.id;
    startNewSetupIntent(h.ctx, defaultPreview(h.ctx.config.appOrigin, undefined, "DAY"));
    await runSubscriptionSetup(h.ctx);
    h.provider.transactions = [SECOND];
    const current = await resumeSubscriptionSetup(h.ctx, PARTIES);
    const second = current.caseId!;
    expect(second).not.toBe(first);
    writeManifest(h.ctx, { ...current.manifest, importedCaseId: first });
    h.provider.transactions = [SECOND, THIRD];
    const resumed = await resumeSubscriptionSetup(h.ctx, PARTIES);
    expect(resumed.caseId).toBe(second);
    expect(resumed.laterPaymentCaseIds).toHaveLength(1);
    const payment = requireBundle(h.ctx, resumed.laterPaymentCaseIds[0]!);
    expect(payment.subscription.id).toBe(requireBundle(h.ctx, second).subscription.id);
    expect(payment.subscription.id).not.toBe(firstSubscription);
    expect(requireBundle(h.ctx, first).charge.providerRefs[0]!.value).toBe(FIRST.id);
  });

  it("CC13/CC20: an ignored request cannot promote an unrelated document into sibling cases", async () => {
    const first = await firstCase();
    recordCancellation(h.ctx, {
      caseId: first,
      role: "buyer",
      event: { type: "RECORD_CANCELLATION_REQUEST", requestedAt: "2026-11-01T11:00:00Z" },
    });
    const later = await laterCase(first);
    const extra = document(first);
    const before = requireBundle(h.ctx, later).caseRecord.evidenceSnapshotVersion;
    recordCancellation(h.ctx, {
      caseId: first,
      role: "buyer",
      event: {
        type: "RECORD_CANCELLATION_REQUEST",
        requestedAt: "2026-11-01T11:00:00Z",
        evidenceIds: [extra.id],
      },
    });
    expect(evidence.get(h.ctx.db, extra.id)!.caseId).toBe(first);
    expect(requireBundle(h.ctx, later).allEvidence.map((e) => e.id)).not.toContain(extra.id);
    expect(requireBundle(h.ctx, later).caseRecord.evidenceSnapshotVersion).toBe(before);
  });

  it("CC13: promoting retained cancellation evidence invalidates siblings even when facts are unchanged", async () => {
    const first = await firstCase();
    const later = await laterCase(first);
    const doc = requireBundle(h.ctx, first).subscription.cancellation.evidenceIds[0]!;
    // A document retained by an earlier version can still be scoped to the original case.
    h.ctx.db.prepare("UPDATE evidence SET case_id = ? WHERE id = ?").run(first, doc);
    const before = requireBundle(h.ctx, later).caseRecord.evidenceSnapshotVersion;
    confirmation(first, doc);
    expect(requireBundle(h.ctx, later).allEvidence.map((e) => e.id)).toContain(doc);
    expect(requireBundle(h.ctx, later).caseRecord.evidenceSnapshotVersion).toBeGreaterThan(before);
  });

  it("CC20/CC24: subscription evidence stays role scoped and survives until the last case", async () => {
    const first = await firstCase();
    const privateDoc = document(first, "private");
    confirmation(first, privateDoc.id);
    h.provider.transactions = [FIRST, SECOND];
    const later = (await resumeSubscriptionSetup(h.ctx, PARTIES)).laterPaymentCaseIds[0]!;
    const snapshot = buildRoleSnapshot(h.ctx, requireBundle(h.ctx, later), "merchant");
    expect(snapshot.sources.map((s) => s.id)).not.toContain(privateDoc.id);
    await deleteCase(h.ctx, first, "buyer", async () => {});
    expect(evidence.get(h.ctx.db, privateDoc.id)).not.toBeNull();
    await deleteCase(h.ctx, later, "buyer", async () => {});
    expect(evidence.get(h.ctx.db, privateDoc.id)).toBeNull();
  });
});
