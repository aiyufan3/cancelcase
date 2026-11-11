import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxHarness, type SandboxHarness } from "../helpers/sandbox-provider";
import {
  importDispute,
  loadSetupState,
  manifestPath,
  resumeSubscriptionSetup,
  runSubscriptionSetup,
} from "@/server/services/setup-service";
import {
  addCaseEvidence,
  decideApproval,
  generateDraft,
  recordCancellation,
  requireBundle,
  transferChannel,
} from "@/server/services/case-service";
import {
  claimForCharge,
  registerExistingClaim,
  releaseClaimOnProviderResolution,
} from "@/server/services/claim-service";
import { prepareOperation } from "@/server/services/operation-service";
import { approvals, cases, charges, claims, subscriptions } from "@/server/db/repos";

let h: SandboxHarness | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  h?.cleanup();
  h = null;
});

const PARTIES = { buyerAlias: "Test Buyer", merchantAlias: "Test Merchant" };
const SALE = {
  id: "SALE-SYN-IMPORT-1",
  status: "COMPLETED",
  time: "2026-11-01T10:00:00Z",
  amountValue: "19.99",
  amountCurrency: "USD",
};
const DISPUTE = "PP-D-SYN-IMPORT-1";

function dispute(harness: SandboxHarness, sellerTransactionId = SALE.id) {
  harness.provider.disputes[DISPUTE] = {
    status: "WAITING_FOR_SELLER_RESPONSE",
    transaction: {
      sellerTransactionId,
      buyerTransactionId: "BUYERSYN000000002",
      createTime: SALE.time,
      status: SALE.status,
      grossValue: SALE.amountValue,
      grossCurrency: SALE.amountCurrency,
    },
  };
}

async function connected(harness: SandboxHarness): Promise<string> {
  harness.provider.transactions = [SALE];
  await runSubscriptionSetup(harness.ctx);
  harness.provider.subscriptionStatus = "ACTIVE";
  return (await resumeSubscriptionSetup(harness.ctx, PARTIES)).caseId!;
}

function confirmCancellation(harness: SandboxHarness, caseId: string) {
  const doc = addCaseEvidence(harness.ctx, "buyer", {
    caseId,
    visibility: "shared",
    provenance: "user_attestation",
    kind: "cancellation_confirmation",
    label: "Cancellation confirmation (synthetic)",
    filename: "cancellation.txt",
    declaredMime: "text/plain",
    bytes: new TextEncoder().encode("Cancelled effective 2026-10-20."),
    capturedAt: "2026-10-20T09:30:00Z",
    eventTime: "2026-10-20T09:00:00Z",
    facts: [],
  });
  recordCancellation(harness.ctx, {
    caseId,
    role: "buyer",
    event: {
      type: "RECORD_CONFIRMATION",
      receivedAt: "2026-10-20T09:00:00Z",
      effectiveAt: "2026-10-20T09:00:00Z",
      basis: "merchant_confirmation_document",
      evidenceIds: [doc.id],
    },
  });
}

function counts(harness: SandboxHarness) {
  return {
    subscriptions: subscriptions.list(harness.ctx.db).length,
    charges: charges.list(harness.ctx.db).length,
    cases: cases.list(harness.ctx.db).length,
    audit: harness.ctx.db.prepare("SELECT COUNT(*) AS count FROM audit_log").get(),
  };
}

describe("CC07 / AUD11 — dispute import integrity", () => {
  it.each(["identifier", "provenance"])(
    "rejects a provider read with mismatched %s",
    async (kind) => {
      h = createSandboxHarness();
      dispute(h);
      const read = h.provider.getDispute.bind(h.provider);
      h.provider.getDispute = async (id) => {
        const result = await read(id);
        if (result.ok) {
          if (kind === "identifier") result.data.observation.disputeId = "PP-D-SYN-UNRELATED";
          else result.data.observation.provenance = "synthetic";
        }
        return result;
      };
      const before = counts(h);
      await expect(importDispute(h.ctx, DISPUTE, PARTIES)).rejects.toMatchObject({
        code: "IMPORT_READ_MISMATCH",
      });
      expect(counts(h)).toEqual(before);
    },
  );

  it.each(["different", "missing"])(
    "rejects a %s transaction on an explicitly selected case without partial writes",
    async (kind) => {
      h = createSandboxHarness();
      const caseId = await connected(h);
      dispute(h, "SALE-SYN-UNRELATED");
      if (kind === "missing") h.provider.disputes[DISPUTE]!.transaction = null;
      const before = counts(h);
      await expect(importDispute(h.ctx, DISPUTE, { ...PARTIES, caseId })).rejects.toMatchObject({
        code: kind === "missing" ? "IMPORT_TRANSACTION_MISSING" : "IMPORT_TRANSACTION_MISMATCH",
      });
      expect(counts(h)).toEqual(before);
      expect(requireBundle(h.ctx, caseId).caseRecord.providerObservation).toBeNull();
    },
  );

  it("attaches to an existing matching payment, records the aliases and manual origin, and leaves setup state unchanged", async () => {
    h = createSandboxHarness();
    const caseId = await connected(h);
    dispute(h);
    const before = fs.readFileSync(manifestPath(h.ctx), "utf8");
    const imported = await importDispute(h.ctx, DISPUTE, PARTIES);
    expect(imported.caseId).toBe(caseId);
    expect(cases.list(h.ctx.db)).toHaveLength(1);
    expect(charges.list(h.ctx.db)).toHaveLength(1);
    const bundle = requireBundle(h.ctx, caseId);
    expect(bundle.charge.providerRefs.map((ref) => ref.kind)).toEqual(
      expect.arrayContaining(["dispute_id", "seller_transaction_id", "buyer_transaction_id"]),
    );
    expect(bundle.caseRecord.origin).toBe("sandbox_import");
    expect(bundle.caseRecord.originNote).toContain("manually");
    expect(fs.readFileSync(manifestPath(h.ctx), "utf8")).toBe(before);
  });

  it("re-imports the same dispute idempotently without orphan subscriptions", async () => {
    h = createSandboxHarness();
    dispute(h);
    const first = await importDispute(h.ctx, DISPUTE, PARTIES);
    const before = counts(h);
    const second = await importDispute(h.ctx, DISPUTE, PARTIES);
    expect(second.caseId).toBe(first.caseId);
    expect(subscriptions.list(h.ctx.db)).toHaveLength(before.subscriptions);
    expect(charges.list(h.ctx.db)).toHaveLength(before.charges);
    expect(cases.list(h.ctx.db)).toHaveLength(before.cases);
  });

  it("enriches an unidentified imported payment when its provider transaction becomes available", async () => {
    h = createSandboxHarness();
    h.provider.disputes[DISPUTE] = { status: "WAITING_FOR_SELLER_RESPONSE", transaction: null };
    const { caseId } = await importDispute(h.ctx, DISPUTE, PARTIES);
    expect(requireBundle(h.ctx, caseId).charge.status).toBe("UNKNOWN");
    dispute(h);
    h.clock.advanceMinutes(1);
    await importDispute(h.ctx, DISPUTE, PARTIES);
    const charge = requireBundle(h.ctx, caseId).charge;
    expect(charge.status).toBe("COMPLETED");
    expect(charge.amountCents).toBe(1999);
    expect(charge.eventTime).toBe(SALE.time);
    expect(charge.refundStateKnown).toBe(true);
    expect(charges.list(h.ctx.db)).toHaveLength(1);
  });

  it("updates attached refund facts and invalidates the amount approved before import", async () => {
    h = createSandboxHarness();
    const caseId = await connected(h);
    confirmCancellation(h, caseId);
    const draft = await generateDraft(h.ctx, {
      caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const approval = decideApproval(h.ctx, {
      caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: draft.id,
      decision: "approved",
    });
    dispute(h);
    h.provider.disputes[DISPUTE]!.transaction!.status = "REFUNDED";
    await importDispute(h.ctx, DISPUTE, { ...PARTIES, caseId });
    const bundle = requireBundle(h.ctx, caseId);
    expect(bundle.charge.status).toBe("REFUNDED");
    expect(bundle.charge.refundedCents).toBe(1999);
    expect(bundle.caseRecord.claimableCents).toBe(0);
    expect(approvals.get(h.ctx.db, approval.id)?.revokedReason).toBeTruthy();
  });

  it.each(["older", "newer"])("a %s re-import cannot erase a verified refund", async (order) => {
    h = createSandboxHarness();
    dispute(h);
    h.provider.disputes[DISPUTE]!.transaction!.status = "REFUNDED";
    const { caseId } = await importDispute(h.ctx, DISPUTE, PARTIES);
    h.clock.advanceMinutes(order === "older" ? -1 : 1);
    h.provider.disputes[DISPUTE]!.transaction!.status = "COMPLETED";
    await importDispute(h.ctx, DISPUTE, PARTIES);
    const charge = requireBundle(h.ctx, caseId).charge;
    expect(charge.status).toBe("REFUNDED");
    expect(charge.refundedCents).toBe(1999);
    expect(charge.refundStateKnown).toBe(true);
  });

  it("an older re-import cannot roll back an observed payment amount or time", async () => {
    h = createSandboxHarness();
    dispute(h);
    const { caseId } = await importDispute(h.ctx, DISPUTE, PARTIES);
    h.clock.advanceMinutes(-1);
    const tx = h.provider.disputes[DISPUTE]!.transaction!;
    tx.grossValue = "29.99";
    tx.createTime = "2026-10-30T10:00:00Z";
    await importDispute(h.ctx, DISPUTE, PARTIES);
    const charge = requireBundle(h.ctx, caseId).charge;
    expect(charge.amountCents).toBe(1999);
    expect(charge.eventTime).toBe(SALE.time);
  });

  it("a newer re-import cannot replace an unresolved partial refund with a zero refund", async () => {
    h = createSandboxHarness();
    dispute(h);
    h.provider.disputes[DISPUTE]!.transaction!.status = "PARTIALLY_REFUNDED";
    const { caseId } = await importDispute(h.ctx, DISPUTE, PARTIES);
    h.clock.advanceMinutes(1);
    h.provider.disputes[DISPUTE]!.transaction!.status = "COMPLETED";
    await importDispute(h.ctx, DISPUTE, PARTIES);
    const charge = requireBundle(h.ctx, caseId).charge;
    expect(charge.status).toBe("PARTIALLY_REFUNDED");
    expect(charge.refundedCents).toBeNull();
    expect(charge.refundStateKnown).toBe(false);
  });

  it("a sparse newer import retains known payment facts instead of inventing replacements", async () => {
    h = createSandboxHarness();
    dispute(h);
    const { caseId } = await importDispute(h.ctx, DISPUTE, PARTIES);
    h.clock.advanceMinutes(1);
    const tx = h.provider.disputes[DISPUTE]!.transaction!;
    tx.status = null;
    tx.createTime = null;
    tx.grossValue = null;
    tx.grossCurrency = null;
    await importDispute(h.ctx, DISPUTE, PARTIES);
    const charge = requireBundle(h.ctx, caseId).charge;
    expect(charge.status).toBe("COMPLETED");
    expect(charge.eventTime).toBe(SALE.time);
    expect(charge.amountCents).toBe(1999);
    expect(charge.refundedCents).toBe(0);
  });

  it("does not assign an unrelated import to an unfinished setup manifest", async () => {
    h = createSandboxHarness();
    await runSubscriptionSetup(h.ctx);
    dispute(h);
    await importDispute(h.ctx, DISPUTE, PARTIES);
    expect(loadSetupState(h.ctx)?.importedCaseId).toBeNull();
    expect(loadSetupState(h.ctx)?.importedDisputeId).toBeNull();
  });

  it("invalidates a pending approval when attaching a provider case", async () => {
    h = createSandboxHarness();
    const caseId = await connected(h);
    confirmCancellation(h, caseId);
    const draft = await generateDraft(h.ctx, {
      caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const approval = decideApproval(h.ctx, {
      caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: draft.id,
      decision: "approved",
    });
    dispute(h);
    await importDispute(h.ctx, DISPUTE, { ...PARTIES, caseId });
    expect(requireBundle(h.ctx, caseId).caseRecord.evidenceSnapshotVersion).toBeGreaterThan(
      draft.snapshotVersion,
    );
    expect(approvals.get(h.ctx.db, approval.id)?.revokedReason).toBeTruthy();
  });

  it("imports a provider-resolved case without leaving an active claim", async () => {
    h = createSandboxHarness();
    dispute(h);
    h.provider.disputes[DISPUTE]!.status = "RESOLVED";
    const { caseId } = await importDispute(h.ctx, DISPUTE, PARTIES);
    const bundle = requireBundle(h.ctx, caseId);
    expect(claimForCharge(h.ctx, bundle.charge.id)).toBeNull();
    expect(bundle.caseRecord.claimActive).toBe(false);
  });

  it("does not reopen a resolved claim when a re-import reads an older provider observation", async () => {
    h = createSandboxHarness();
    dispute(h);
    h.provider.disputes[DISPUTE]!.status = "RESOLVED";
    const { caseId } = await importDispute(h.ctx, DISPUTE, PARTIES);
    h.clock.advanceMinutes(-5);
    h.provider.disputes[DISPUTE]!.status = "WAITING_FOR_SELLER_RESPONSE";
    const result = await importDispute(h.ctx, DISPUTE, PARTIES);
    expect(result.status).toBe("RESOLVED");
    const bundle = requireBundle(h.ctx, caseId);
    expect(bundle.caseRecord.providerObservation?.status).toBe("RESOLVED");
    expect(claimForCharge(h.ctx, bundle.charge.id)).toBeNull();
  });

  it("matches an explicitly selected case by its buyer transaction reference", async () => {
    h = createSandboxHarness();
    const caseId = await connected(h);
    const charge = requireBundle(h.ctx, caseId).charge;
    charges.update(h.ctx.db, {
      ...charge,
      providerRefs: [
        ...charge.providerRefs,
        {
          kind: "buyer_transaction_id",
          value: "BUYERSYN000000002",
          provenance: "user_attestation",
        },
      ],
    });
    dispute(h, "SELLER-SYN-BUYER-MATCH");
    const result = await importDispute(h.ctx, DISPUTE, { ...PARTIES, caseId });
    expect(result.caseId).toBe(caseId);
    expect(charges.list(h.ctx.db)).toHaveLength(1);
  });

  it("rejects an explicitly selected case belonging to another local account", async () => {
    h = createSandboxHarness();
    const caseId = await connected(h);
    h.ctx.db
      .prepare("UPDATE dispute_cases SET account_alias = ? WHERE id = ?")
      .run("other-buyer", caseId);
    dispute(h);
    const before = counts(h);
    await expect(importDispute(h.ctx, DISPUTE, { ...PARTIES, caseId })).rejects.toMatchObject({
      code: "IMPORT_SCOPE_MISMATCH",
    });
    expect(counts(h)).toEqual(before);
  });

  it("rolls back every new row when claim registration loses its reservation", async () => {
    h = createSandboxHarness();
    dispute(h);
    const before = counts(h);
    vi.spyOn(claims, "reserve").mockReturnValue(false);
    await expect(importDispute(h.ctx, DISPUTE, PARTIES)).rejects.toMatchObject({
      code: "CLAIM_ALREADY_ACTIVE",
    });
    expect(counts(h)).toEqual(before);
  });

  it("rolls back attachment aliases and reviews when another claim already holds the payment", async () => {
    h = createSandboxHarness();
    const caseId = await connected(h);
    const charge = requireBundle(h.ctx, caseId).charge;
    registerExistingClaim(h.ctx, { chargeId: charge.id, caseId, providerRef: "PP-D-SYN-OTHER" });
    dispute(h);
    const before = counts(h);
    const beforeBundle = requireBundle(h.ctx, caseId);
    await expect(importDispute(h.ctx, DISPUTE, { ...PARTIES, caseId })).rejects.toMatchObject({
      code: "CLAIM_ALREADY_ACTIVE",
    });
    expect(counts(h)).toEqual(before);
    expect(requireBundle(h.ctx, caseId)).toEqual(beforeBundle);
  });

  it("two concurrent imports return one case and one claim", async () => {
    h = createSandboxHarness();
    dispute(h);
    const other = h.reopen();
    const [first, second] = await Promise.all([
      importDispute(h.ctx, DISPUTE, PARTIES),
      importDispute(other, DISPUTE, PARTIES),
    ]);
    expect(first.caseId).toBe(second.caseId);
    expect(subscriptions.list(h.ctx.db)).toHaveLength(1);
    expect(charges.list(h.ctx.db)).toHaveLength(1);
    expect(cases.list(h.ctx.db)).toHaveLength(1);
    expect(claims.listForCase(h.ctx.db, first.caseId)).toHaveLength(1);
  });

  it("blocks legacy duplicate charge records by seller/sale identity at prepare and reservation", async () => {
    h = createSandboxHarness();
    const caseId = await connected(h);
    confirmCancellation(h, caseId);
    const draft = await generateDraft(h.ctx, {
      caseId,
      role: "buyer",
      action: "buyer_create_dispute",
    });
    const approval = decideApproval(h.ctx, {
      caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      draftId: draft.id,
      decision: "approved",
    });
    const original = requireBundle(h.ctx, caseId);
    const legacyCharge = {
      ...original.charge,
      id: "sb_charge_legacy_import",
      dedupeKey: "dispute:PP-D-SYN-LEGACY",
      providerRefs: [
        {
          kind: "seller_transaction_id" as const,
          value: SALE.id,
          provenance: "sandbox_api" as const,
        },
      ],
    };
    const legacyCase = {
      ...original.caseRecord,
      id: "sb_case_legacy_import",
      chargeId: legacyCharge.id,
      claimActive: true,
    };
    charges.insert(h.ctx.db, legacyCharge);
    cases.insert(h.ctx.db, legacyCase);
    registerExistingClaim(h.ctx, {
      chargeId: legacyCharge.id,
      caseId: legacyCase.id,
      providerRef: "PP-D-SYN-LEGACY",
    });
    expect(claimForCharge(h.ctx, original.charge.id)?.providerRef).toBe("PP-D-SYN-LEGACY");
    expect(() =>
      prepareOperation(h!.ctx, {
        caseId,
        role: "buyer",
        action: "buyer_create_dispute",
        approvalId: approval.id,
      }),
    ).toThrowError(expect.objectContaining({ code: "CLAIM_ALREADY_ACTIVE" }));
    const other = h.reopen();
    expect(
      claims.reserve(other.db, {
        chargeId: original.charge.id,
        environment: "sandbox",
        caseId,
        channel: "paypal",
        state: "RESERVED",
        operationId: "sb_op_syn_other",
        providerRef: null,
        openedAt: h.clock.now().toISOString(),
        updatedAt: h.clock.now().toISOString(),
      }),
    ).toBe(false);
    expect(() =>
      transferChannel(h!.ctx, {
        caseId,
        role: "buyer",
        channel: "chargeback",
        reason: "synthetic",
      }),
    ).toThrowError(expect.objectContaining({ code: "PROVIDER_CLAIM_OPEN" }));
  });

  it("rejects an import reservation lost to a concurrent claim", () => {
    h = createSandboxHarness();
    vi.spyOn(claims, "reserve").mockReturnValue(false);
    expect(() =>
      registerExistingClaim(h!.ctx, {
        chargeId: "sb_charge_syn_race",
        caseId: "sb_case_syn_race",
        providerRef: DISPUTE,
      }),
    ).toThrowError(expect.objectContaining({ code: "CLAIM_ALREADY_ACTIVE" }));
  });

  it.each(["account", "environment", "reference namespace"])(
    "does not conflate payments with a different %s",
    async (difference) => {
      h = createSandboxHarness();
      const caseId = await connected(h);
      const original = requireBundle(h.ctx, caseId).charge;
      const other = {
        ...original,
        id: "sb_charge_syn_distinct",
        dedupeKey: "distinct-payment",
        accountAlias: difference === "account" ? "other-account" : original.accountAlias,
        environment: difference === "environment" ? ("fixture" as const) : original.environment,
        providerRefs:
          difference === "reference namespace"
            ? [
                {
                  kind: "buyer_transaction_id" as const,
                  value: SALE.id,
                  provenance: "sandbox_api" as const,
                },
              ]
            : original.providerRefs,
      };
      charges.insert(h.ctx.db, other);
      expect(
        claims.reserve(h.ctx.db, {
          chargeId: other.id,
          caseId: "sb_case_syn_distinct",
          environment: other.environment,
          channel: "paypal",
          state: "OPEN",
          providerRef: "PP-D-SYN-DISTINCT",
          operationId: null,
          openedAt: h.clock.now().toISOString(),
          updatedAt: h.clock.now().toISOString(),
        }),
      ).toBe(true);
      expect(claimForCharge(h.ctx, original.id)).toBeNull();
    },
  );

  it("persists an adopted payment's canonical dedupe key", async () => {
    h = createSandboxHarness();
    await runSubscriptionSetup(h.ctx);
    h.provider.subscriptionStatus = "ACTIVE";
    const caseId = (await resumeSubscriptionSetup(h.ctx, PARTIES)).caseId!;
    h.provider.transactions = [SALE];
    await resumeSubscriptionSetup(h.ctx, PARTIES);
    expect(requireBundle(h.ctx, caseId).charge.dedupeKey).toBe(SALE.id);
  });

  it("follows provider-linked buyer and seller aliases across legacy records", async () => {
    h = createSandboxHarness();
    const caseId = await connected(h);
    const original = requireBundle(h.ctx, caseId).charge;
    charges.insert(h.ctx.db, {
      ...original,
      id: "sb_charge_syn_bridge",
      dedupeKey: "legacy-bridge",
      providerRefs: [
        { kind: "seller_transaction_id", value: SALE.id, provenance: "sandbox_api" },
        { kind: "buyer_transaction_id", value: "BUYERSYN000000002", provenance: "sandbox_api" },
      ],
    });
    charges.insert(h.ctx.db, {
      ...original,
      id: "sb_charge_syn_buyer_alias",
      dedupeKey: "legacy-buyer",
      providerRefs: [
        { kind: "buyer_transaction_id", value: "BUYERSYN000000002", provenance: "sandbox_api" },
      ],
    });
    registerExistingClaim(h.ctx, {
      chargeId: "sb_charge_syn_buyer_alias",
      caseId: "sb_case_syn_buyer_alias",
      providerRef: DISPUTE,
    });
    expect(claimForCharge(h.ctx, original.id)?.providerRef).toBe(DISPUTE);
  });

  it("does not release a legacy peer's unidentified claim on another dispute's resolution", async () => {
    h = createSandboxHarness();
    const caseId = await connected(h);
    const original = requireBundle(h.ctx, caseId);
    const legacyCharge = {
      ...original.charge,
      id: "sb_charge_syn_unidentified",
      dedupeKey: "legacy-unidentified-claim",
      providerRefs: [
        {
          kind: "seller_transaction_id" as const,
          value: SALE.id,
          provenance: "sandbox_api" as const,
        },
      ],
    };
    charges.insert(h.ctx.db, legacyCharge);
    cases.insert(h.ctx.db, {
      ...original.caseRecord,
      id: "sb_case_syn_unidentified",
      chargeId: legacyCharge.id,
    });
    expect(
      claims.reserve(h.ctx.db, {
        chargeId: legacyCharge.id,
        caseId: "sb_case_syn_unidentified",
        environment: "sandbox",
        channel: "paypal",
        state: "OPEN",
        providerRef: null,
        operationId: null,
        openedAt: h.clock.now().toISOString(),
        updatedAt: h.clock.now().toISOString(),
      }),
    ).toBe(true);
    expect(
      releaseClaimOnProviderResolution(h.ctx, {
        chargeId: original.charge.id,
        caseId,
        providerRef: DISPUTE,
        status: "RESOLVED",
      }),
    ).toBe(false);
    expect(claimForCharge(h.ctx, original.charge.id)?.chargeId).toBe(legacyCharge.id);
  });

  it("does not let a stale resolution release a replacement claim identity", async () => {
    h = createSandboxHarness();
    const caseId = await connected(h);
    const original = requireBundle(h.ctx, caseId);
    registerExistingClaim(h.ctx, { chargeId: original.charge.id, caseId, providerRef: DISPUTE });
    cases.update(h.ctx.db, { ...original.caseRecord, claimActive: true });
    const list = claims.listForPayment.bind(claims);
    // Inject a replacement precisely after the resolver reads claim A. This also verifies the
    // conditional deletion independent of process scheduling and SQLite lock timing.
    vi.spyOn(claims, "listForPayment").mockImplementationOnce((db, chargeId) => {
      expect(db.inTransaction).toBe(true);
      const stale = list(db, chargeId);
      claims.release(db, chargeId, null);
      registerExistingClaim(h!.ctx, { chargeId, caseId, providerRef: "PP-D-SYN-REPLACEMENT" });
      return stale;
    });
    expect(
      releaseClaimOnProviderResolution(h.ctx, {
        chargeId: original.charge.id,
        caseId,
        providerRef: DISPUTE,
        status: "RESOLVED",
      }),
    ).toBe(false);
    expect(claims.get(h.ctx.db, original.charge.id)?.providerRef).toBe("PP-D-SYN-REPLACEMENT");
    expect(cases.get(h.ctx.db, caseId)?.claimActive).toBe(true);
  });
});
