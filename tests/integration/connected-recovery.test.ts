import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/context";
import { createSandboxHarness, type SandboxHarness } from "../helpers/sandbox-provider";
import {
  addCaseEvidence,
  decideApproval,
  generateDraft,
  recordCancellation,
  requireBundle,
  transferChannel,
} from "@/server/services/case-service";
import {
  dispatchOperation,
  prepareOperation,
  refreshProviderObservation,
} from "@/server/services/operation-service";
import {
  SETUP_CASE_SENTINEL,
  importDispute,
  loadSetupState,
  manifestPath,
  prepareSetupIntent,
  recordBuyerTransactionReference,
  recoverSetupStage,
  replaceExpiredSubscription,
  requestSellerEvidenceSimulation,
  resumeSubscriptionSetup,
  runSubscriptionSetup,
  startNewSetupIntent,
  defaultPreview,
  parseStartDelayMinutes,
  readSubscriptionPayments,
  refreshSubscriptionObservation,
  startTimeAfter,
  startTimeSendable,
} from "@/server/services/setup-service";
import { buildCaseView } from "@/server/services/case-view";
import { setAppContextForTests } from "@/server/context";
import { CSRF_COOKIE, CSRF_HEADER, ROLE_COOKIE, encodeRoleCookie } from "@/server/http/session";
import { POST as paymentsPost } from "@/app/api/cases/[id]/subscription/payments/route";
import { deleteCase } from "@/server/services/deletion";
import { evidence as evidenceRepo, subscriptions as subscriptionRepo } from "@/server/db/repos";
import { actionReadiness } from "@/server/services/readiness";
import { cases, charges, claims, drafts, operations } from "@/server/db/repos";
import { AppError } from "@/server/services/errors";
import type { AppContext } from "@/server/context";

/**
 * Connected facts and partial-success recovery (independent audit AUD09, AUD11, AUD12 and the
 * setup partial-failure probes). Everything runs against a scripted test double or the fixture
 * simulation; no request leaves the process.
 */

let fx: TestHarness | null = null;
let sb: SandboxHarness | null = null;
afterEach(() => {
  fx?.cleanup();
  sb?.cleanup();
  fx = null;
  sb = null;
});

const PARTIES = { buyerAlias: "Test Buyer", merchantAlias: "Test Merchant" };
const PAID = {
  id: "SALE-SYN-0001",
  status: "COMPLETED",
  time: "2026-11-01T10:00:00Z",
  amountValue: "19.99",
  amountCurrency: "USD",
};

async function errorCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppError) return err.code;
    throw err;
  }
  return "NO_ERROR";
}

/** A connected case from the scripted setup: product → plan → subscription → ACTIVE read-back. */
async function connectedCase(h: SandboxHarness): Promise<string> {
  const run = await runSubscriptionSetup(h.ctx);
  expect(run.stoppedAt).toBeNull();
  h.provider.subscriptionStatus = "ACTIVE";
  const resumed = await resumeSubscriptionSetup(h.ctx, PARTIES);
  expect(resumed.caseId).toBeTruthy();
  return resumed.caseId!;
}

function confirmCancellation(ctx: AppContext, caseId: string) {
  const doc = addCaseEvidence(ctx, "buyer", {
    caseId,
    visibility: "shared",
    provenance: "user_attestation",
    kind: "cancellation_confirmation",
    label: "Cancellation confirmation (synthetic)",
    filename: "cancellation.txt",
    declaredMime: "text/plain",
    bytes: new TextEncoder().encode("Your subscription is cancelled effective 2026-10-20."),
    capturedAt: "2026-10-20T09:30:00Z",
    eventTime: "2026-10-20T09:00:00Z",
    facts: [],
  });
  recordCancellation(ctx, {
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

async function approvedBuyerDispute(ctx: AppContext, caseId: string) {
  const draft = await generateDraft(ctx, { caseId, role: "buyer", action: "buyer_create_dispute" });
  return decideApproval(ctx, {
    caseId,
    role: "buyer",
    action: "buyer_create_dispute",
    draftId: draft.id,
    decision: "approved",
  });
}

async function submitBuyerDispute(ctx: AppContext, caseId: string, approvalId: string) {
  const { operation } = prepareOperation(ctx, {
    caseId,
    role: "buyer",
    action: "buyer_create_dispute",
    approvalId,
  });
  return dispatchOperation(ctx, operation.id);
}

describe("AUD09 — a created provider case keeps its reference when the first read-back fails", () => {
  it("saves the minimal reference with the result; Refresh recovers it later without a second create", async () => {
    fx = createTestHarness();
    const { ctx, caseId } = fx;
    transferChannel(ctx, {
      caseId,
      role: "buyer",
      channel: "paypal",
      reason: "no reply (synthetic)",
    });
    const approval = await approvedBuyerDispute(ctx, caseId);
    let creates = 0;
    const create = ctx.adapter.createBuyerDispute.bind(ctx.adapter);
    ctx.adapter.createBuyerDispute = async (p, w) => {
      creates += 1;
      return create(p, w);
    };
    const read = ctx.adapter.getDispute.bind(ctx.adapter);
    let readsFail = true;
    ctx.adapter.getDispute = async (id) =>
      readsFail
        ? {
            ok: false,
            error: {
              code: "HTTP_500",
              message: "Read failed.",
              correlationId: null,
              httpStatus: 500,
            },
            retriable: true,
          }
        : read(id);

    const op = await submitBuyerDispute(ctx, caseId, approval.id);
    expect(op.status).toBe("SUCCEEDED");
    const saved = cases.get(ctx.db, caseId)!.providerObservation!;
    expect(saved.disputeId).toBe((op.result as { disputeId: string }).disputeId);
    expect(saved.observedVersion).toBe(0);
    expect(saved.stale).toBe(true);
    expect(claims.get(ctx.db, requireBundle(ctx, caseId).charge.id)?.state).toBe("OPEN");

    readsFail = false;
    const refreshed = await refreshProviderObservation(ctx, caseId, null);
    expect(refreshed.error).toBeNull();
    expect(refreshed.observation?.stale).toBe(false);
    expect(refreshed.observation?.observedVersion).toBe(1);
    expect(refreshed.observation?.disputeId).toBe(saved.disputeId);
    expect(creates).toBe(1);
  });

  it("falls back to the identifier stored on the succeeded operation when no reference was kept", async () => {
    fx = createTestHarness();
    const { ctx, caseId } = fx;
    transferChannel(ctx, {
      caseId,
      role: "buyer",
      channel: "paypal",
      reason: "no reply (synthetic)",
    });
    const approval = await approvedBuyerDispute(ctx, caseId);
    const op = await submitBuyerDispute(ctx, caseId, approval.id);
    // A database written before the reference was saved: the observation is missing.
    cases.update(ctx.db, { ...cases.get(ctx.db, caseId)!, providerObservation: null });
    const refreshed = await refreshProviderObservation(ctx, caseId, null);
    expect(refreshed.error).toBeNull();
    expect(refreshed.observation?.disputeId).toBe((op.result as { disputeId: string }).disputeId);
  });
});

describe("AUD11 — later subscription reads update the existing charge", () => {
  it("adopts a payment observed after the case was created and invalidates bound drafts", async () => {
    sb = createSandboxHarness();
    const caseId = await connectedCase(sb);
    const before = requireBundle(sb.ctx, caseId);
    expect(before.charge.status).toBe("UNKNOWN");
    expect(before.charge.eventTime).toBeNull();
    expect(before.charge.refundStateKnown).toBe(false);

    sb.provider.transactions = [PAID];
    await resumeSubscriptionSetup(sb.ctx, PARTIES);
    const after = requireBundle(sb.ctx, caseId);
    expect(after.charge.id).toBe(before.charge.id);
    expect(after.charge.providerRefs.find((r) => r.kind === "subscription_sale_id")?.value).toBe(
      PAID.id,
    );
    expect(after.charge.eventTime).toBe(PAID.time);
    expect(after.charge.status).toBe("COMPLETED");
    expect(after.charge.amountCents).toBe(1999);
    expect(after.charge.refundStateKnown).toBe(true);
    expect(after.charge.refundedCents).toBe(0);
    expect(after.caseRecord.evidenceSnapshotVersion).toBeGreaterThan(
      before.caseRecord.evidenceSnapshotVersion,
    );
    // Still one case and one charge for the subscription.
    expect(cases.list(sb.ctx.db)).toHaveLength(1);
  });

  it("a changed refund state on the same sale makes an existing draft stale", async () => {
    sb = createSandboxHarness();
    sb.provider.transactions = [PAID];
    const caseId = await connectedCase(sb);
    confirmCancellation(sb.ctx, caseId);
    const draft = await generateDraft(sb.ctx, {
      caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    expect(
      actionReadiness(sb.ctx, requireBundle(sb.ctx, caseId), "buyer", "export_refund_request")
        .approve,
    ).toBeNull();

    sb.provider.transactions = [{ ...PAID, status: "REFUNDED" }];
    await resumeSubscriptionSetup(sb.ctx, PARTIES);
    const bundle = requireBundle(sb.ctx, caseId);
    expect(bundle.charge.status).toBe("REFUNDED");
    expect(bundle.charge.refundedCents).toBe(1999);
    expect(drafts.get(sb.ctx.db, draft.id)!.snapshotVersion).toBeLessThan(
      bundle.caseRecord.evidenceSnapshotVersion,
    );
    // Fully refunded: nothing is left to request, so the old draft cannot be approved.
    expect(
      actionReadiness(sb.ctx, bundle, "buyer", "export_refund_request").approve,
    ).not.toBeNull();
  });

  it("an unknown partial refund stays unknown instead of becoming 0", async () => {
    sb = createSandboxHarness();
    sb.provider.transactions = [{ ...PAID, status: "PARTIALLY_REFUNDED" }];
    const caseId = await connectedCase(sb);
    confirmCancellation(sb.ctx, caseId);
    const bundle = requireBundle(sb.ctx, caseId);
    expect(bundle.charge.refundStateKnown).toBe(false);
    expect(bundle.charge.refundedCents).toBeNull();
    expect(bundle.caseRecord.claimableCents).toBeNull();
    expect(bundle.caseRecord.reasonCodes).toContain("REFUND_STATE_UNKNOWN");
  });
});

describe("AUD12 — an imported case takes payment facts only from the provider read", () => {
  it("uses the disputed transaction's time, status and amount", async () => {
    sb = createSandboxHarness();
    sb.provider.disputes["PP-D-SYN-IMPORT"] = {
      status: "WAITING_FOR_SELLER_RESPONSE",
      transaction: {
        sellerTransactionId: "SELLERSYN00000001",
        buyerTransactionId: "BUYERSYN000000001",
        createTime: "2026-10-28T07:15:00Z",
        status: "COMPLETED",
        grossValue: "19.99",
        grossCurrency: "USD",
      },
    };
    const { caseId } = await importDispute(sb.ctx, "PP-D-SYN-IMPORT", PARTIES);
    const charge = requireBundle(sb.ctx, caseId).charge;
    expect(charge.eventTime).toBe("2026-10-28T07:15:00Z");
    expect(charge.eventTime).not.toBe(sb.clock.now().toISOString());
    expect(charge.status).toBe("COMPLETED");
    expect(charge.amountCents).toBe(1999);
    expect(charge.providerRefs.map((r) => r.kind)).toEqual(
      expect.arrayContaining(["dispute_id", "seller_transaction_id", "buyer_transaction_id"]),
    );
  });

  it("without transaction details the payment time, status and refund stay unknown", async () => {
    sb = createSandboxHarness();
    sb.provider.disputes["PP-D-SYN-BARE"] = { status: "OPEN", transaction: null };
    const { caseId } = await importDispute(sb.ctx, "PP-D-SYN-BARE", PARTIES);
    const charge = requireBundle(sb.ctx, caseId).charge;
    expect(charge.eventTime).toBeNull();
    expect(charge.status).toBe("UNKNOWN");
    expect(charge.amountCents).toBeNull();
    expect(charge.refundStateKnown).toBe(false);
    expect(charge.refundedCents).toBeNull();
  });
});

describe("payments read from the app — one case per payment, checked against the cancellation", () => {
  const LATER = {
    id: "SALE-SYN-0002",
    status: "COMPLETED",
    time: "2026-11-02T10:00:00Z",
    amountValue: "19.99",
    amountCurrency: "USD",
  };

  function cancelAt(ctx: AppContext, caseId: string, at: string) {
    const doc = addCaseEvidence(ctx, "buyer", {
      caseId,
      visibility: "shared",
      provenance: "user_attestation",
      kind: "cancellation_confirmation",
      label: "Cancellation confirmation (synthetic)",
      filename: "cancellation.txt",
      declaredMime: "text/plain",
      bytes: new TextEncoder().encode(`Your subscription is cancelled effective ${at}.`),
      capturedAt: at,
      eventTime: at,
      facts: [],
    });
    recordCancellation(ctx, {
      caseId,
      role: "buyer",
      event: {
        type: "RECORD_CONFIRMATION",
        receivedAt: at,
        effectiveAt: at,
        basis: "merchant_confirmation_document",
        evidenceIds: [doc.id],
      },
    });
  }

  it("shows the provider's plan beside the cancellation, then turns the later payment into its own case", async () => {
    sb = createSandboxHarness("2026-11-01T13:00:00Z");
    sb.provider.transactions = [PAID];
    const first = await connectedCase(sb);
    cancelAt(sb.ctx, first, "2026-11-01T12:00:00Z");

    // Before any mandate read there is nothing to warn about.
    expect(buildCaseView(sb.ctx, first, "buyer").subscription.billingWatch).toBeNull();
    sb.provider.nextBillingTime = "2026-11-02T10:00:00Z";
    const mandate = await refreshSubscriptionObservation(sb.ctx, first);
    expect(mandate.nextBillingAt).toBe("2026-11-02T10:00:00Z");
    const planned = buildCaseView(sb.ctx, first, "buyer");
    expect(planned.subscription.billingWatch).toMatchObject({
      nextBillingAt: "2026-11-02T10:00:00Z",
      provenance: "sandbox_api",
      due: false,
    });
    expect(planned.subscription.paymentsReadable).toBe(true);
    // The plan is a provider observation: it changes neither the cancellation nor the check.
    expect(planned.subscription.cancellation.state).toBe("CANCEL_CONFIRMED");
    expect(planned.case.classification).not.toBe("CANDIDATE_AFTER_CANCEL");
    expect(buildCaseView(sb.ctx, first, "merchant").subscription.paymentsReadable).toBe(false);

    // The planned time passes and PayPal reports the payment.
    sb.clock.set("2026-11-02T10:05:00Z");
    expect(buildCaseView(sb.ctx, first, "buyer").subscription.billingWatch!.due).toBe(true);
    sb.provider.transactions = [PAID, LATER];
    sb.provider.nextBillingTime = "2026-11-03T10:00:00Z";
    const read = await readSubscriptionPayments(sb.ctx, first, "buyer");
    expect(read.transactionCount).toBe(2);
    expect(read.newCaseIds).toHaveLength(1);
    expect(read.nextBillingAt).toBe("2026-11-03T10:00:00Z");
    const later = requireBundle(sb.ctx, read.newCaseIds[0]!);
    expect(later.charge.providerRefs[0]!.value).toBe("SALE-SYN-0002");
    expect(later.caseRecord.classification).toBe("CANDIDATE_AFTER_CANCEL");
    expect(later.subscription.id).toBe(requireBundle(sb.ctx, first).subscription.id);

    // Both cases point at each other; the first payment is still its own, unchanged case.
    const firstView = buildCaseView(sb.ctx, first, "buyer");
    expect(firstView.relatedCases.map((r) => r.id)).toEqual([later.caseRecord.id]);
    expect(firstView.relatedCases[0]!.classification).toBe("CANDIDATE_AFTER_CANCEL");
    expect(
      buildCaseView(sb.ctx, later.caseRecord.id, "buyer").relatedCases.map((r) => r.id),
    ).toEqual([first]);
    expect(requireBundle(sb.ctx, first).charge.providerRefs[0]!.value).toBe("SALE-SYN-0001");

    // Reading again finds nothing new and creates nothing.
    const again = await readSubscriptionPayments(sb.ctx, first, "buyer");
    expect(again.newCaseIds).toHaveLength(0);
    expect(cases.list(sb.ctx.db)).toHaveLength(2);
  });

  it("works for a case created before any payment, without the setup manifest", async () => {
    sb = createSandboxHarness("2026-11-01T07:00:00Z");
    await runSubscriptionSetup(sb.ctx);
    sb.provider.subscriptionStatus = "ACTIVE";
    const caseId = (await resumeSubscriptionSetup(sb.ctx, PARTIES)).caseId!;
    cancelAt(sb.ctx, caseId, "2026-11-01T08:00:00Z");
    // The read no longer needs the manifest: a later intent may have replaced it.
    fs.rmSync(manifestPath(sb.ctx));
    sb.clock.set("2026-11-01T10:05:00Z");
    sb.provider.transactions = [PAID];
    const read = await readSubscriptionPayments(sb.ctx, caseId, "buyer");
    expect(read.newCaseIds).toHaveLength(0);
    const charged = requireBundle(sb.ctx, caseId);
    expect(charged.charge.providerRefs[0]!.value).toBe("SALE-SYN-0001");
    expect(charged.caseRecord.classification).toBe("CANDIDATE_AFTER_CANCEL");
    expect(cases.list(sb.ctx.db)).toHaveLength(1);
  });

  it("a failed read changes nothing, and the read is refused where it does not apply", async () => {
    sb = createSandboxHarness("2026-11-01T13:00:00Z");
    sb.provider.transactions = [PAID];
    const first = await connectedCase(sb);
    cancelAt(sb.ctx, first, "2026-11-01T12:00:00Z");
    const before = JSON.stringify(requireBundle(sb.ctx, first).subscription.cancellation);

    sb.provider.transactions = [PAID, LATER];
    sb.provider.transactionReadFails = true;
    expect(await errorCode(() => readSubscriptionPayments(sb!.ctx, first, "buyer"))).toBe(
      "PROVIDER_READ_FAILED",
    );
    expect(cases.list(sb.ctx.db)).toHaveLength(1);
    expect(JSON.stringify(requireBundle(sb.ctx, first).subscription.cancellation)).toBe(before);
    sb.provider.transactionReadFails = false;

    expect(await errorCode(() => readSubscriptionPayments(sb!.ctx, first, "merchant"))).toBe(
      "ROLE_NOT_ALLOWED",
    );
    sb.provider.disputes["PP-D-SYN-IMPORT"] = { status: "OPEN", transaction: null };
    const imported = (await importDispute(sb.ctx, "PP-D-SYN-IMPORT", PARTIES)).caseId;
    expect(await errorCode(() => readSubscriptionPayments(sb!.ctx, imported, "buyer"))).toBe(
      "NO_PROVIDER_SUBSCRIPTION",
    );
    expect(buildCaseView(sb.ctx, imported, "buyer").subscription.paymentsReadable).toBe(false);
    expect(cases.list(sb.ctx.db)).toHaveLength(2);

    fx = createTestHarness();
    const fixtureCase = cases.list(fx.ctx.db)[0]!.id;
    expect(await errorCode(() => readSubscriptionPayments(fx!.ctx, fixtureCase, "buyer"))).toBe(
      "WRONG_MODE",
    );
    expect(buildCaseView(fx.ctx, fixtureCase, "buyer").subscription.paymentsReadable).toBe(false);
  });

  it("the route keeps the mutation guards and reports what was found", async () => {
    sb = createSandboxHarness("2026-11-02T10:05:00Z");
    sb.provider.transactions = [PAID];
    const first = await connectedCase(sb);
    cancelAt(sb.ctx, first, "2026-11-01T12:00:00Z");
    sb.provider.transactions = [PAID, LATER];
    setAppContextForTests(sb.ctx);
    try {
      const host = new URL(sb.ctx.config.appOrigin).host;
      const request = (role: "buyer" | "merchant", origin: string) =>
        new Request(`http://${host}/api/cases/${first}/subscription/payments`, {
          method: "POST",
          headers: {
            host,
            origin,
            cookie: `${ROLE_COOKIE}=${encodeURIComponent(encodeRoleCookie(sb!.ctx, role))}; ${CSRF_COOKIE}=tok`,
            [CSRF_HEADER]: "tok",
            "content-type": "application/json",
          },
          body: "{}",
        });
      const params = { params: Promise.resolve({ id: first }) };
      const crossOrigin = await paymentsPost(request("buyer", "http://attacker.example"), params);
      expect(crossOrigin.status).toBe(403);
      const merchant = await paymentsPost(request("merchant", sb.ctx.config.appOrigin), params);
      expect(merchant.status).toBe(403);
      expect(((await merchant.json()) as { error: { code: string } }).error.code).toBe(
        "ROLE_NOT_ALLOWED",
      );
      expect(cases.list(sb.ctx.db)).toHaveLength(1);

      const ok = await paymentsPost(request("buyer", sb.ctx.config.appOrigin), params);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as {
        message: string;
        result: { newCaseIds: string[] };
        view: { relatedCases: { id: string }[] };
      };
      expect(body.result.newCaseIds).toHaveLength(1);
      expect(body.message).toMatch(/^1 new payment found\./);
      expect(body.view.relatedCases.map((r) => r.id)).toEqual(body.result.newCaseIds);
    } finally {
      setAppContextForTests(null);
    }
  });
});

describe("Sandbox test mutation — the provider's evidence-request simulation", () => {
  const TX = {
    sellerTransactionId: "SELLERSYN00000001",
    buyerTransactionId: "BUYERSYN000000001",
    createTime: "2026-10-28T07:15:00Z",
    status: "COMPLETED",
    grossValue: "19.99",
    grossCurrency: "USD",
  };
  const simulationOps = (ctx: AppContext) =>
    operations
      .listForCase(ctx.db, SETUP_CASE_SENTINEL)
      .filter((op) => op.action === "sandbox_require_evidence");

  async function underReview(h: SandboxHarness, offered: boolean) {
    h.provider.disputes["PP-D-SYN-REVIEW"] = {
      status: "UNDER_REVIEW",
      transaction: TX,
      allowedActions: offered ? ["accept_claim", "require_evidence"] : ["accept_claim"],
    };
    return (await importDispute(h.ctx, "PP-D-SYN-REVIEW", PARTIES)).caseId;
  }

  it("is sent once, only when a fresh read offers it, and the case is read back", async () => {
    sb = createSandboxHarness();
    const caseId = await underReview(sb, true);
    const before = requireBundle(sb.ctx, caseId).caseRecord;
    // A real request takes time: the read-back is later than the read before it.
    sb.provider.simulation.afterSuccess = () => sb!.clock.advanceMinutes(1);
    const sim = await requestSellerEvidenceSimulation(sb.ctx, caseId);
    expect(sim.operation.status).toBe("SUCCEEDED");
    expect(sim.statusBefore).toBe("UNDER_REVIEW");
    expect(sim.statusAfter).toBe("WAITING_FOR_SELLER_RESPONSE");
    expect(sim.allowedAfter).toContain("provide_evidence");
    expect(sb.provider.simulation.calls).toBe(1);
    const after = requireBundle(sb.ctx, caseId).caseRecord;
    expect(after.providerObservation!.status).toBe("WAITING_FOR_SELLER_RESPONSE");
    // The provider state changed, so anything bound to the old state needs a new review.
    expect(after.evidenceSnapshotVersion).toBeGreaterThan(before.evidenceSnapshotVersion);
    // It is a recorded test mutation with its own approval, not a case action.
    const ops = simulationOps(sb.ctx);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.approvalId).toBeTruthy();
    expect(operations.listForCase(sb.ctx.db, caseId)).toHaveLength(0);

    // PayPal no longer offers it while the seller's response is awaited: nothing more is sent.
    expect(await errorCode(() => requestSellerEvidenceSimulation(sb!.ctx, caseId))).toBe(
      "SIMULATION_NOT_OFFERED",
    );
    expect(sb.provider.simulation.calls).toBe(1);
  });

  it("sends nothing when the capability is absent, the read fails or the case is not a provider case", async () => {
    sb = createSandboxHarness();
    const caseId = await underReview(sb, false);
    expect(await errorCode(() => requestSellerEvidenceSimulation(sb!.ctx, caseId))).toBe(
      "SIMULATION_NOT_OFFERED",
    );
    sb.provider.disputes["PP-D-SYN-REVIEW"]!.allowedActions = ["require_evidence"];
    sb.provider.disputeReadFails = 1;
    expect(await errorCode(() => requestSellerEvidenceSimulation(sb!.ctx, caseId))).toBe(
      "PROVIDER_READ_FAILED",
    );
    sb.provider.transactions = [PAID];
    const plain = await connectedCase(sb);
    expect(await errorCode(() => requestSellerEvidenceSimulation(sb!.ctx, plain))).toBe(
      "NO_PROVIDER_CASE",
    );
    expect(sb.provider.simulation.calls).toBe(0);
    expect(simulationOps(sb.ctx)).toHaveLength(0);

    fx = createTestHarness();
    const fixtureCase = cases.list(fx.ctx.db)[0]!.id;
    expect(await errorCode(() => requestSellerEvidenceSimulation(fx!.ctx, fixtureCase))).toBe(
      "WRONG_MODE",
    );
  });

  it("an unknown result blocks another attempt; a rejected one allows a new attempt", async () => {
    sb = createSandboxHarness();
    const caseId = await underReview(sb, true);
    sb.provider.simulation.script = ["fail", "unknown"];
    const rejected = await requestSellerEvidenceSimulation(sb.ctx, caseId);
    expect(rejected.operation.status).toBe("FAILED");
    expect(rejected.statusAfter).toBeNull();

    const unknown = await requestSellerEvidenceSimulation(sb.ctx, caseId);
    expect(unknown.operation.status).toBe("UNKNOWN");
    expect(unknown.operation.id).not.toBe(rejected.operation.id);
    expect(sb.provider.simulation.calls).toBe(2);

    // The request may have been applied: never sent again until someone checks.
    expect(await errorCode(() => requestSellerEvidenceSimulation(sb!.ctx, caseId))).toBe(
      "SIMULATION_UNSETTLED",
    );
    expect(sb.provider.simulation.calls).toBe(2);
  });
});

describe("connected buyer request — payment preflight", () => {
  async function readyToSubmit(h: SandboxHarness) {
    h.provider.transactions = [PAID];
    const caseId = await connectedCase(h);
    confirmCancellation(h.ctx, caseId);
    recordBuyerTransactionReference(h.ctx, caseId, "BUYERSYN000000002");
    const approval = await approvedBuyerDispute(h.ctx, caseId);
    return { caseId, approval };
  }

  it("unchanged payment facts: the request is sent once and its reference is kept", async () => {
    sb = createSandboxHarness();
    const { caseId, approval } = await readyToSubmit(sb);
    sb.provider.disputeReadFails = 1;
    const op = await submitBuyerDispute(sb.ctx, caseId, approval.id);
    expect(op.status).toBe("SUCCEEDED");
    expect(sb.provider.calls.dispute).toBe(1);
    expect(cases.get(sb.ctx.db, caseId)!.providerObservation?.disputeId).toBe("PP-D-SYN-1");
  });

  it("a refund that appeared after approval stops the request before anything is sent", async () => {
    sb = createSandboxHarness();
    const { caseId, approval } = await readyToSubmit(sb);
    sb.provider.transactions = [{ ...PAID, status: "PARTIALLY_REFUNDED" }];
    const op = await submitBuyerDispute(sb.ctx, caseId, approval.id);
    expect(op.status).toBe("FAILED");
    expect(op.errorCode).toBe("PREFLIGHT_MATERIAL_CHANGED");
    expect(sb.provider.calls.dispute).toBe(0);
    const bundle = requireBundle(sb.ctx, caseId);
    expect(bundle.charge.refundStateKnown).toBe(false);
    expect(claims.get(sb.ctx.db, bundle.charge.id)).toBeNull();
  });

  it("a failed payment read blocks the request", async () => {
    sb = createSandboxHarness();
    const { caseId, approval } = await readyToSubmit(sb);
    sb.provider.transactionReadFails = true;
    const op = await submitBuyerDispute(sb.ctx, caseId, approval.id);
    expect(op.errorCode).toBe("PREFLIGHT_READ_FAILED");
    expect(sb.provider.calls.dispute).toBe(0);
  });

  it("a charge without a readable payment reference is not sent", async () => {
    sb = createSandboxHarness();
    const { caseId, approval } = await readyToSubmit(sb);
    const charge = requireBundle(sb.ctx, caseId).charge;
    charges.update(sb.ctx.db, {
      ...charge,
      providerRefs: charge.providerRefs.filter((r) => r.kind !== "subscription_sale_id"),
    });
    const op = await submitBuyerDispute(sb.ctx, caseId, approval.id);
    expect(op.errorCode).toBe("PAYMENT_FACTS_UNAVAILABLE");
    expect(sb.provider.calls.dispute).toBe(0);
  });
});

describe("setup — fixed intent, per-stage persistence and recovery", () => {
  it("records the intent before the first write and never repeats a succeeded stage", async () => {
    sb = createSandboxHarness();
    const intent = prepareSetupIntent(sb.ctx, defaultPreview(sb.ctx.config.appOrigin));
    expect(fs.existsSync(manifestPath(sb.ctx))).toBe(true);
    expect(sb.provider.calls).toEqual({ product: 0, plan: 0, subscription: 0, dispute: 0 });
    const run = await runSubscriptionSetup(sb.ctx);
    expect(run.stoppedAt).toBeNull();
    expect(sb.provider.calls).toMatchObject({ product: 1, plan: 1, subscription: 1 });
    expect(sb.provider.seen.customIds).toEqual([intent.preview.subscription.customId]);
    expect(await errorCode(() => runSubscriptionSetup(sb!.ctx))).toBe("ALREADY_SET_UP");
    expect(sb.provider.calls).toMatchObject({ product: 1, plan: 1, subscription: 1 });
  });

  it("a rejected plan keeps the product; the retry creates only the plan and the subscription", async () => {
    sb = createSandboxHarness();
    sb.provider.script.plan = ["fail"];
    const first = await runSubscriptionSetup(sb.ctx);
    expect(first.stoppedAt).toBe("plan");
    expect(first.reason).toBe("FAILED");
    expect(first.manifest.stages.product.status).toBe("succeeded");
    const second = await runSubscriptionSetup(sb.ctx, {
      ...defaultPreview(sb.ctx.config.appOrigin),
      subscription: {
        customId: "a-different-preview-is-ignored",
        returnUrl: "http://127.0.0.1:3999/x",
        cancelUrl: "http://127.0.0.1:3999/y",
      },
    });
    expect(second.stoppedAt).toBeNull();
    expect(sb.provider.calls).toMatchObject({ product: 1, plan: 2, subscription: 1 });
    expect(second.manifest.stages.plan.attempt).toBe(2);
    expect(sb.provider.seen.customIds).toEqual([first.manifest.preview.subscription.customId]);
    expect(new Set(sb.provider.seen.requestIds).size).toBe(sb.provider.seen.requestIds.length);
  });

  it("an unknown stage stops every later run, even after the manifest is moved aside", async () => {
    sb = createSandboxHarness();
    sb.provider.script.plan = ["unknown"];
    const first = await runSubscriptionSetup(sb.ctx);
    expect(first.reason).toBe("UNKNOWN");
    const again = await runSubscriptionSetup(sb.ctx);
    expect(again.stoppedAt).toBe("plan");
    expect(again.reason).toBe("UNKNOWN");

    fs.renameSync(manifestPath(sb.ctx), `${manifestPath(sb.ctx)}.moved`);
    const afterMove = await runSubscriptionSetup(sb.ctx);
    expect(afterMove.reason).toBe("UNKNOWN");
    expect(afterMove.manifest.intent.id).toBe(first.manifest.intent.id);
    expect(afterMove.manifest.productId).toBe(first.manifest.productId);
    expect(sb.provider.calls).toMatchObject({ product: 1, plan: 1, subscription: 0 });

    expect(
      await errorCode(() =>
        recoverSetupStage(sb!.ctx, "plan", { outcome: "succeeded", resourceId: "P-SYN-1" }, "ok"),
      ),
    ).toBe("RECOVERY_NOTE_REQUIRED");
    recoverSetupStage(
      sb.ctx,
      "plan",
      { outcome: "succeeded", resourceId: "P-SYN-1" },
      "Plan P-SYN-1 is listed in the dashboard (synthetic test).",
    );
    const done = await runSubscriptionSetup(sb.ctx);
    expect(done.stoppedAt).toBeNull();
    expect(done.manifest.planId).toBe("P-SYN-1");
    expect(sb.provider.calls).toMatchObject({ product: 1, plan: 1, subscription: 1 });
    const recovered = operations
      .listForCase(sb.ctx.db, SETUP_CASE_SENTINEL)
      .find((o) => o.action === "sandbox_setup_plan");
    expect(recovered?.recoveryDecision).toBe("confirmed_succeeded");
  });

  it("an exception after the request was sent is unknown; confirmed-not-created allows a new attempt", async () => {
    sb = createSandboxHarness();
    sb.provider.script.subscription = ["throw"];
    const first = await runSubscriptionSetup(sb.ctx);
    expect(first.stoppedAt).toBe("subscription");
    expect(first.reason).toBe("UNKNOWN");
    expect(
      await errorCode(() =>
        recoverSetupStage(sb!.ctx, "plan", { outcome: "failed" }, "x".repeat(20)),
      ),
    ).toBe("STAGE_NOT_UNKNOWN");
    recoverSetupStage(
      sb.ctx,
      "subscription",
      { outcome: "failed" },
      "No subscription for the plan in the dashboard (synthetic test).",
    );
    const second = await runSubscriptionSetup(sb.ctx);
    expect(second.stoppedAt).toBeNull();
    expect(second.manifest.stages.subscription.attempt).toBe(2);
    expect(sb.provider.calls).toMatchObject({ product: 1, plan: 1, subscription: 2 });
  });

  it("a process that stopped mid-write leaves the stage unknown after restart, never resent", async () => {
    sb = createSandboxHarness();
    sb.provider.script.plan = ["hang"];
    void runSubscriptionSetup(sb.ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(sb.provider.calls).toMatchObject({ product: 1, plan: 1 });
    sb.clock.advanceMinutes(5);
    const restarted = sb.reopen();
    const state = loadSetupState(restarted)!;
    expect(state.stages.product.status).toBe("succeeded");
    expect(state.stages.plan.status).toBe("unknown");
    const run = await runSubscriptionSetup(restarted);
    expect(run.reason).toBe("UNKNOWN");
    expect(sb.provider.calls).toMatchObject({ product: 1, plan: 1, subscription: 0 });
  });

  it("an unsettled operation from the earlier single-call setup blocks new writes", async () => {
    sb = createSandboxHarness();
    const now = sb.clock.now().toISOString();
    operations.insert(sb.ctx.db, {
      id: "sb_op_legacy0001",
      logicalKey: "sandbox:setup:subscription:legacy",
      environment: "sandbox",
      caseId: SETUP_CASE_SENTINEL,
      role: "merchant",
      action: "sandbox_setup_subscription",
      resourceId: "sandbox:setup:subscription:legacy",
      payload: defaultPreview(sb.ctx.config.appOrigin),
      payloadHash: "0".repeat(64),
      payloadVersion: 1,
      attachmentHashes: [],
      approvalId: null,
      status: "UNKNOWN",
      attempts: 1,
      leaseUntil: null,
      providerRequestId: null,
      result: null,
      errorCode: "TIMEOUT",
      errorMessage: "No response.",
      recoveryDecision: null,
      recoveryNote: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(await errorCode(() => runSubscriptionSetup(sb!.ctx))).toBe("LEGACY_SETUP_UNRESOLVED");
    expect(sb.provider.calls.product).toBe(0);
  });

  it("resume never creates a second connected case for the same subscription", async () => {
    sb = createSandboxHarness();
    sb.provider.transactions = [PAID];
    const caseId = await connectedCase(sb);
    fs.rmSync(manifestPath(sb.ctx));
    const again = await resumeSubscriptionSetup(sb.ctx, PARTIES);
    expect(again.caseId).toBe(caseId);
    expect(cases.list(sb.ctx.db)).toHaveLength(1);
  });

  it("an unapproved subscription PayPal dropped is replaced once, for the same plan, never while it exists", async () => {
    sb = createSandboxHarness();
    const first = await runSubscriptionSetup(sb.ctx);
    const oldId = first.manifest.subscriptionId!;
    // Still there: no replacement.
    expect(await errorCode(() => replaceExpiredSubscription(sb!.ctx))).toBe("SUBSCRIPTION_EXISTS");
    sb.provider.missingSubscriptions.add(oldId);
    const resumed = await resumeSubscriptionSetup(sb.ctx, PARTIES);
    expect(resumed.status).toBe("NOT_FOUND");
    expect(resumed.caseId).toBeNull();

    const replaced = await replaceExpiredSubscription(sb.ctx);
    expect(replaced.stoppedAt).toBeNull();
    expect(replaced.manifest.subscriptionId).not.toBe(oldId);
    expect(replaced.manifest.stages.subscription.attempt).toBe(2);
    expect(replaced.manifest.approveUrl).toBeTruthy();
    expect(replaced.manifest.lastStatus).toBe("APPROVAL_PENDING");
    expect(sb.provider.calls).toMatchObject({ product: 1, plan: 1, subscription: 2 });
    // The same intent: same custom_id, new request ID.
    expect(new Set(sb.provider.seen.customIds).size).toBe(1);
    expect(new Set(sb.provider.seen.requestIds).size).toBe(sb.provider.seen.requestIds.length);

    // Repeating the command cannot create a third one while the replacement exists.
    expect(await errorCode(() => replaceExpiredSubscription(sb!.ctx))).toBe("SUBSCRIPTION_EXISTS");
    expect(sb.provider.calls.subscription).toBe(2);

    sb.provider.subscriptionStatus = "ACTIVE";
    sb.provider.transactions = [PAID];
    const active = await resumeSubscriptionSetup(sb.ctx, PARTIES);
    expect(active.status).toBe("ACTIVE");
    expect(active.caseId).toBeTruthy();
  });

  it("a subscription with a connected case, or an unreadable one, is never replaced", async () => {
    sb = createSandboxHarness();
    sb.provider.transactions = [PAID];
    await connectedCase(sb);
    const id = loadSetupState(sb.ctx)!.subscriptionId!;
    sb.provider.missingSubscriptions.add(id);
    expect(await errorCode(() => replaceExpiredSubscription(sb!.ctx))).toBe("SUBSCRIPTION_IN_USE");

    const other = createSandboxHarness();
    try {
      await runSubscriptionSetup(other.ctx);
      other.provider.getSubscription = async () => ({
        ok: false,
        error: { code: "HTTP_503", message: "Unavailable.", correlationId: null, httpStatus: 503 },
        retriable: true,
      });
      expect(await errorCode(() => replaceExpiredSubscription(other.ctx))).toBe(
        "SUBSCRIPTION_STATE_UNCONFIRMED",
      );
      expect(other.provider.calls.subscription).toBe(1);
    } finally {
      other.cleanup();
    }
  });
});

describe("setup — a further intent and later payments of the same subscription", () => {
  const LATER = {
    id: "SALE-SYN-0002",
    status: "COMPLETED",
    time: "2026-11-02T10:00:00Z",
    amountValue: "19.99",
    amountCurrency: "USD",
  };

  it("a daily intent starts only after the current setup is complete and stays current across restarts", async () => {
    sb = createSandboxHarness();
    sb.provider.script.plan = ["unknown"];
    await runSubscriptionSetup(sb.ctx);
    const daily = defaultPreview(sb.ctx.config.appOrigin, undefined, "DAY");
    expect(await errorCode(() => startNewSetupIntent(sb!.ctx, daily))).toBe("SETUP_INCOMPLETE");

    const other = createSandboxHarness();
    try {
      const first = await runSubscriptionSetup(other.ctx);
      expect(first.stoppedAt).toBeNull();
      const next = startNewSetupIntent(other.ctx, daily);
      expect(next.intent.id).not.toBe(first.manifest.intent.id);
      expect(next.previousIntentIds).toEqual([first.manifest.intent.id]);
      expect(next.preview.plan.intervalUnit).toBe("DAY");
      expect(next.preview.subscription.customId).not.toBe(
        first.manifest.preview.subscription.customId,
      );
      // Nothing was written for it yet, and it is still the current intent after a restart.
      expect(loadSetupState(other.reopen())!.intent.id).toBe(next.intent.id);
      // A second new intent before this one is created is refused.
      expect(await errorCode(() => startNewSetupIntent(other.ctx, daily))).toBe("SETUP_INCOMPLETE");

      const created = await runSubscriptionSetup(other.ctx);
      expect(created.stoppedAt).toBeNull();
      expect(other.provider.calls).toMatchObject({ product: 2, plan: 2, subscription: 2 });
      expect(new Set(other.provider.seen.customIds).size).toBe(2);
      // With the manifest gone, the ledger rebuilds the latest intent, not the earlier one.
      fs.rmSync(manifestPath(other.ctx));
      expect(loadSetupState(other.ctx)!.intent.id).toBe(next.intent.id);
    } finally {
      other.cleanup();
    }
  });

  it("each later payment becomes its own case that shares the recorded cancellation", async () => {
    sb = createSandboxHarness();
    sb.provider.transactions = [PAID];
    const firstCase = await connectedCase(sb);
    const doc = addCaseEvidence(sb.ctx, "buyer", {
      caseId: firstCase,
      visibility: "shared",
      provenance: "user_attestation",
      kind: "cancellation_confirmation",
      label: "Cancellation confirmation (synthetic)",
      filename: "cancellation.txt",
      declaredMime: "text/plain",
      bytes: new TextEncoder().encode(
        "Your subscription is cancelled effective 2026-11-01 12:00 UTC.",
      ),
      capturedAt: "2026-11-01T12:00:00Z",
      eventTime: "2026-11-01T12:00:00Z",
      facts: [],
    });
    recordCancellation(sb.ctx, {
      caseId: firstCase,
      role: "buyer",
      event: {
        type: "RECORD_CONFIRMATION",
        receivedAt: "2026-11-01T12:00:00Z",
        effectiveAt: "2026-11-01T12:00:00Z",
        basis: "merchant_confirmation_document",
        evidenceIds: [doc.id],
      },
    });
    // The first payment came before the cancellation took effect.
    expect(requireBundle(sb.ctx, firstCase).caseRecord.classification).not.toBe(
      "CANDIDATE_AFTER_CANCEL",
    );

    sb.provider.transactions = [PAID, LATER];
    const read = await resumeSubscriptionSetup(sb.ctx, PARTIES);
    expect(read.caseId).toBe(firstCase);
    expect(read.laterPaymentCaseIds).toHaveLength(1);
    const later = requireBundle(sb.ctx, read.laterPaymentCaseIds[0]!);
    expect(later.subscription.id).toBe(requireBundle(sb.ctx, firstCase).subscription.id);
    expect(later.charge.providerRefs).toEqual([
      { kind: "subscription_sale_id", value: "SALE-SYN-0002", provenance: "sandbox_api" },
    ]);
    expect(later.caseRecord.classification).toBe("CANDIDATE_AFTER_CANCEL");
    // The confirmation document is the subscription's: the later case sees it as a source.
    expect(later.allEvidence.map((e) => e.id)).toContain(doc.id);
    // The first case still holds only the first sale.
    expect(requireBundle(sb.ctx, firstCase).charge.providerRefs[0]!.value).toBe("SALE-SYN-0001");

    // Reading again creates nothing new.
    const again = await resumeSubscriptionSetup(sb.ctx, PARTIES);
    expect(again.laterPaymentCaseIds).toHaveLength(0);
    expect(cases.list(sb.ctx.db)).toHaveLength(2);

    // Deleting the first case keeps what the later case still uses.
    await deleteCase(sb.ctx, firstCase, "buyer", async () => {});
    expect(subscriptionRepo.get(sb.ctx.db, later.subscription.id)).not.toBeNull();
    expect(evidenceRepo.get(sb.ctx.db, doc.id)).not.toBeNull();
    expect(requireBundle(sb.ctx, later.caseRecord.id).caseRecord.classification).toBe(
      "CANDIDATE_AFTER_CANCEL",
    );
  });

  it("a delayed-start intent fixes one start time per subscription attempt and sends exactly that", async () => {
    sb = createSandboxHarness();
    // The ordinary first setup never sends a start time, and its preview has no delay key.
    const first = await runSubscriptionSetup(sb.ctx);
    expect(first.stoppedAt).toBeNull();
    expect(sb.provider.seen.startTimes).toEqual([null]);
    expect("startDelayMinutes" in first.manifest.preview.subscription).toBe(false);
    expect(first.manifest.requestedStartTime).toBeUndefined();

    const delayed = defaultPreview(sb.ctx.config.appOrigin, undefined, "DAY", 45);
    const intent = startNewSetupIntent(sb.ctx, delayed);
    expect(intent.preview.subscription.startDelayMinutes).toBe(45);

    // A rejected first attempt keeps its own start time on the ledger ...
    sb.provider.script.subscription = ["fail"];
    const preparedAt = sb.clock.now();
    const rejected = await runSubscriptionSetup(sb.ctx);
    expect(rejected.stoppedAt).toBe("subscription");
    expect(rejected.reason).toBe("FAILED");
    const firstAttempt = startTimeAfter(preparedAt, 45);
    expect(sb.provider.seen.startTimes.at(-1)).toBe(firstAttempt);

    // ... and the retry, twenty minutes later, is a new attempt with a later one.
    sb.clock.advanceMinutes(20);
    const retried = await runSubscriptionSetup(sb.ctx);
    expect(retried.stoppedAt).toBeNull();
    const secondAttempt = startTimeAfter(sb.clock.now(), 45);
    expect(secondAttempt).not.toBe(firstAttempt);
    expect(sb.provider.seen.startTimes.at(-1)).toBe(secondAttempt);
    expect(retried.manifest.requestedStartTime).toBe(secondAttempt);
    // The ledger alone rebuilds it, and the approved payload is what was sent.
    fs.rmSync(manifestPath(sb.ctx));
    expect(loadSetupState(sb.ctx)!.requestedStartTime).toBe(secondAttempt);
    const stageOps = operations
      .listForCase(sb.ctx.db, SETUP_CASE_SENTINEL)
      .filter((op) => op.action === "sandbox_setup_subscription")
      .map((op) => (op.payload as { startTime?: string }).startTime);
    expect(stageOps).toHaveLength(3);
    expect(new Set(stageOps)).toEqual(new Set([undefined, firstAttempt, secondAttempt]));
  });

  it("validates the start delay and refuses a start time that is no longer ahead", async () => {
    expect(parseStartDelayMinutes("45")).toBe(45);
    for (const bad of ["4", "0", "-5", "1.5", "abc", "", "43201"])
      expect(await errorCode(() => parseStartDelayMinutes(bad))).toBe("INVALID_START_DELAY");
    const now = new Date("2026-11-09T10:00:00.250Z");
    expect(startTimeAfter(now, 30)).toBe("2026-11-09T10:30:00Z");
    expect(startTimeSendable("2026-11-09T10:01:00Z", new Date("2026-11-09T10:00:00Z"))).toBe(true);
    expect(startTimeSendable("2026-11-09T10:00:59Z", new Date("2026-11-09T10:00:00Z"))).toBe(false);
    expect(startTimeSendable("2026-11-09T09:59:00Z", new Date("2026-11-09T10:00:00Z"))).toBe(false);
    expect(startTimeSendable("not a time", new Date("2026-11-09T10:00:00Z"))).toBe(false);
  });

  it("a cancellation recorded before the first payment makes that payment a candidate", async () => {
    sb = createSandboxHarness();
    await runSubscriptionSetup(sb.ctx);
    startNewSetupIntent(sb.ctx, defaultPreview(sb.ctx.config.appOrigin, undefined, "DAY", 45));
    const created = await runSubscriptionSetup(sb.ctx);
    expect(created.stoppedAt).toBeNull();

    // Approved, nothing billed yet: the case exists without a payment.
    sb.provider.subscriptionStatus = "ACTIVE";
    const before = await resumeSubscriptionSetup(sb.ctx, PARTIES);
    const caseId = before.caseId!;
    expect(before.transactions).toHaveLength(0);
    const placeholder = requireBundle(sb.ctx, caseId);
    expect(placeholder.charge.providerRefs).toEqual([]);
    expect(placeholder.charge.eventTime).toBeNull();
    expect(placeholder.caseRecord.classification).not.toBe("CANDIDATE_AFTER_CANCEL");

    // The merchant confirms the cancellation before the start time.
    const doc = addCaseEvidence(sb.ctx, "buyer", {
      caseId,
      visibility: "shared",
      provenance: "user_attestation",
      kind: "cancellation_confirmation",
      label: "Cancellation confirmation (synthetic)",
      filename: "cancellation.txt",
      declaredMime: "text/plain",
      bytes: new TextEncoder().encode(
        "Your subscription is cancelled effective 2026-11-01 08:00 UTC.",
      ),
      capturedAt: "2026-11-01T08:00:00Z",
      eventTime: "2026-11-01T08:00:00Z",
      facts: [],
    });
    recordCancellation(sb.ctx, {
      caseId,
      role: "buyer",
      event: {
        type: "RECORD_CONFIRMATION",
        receivedAt: "2026-11-01T08:00:00Z",
        effectiveAt: "2026-11-01T08:00:00Z",
        basis: "merchant_confirmation_document",
        evidenceIds: [doc.id],
      },
    });
    // Still no payment, so still nothing to claim.
    expect(requireBundle(sb.ctx, caseId).caseRecord.classification).not.toBe(
      "CANDIDATE_AFTER_CANCEL",
    );

    // PayPal bills at the start time anyway: the same case takes that payment's facts.
    sb.provider.transactions = [PAID];
    const after = await resumeSubscriptionSetup(sb.ctx, PARTIES);
    expect(after.caseId).toBe(caseId);
    expect(after.laterPaymentCaseIds).toHaveLength(0);
    const charged = requireBundle(sb.ctx, caseId);
    expect(charged.charge.providerRefs).toEqual([
      { kind: "subscription_sale_id", value: "SALE-SYN-0001", provenance: "sandbox_api" },
    ]);
    expect(charged.charge.eventTime).toBe(PAID.time);
    expect(charged.caseRecord.classification).toBe("CANDIDATE_AFTER_CANCEL");
    expect(cases.list(sb.ctx.db)).toHaveLength(1);
  });

  it("a case known only from the last-payment time adopts that payment, not a later cycle's", async () => {
    sb = createSandboxHarness();
    await runSubscriptionSetup(sb.ctx);
    sb.provider.subscriptionStatus = "ACTIVE";
    // The subscription's last-payment time can differ from the transaction time by seconds.
    sb.provider.lastPayment = {
      time: "2026-11-01T10:00:07Z",
      amountValue: "19.99",
      amountCurrency: "USD",
    };
    const created = await resumeSubscriptionSetup(sb.ctx, PARTIES);
    const first = requireBundle(sb.ctx, created.caseId!);
    expect(first.charge.providerRefs).toEqual([]);
    expect(first.charge.eventTime).toBe("2026-11-01T10:00:07Z");

    // The next read already lists the next cycle's payment as well.
    sb.provider.transactions = [LATER, PAID];
    const read = await resumeSubscriptionSetup(sb.ctx, PARTIES);
    const adopted = requireBundle(sb.ctx, created.caseId!).charge;
    expect(adopted.providerRefs[0]!.value).toBe("SALE-SYN-0001");
    expect(adopted.eventTime).toBe(PAID.time);
    expect(read.laterPaymentCaseIds).toHaveLength(1);
    expect(requireBundle(sb.ctx, read.laterPaymentCaseIds[0]!).charge.providerRefs[0]!.value).toBe(
      "SALE-SYN-0002",
    );
  });
});
