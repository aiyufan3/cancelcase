import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/context";
import { createSandboxHarness, type SandboxHarness } from "../helpers/sandbox-provider";
import { requireBundle } from "@/server/services/case-service";
import {
  SETUP_CASE_SENTINEL,
  importDispute,
  requestAdjudicationSimulation,
  resumeSubscriptionSetup,
  runSubscriptionSetup,
} from "@/server/services/setup-service";
import { buildCaseView } from "@/server/services/case-view";
import { audit, cases, operations } from "@/server/db/repos";
import { readBackForRecovery, resolveUnknownOperation } from "@/server/services/operation-service";
import { AppError } from "@/server/services/errors";
import type { AppContext } from "@/server/context";

/**
 * The Sandbox settlement simulation (POST …/adjudicate): PayPal's own test control that stands in
 * for its decision on a case under review. It is a labelled test mutation with the same rules as
 * the evidence-request simulation. Everything runs against a scripted test double or the fixture
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
const TX = {
  sellerTransactionId: "SELLERSYN00000001",
  buyerTransactionId: "BUYERSYN000000001",
  createTime: "2026-10-28T07:15:00Z",
  status: "COMPLETED",
  grossValue: "19.99",
  grossCurrency: "USD",
};
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

const settlementOps = (ctx: AppContext) =>
  operations
    .listForCase(ctx.db, SETUP_CASE_SENTINEL)
    .filter((op) => op.action === "sandbox_adjudicate");

async function underReview(h: SandboxHarness, offered: boolean) {
  h.provider.disputes["PP-D-SYN-REVIEW"] = {
    status: "UNDER_REVIEW",
    transaction: TX,
    allowedActions: offered ? ["accept_claim", "adjudicate"] : ["accept_claim"],
  };
  return (await importDispute(h.ctx, "PP-D-SYN-REVIEW", PARTIES)).caseId;
}

describe("Sandbox test mutation — the provider's settlement simulation", () => {
  it("is sent once with the chosen outcome, only when a fresh read offers it, and the case is read back", async () => {
    sb = createSandboxHarness();
    const caseId = await underReview(sb, true);
    // A real request takes time: the read-back is later than the read before it.
    sb.provider.adjudication.afterSuccess = () => sb!.clock.advanceMinutes(1);
    const sim = await requestAdjudicationSimulation(sb.ctx, caseId, "BUYER_FAVOR");
    expect(sim.operation.status).toBe("SUCCEEDED");
    expect(sim.statusBefore).toBe("UNDER_REVIEW");
    expect(sim.statusAfter).toBe("RESOLVED");
    expect(sim.outcomeAfter).toBe("RESOLVED_BUYER_FAVOUR");
    expect(sim.allowedAfter).toEqual([]);
    expect(sb.provider.adjudication.calls).toBe(1);
    expect(sb.provider.adjudication.outcomes).toEqual(["BUYER_FAVOR"]);

    // The case shows what PayPal reports, read back, in both roles.
    const after = requireBundle(sb.ctx, caseId).caseRecord;
    expect(after.providerObservation!.status).toBe("RESOLVED");
    expect(after.providerObservation!.outcome).toBe("RESOLVED_BUYER_FAVOUR");
    for (const role of ["buyer", "merchant"] as const)
      expect(buildCaseView(sb.ctx, caseId, role).provider?.status).toBe("RESOLVED");

    // It is a recorded test mutation with its own approval, not a case action.
    const ops = settlementOps(sb.ctx);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.approvalId).toBeTruthy();
    expect(ops[0]!.payload).toMatchObject({ caseId, outcome: "BUYER_FAVOR", attempt: 1 });
    expect(operations.listForCase(sb.ctx.db, caseId)).toHaveLength(0);

    // A resolved case is not offered the simulation again: nothing more is sent.
    expect(
      await errorCode(() => requestAdjudicationSimulation(sb!.ctx, caseId, "SELLER_FAVOR")),
    ).toBe("SIMULATION_NOT_OFFERED");
    expect(sb.provider.adjudication.calls).toBe(1);
  });

  it("records the seller's outcome as read back, without judging it", async () => {
    sb = createSandboxHarness();
    const caseId = await underReview(sb, true);
    sb.provider.adjudication.afterSuccess = () => sb!.clock.advanceMinutes(1);
    const sim = await requestAdjudicationSimulation(sb.ctx, caseId, "SELLER_FAVOR");
    expect(sim.operation.status).toBe("SUCCEEDED");
    expect(sim.outcomeAfter).toBe("RESOLVED_SELLER_FAVOUR");
    expect(sb.provider.adjudication.outcomes).toEqual(["SELLER_FAVOR"]);
  });

  it("sends nothing for an undocumented outcome, without the capability, after a failed read, without a provider case, or in fixture mode", async () => {
    sb = createSandboxHarness();
    const caseId = await underReview(sb, false);
    expect(
      await errorCode(() => requestAdjudicationSimulation(sb!.ctx, caseId, "BOTH" as never)),
    ).toBe("INVALID_OUTCOME");
    expect(
      await errorCode(() => requestAdjudicationSimulation(sb!.ctx, caseId, "BUYER_FAVOR")),
    ).toBe("SIMULATION_NOT_OFFERED");
    sb.provider.disputes["PP-D-SYN-REVIEW"]!.allowedActions = ["adjudicate"];
    sb.provider.disputeReadFails = 1;
    expect(
      await errorCode(() => requestAdjudicationSimulation(sb!.ctx, caseId, "BUYER_FAVOR")),
    ).toBe("PROVIDER_READ_FAILED");

    // A connected case from the subscription setup has no provider case yet.
    sb.provider.transactions = [PAID];
    const run = await runSubscriptionSetup(sb.ctx);
    expect(run.stoppedAt).toBeNull();
    sb.provider.subscriptionStatus = "ACTIVE";
    const plain = (await resumeSubscriptionSetup(sb.ctx, PARTIES)).caseId!;
    expect(
      await errorCode(() => requestAdjudicationSimulation(sb!.ctx, plain, "BUYER_FAVOR")),
    ).toBe("NO_PROVIDER_CASE");
    expect(sb.provider.adjudication.calls).toBe(0);
    expect(settlementOps(sb.ctx)).toHaveLength(0);

    fx = createTestHarness();
    const fixtureCase = cases.list(fx.ctx.db)[0]!.id;
    expect(
      await errorCode(() => requestAdjudicationSimulation(fx!.ctx, fixtureCase, "BUYER_FAVOR")),
    ).toBe("WRONG_MODE");
  });

  it("an unknown result blocks another attempt; a rejected one allows a new attempt", async () => {
    sb = createSandboxHarness();
    const caseId = await underReview(sb, true);
    sb.provider.adjudication.script = ["fail", "unknown"];
    const rejected = await requestAdjudicationSimulation(sb.ctx, caseId, "BUYER_FAVOR");
    expect(rejected.operation.status).toBe("FAILED");
    expect(rejected.statusAfter).toBeNull();
    expect(rejected.outcomeAfter).toBeNull();

    const unknown = await requestAdjudicationSimulation(sb.ctx, caseId, "BUYER_FAVOR");
    expect(unknown.operation.status).toBe("UNKNOWN");
    expect(unknown.operation.id).not.toBe(rejected.operation.id);
    expect(sb.provider.adjudication.calls).toBe(2);

    // The request may have been applied: never sent again until someone checks.
    expect(
      await errorCode(() => requestAdjudicationSimulation(sb!.ctx, caseId, "BUYER_FAVOR")),
    ).toBe("SIMULATION_UNSETTLED");
    expect(sb.provider.adjudication.calls).toBe(2);
  });

  it("an exception after sending is an unknown result, and a failed read-back reports nothing", async () => {
    sb = createSandboxHarness();
    const caseId = await underReview(sb, true);
    sb.provider.adjudication.script = ["throw"];
    const thrown = await requestAdjudicationSimulation(sb.ctx, caseId, "BUYER_FAVOR");
    expect(thrown.operation.status).toBe("UNKNOWN");
    expect(thrown.operation.errorCode).toBe("EXCEPTION");

    sb.cleanup();
    sb = createSandboxHarness();
    const second = await underReview(sb, true);
    sb.provider.adjudication.afterSuccess = () => {
      sb!.provider.disputeReadFails = 1;
    };
    const sim = await requestAdjudicationSimulation(sb.ctx, second, "BUYER_FAVOR");
    expect(sim.operation.status).toBe("SUCCEEDED");
    // The read after the request failed: no status is reported rather than the earlier one.
    expect(sim.statusAfter).toBeNull();
    expect(sim.outcomeAfter).toBeNull();
    expect(sim.allowedAfter).toEqual([]);
  });
  it("the case recovery steps refuse a test-control or setup operation before changing anything (T04)", async () => {
    sb = createSandboxHarness();
    const caseId = await underReview(sb, true);
    sb.provider.adjudication.script = ["unknown"];
    const sim = await requestAdjudicationSimulation(sb.ctx, caseId, "BUYER_FAVOR");
    expect(sim.operation.status).toBe("UNKNOWN");
    // A setup operation with an unknown result has no case behind it at all.
    const setupOp = {
      ...sim.operation,
      id: "sb_op_setup_unknown",
      logicalKey: "setup-unknown-stand-in",
      action: "sandbox_setup_subscription" as const,
      caseId: SETUP_CASE_SENTINEL,
    };
    operations.insert(sb.ctx.db, setupOp);

    for (const id of [sim.operation.id, setupOp.id]) {
      const before = operations.get(sb.ctx.db, id)!;
      const auditBefore = audit.listForCase(sb.ctx.db, before.caseId).length;
      const callsBefore = sb.provider.adjudication.calls;

      expect(await errorCode(() => readBackForRecovery(sb!.ctx, id))).toBe(
        "RECOVERY_NOT_SUPPORTED",
      );
      for (const decision of [
        "confirmed_failed",
        "confirmed_succeeded",
        "needs_manual_review",
      ] as const) {
        const err = await resolveUnknownOperation(sb.ctx, {
          operationId: id,
          decision,
          note: "checked in the Sandbox",
          disputeId: "PP-D-12345",
        }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("RECOVERY_NOT_SUPPORTED");
        // It is described as what it is, not as a local export.
        expect((err as AppError).message).not.toMatch(/local export/i);
      }
      // Nothing was written: same status, result and timestamps, no audit entry, no request.
      expect(operations.get(sb.ctx.db, id)).toEqual(before);
      expect(audit.listForCase(sb.ctx.db, before.caseId)).toHaveLength(auditBefore);
      expect(sb.provider.adjudication.calls).toBe(callsBefore);
    }
  });
});
