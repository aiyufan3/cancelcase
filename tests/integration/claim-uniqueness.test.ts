import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createTestHarness, type TestHarness } from "../helpers/context";
import {
  decideApproval,
  generateDraft,
  requireBundle,
  transferChannel,
} from "@/server/services/case-service";
import {
  dispatchOperation,
  prepareOperation,
  readBackForRecovery,
  refreshProviderObservation,
  resolveUnknownOperation,
  sweepExpiredLeases,
} from "@/server/services/operation-service";
import { approvals, claims, operations } from "@/server/db/repos";
import { createAppContext } from "@/server/context";
import { openDatabase } from "@/server/db/connection";
import { SCHEMA_VERSION } from "@/server/db/schema";
import { AppError } from "@/server/services/errors";
import type { AppContext } from "@/server/context";
import type { WriteOutcome } from "@/paypal/adapter";

/**
 * One active or unresolved financial claim per charge (CC07, CC14, CC16 and the independent
 * audit's AUD01/AUD02). Every test counts actual adapter create calls: the invariant is that a
 * charge never receives a second external claim, whichever boundary rejects the attempt.
 */

let h: TestHarness;
afterEach(() => h?.cleanup());

function countCreates(ctx: AppContext): { calls: number } {
  const counter = { calls: 0 };
  const original = ctx.adapter.createBuyerDispute.bind(ctx.adapter);
  ctx.adapter.createBuyerDispute = async (payload, writeCtx) => {
    counter.calls += 1;
    return original(payload, writeCtx);
  };
  return counter;
}

function escalate(ctx: AppContext, caseId: string) {
  transferChannel(ctx, {
    caseId,
    role: "buyer",
    channel: "paypal",
    reason: "merchant did not respond (fixture scenario)",
  });
}

async function approveDispute(ctx: AppContext, caseId: string) {
  const draft = await generateDraft(ctx, { caseId, role: "buyer", action: "buyer_create_dispute" });
  return decideApproval(ctx, {
    caseId,
    role: "buyer",
    action: "buyer_create_dispute",
    draftId: draft.id,
    decision: "approved",
  });
}

async function submit(
  ctx: AppContext,
  caseId: string,
  approvalId: string,
  simulate: "timeout" | "unsupported" | null = null,
) {
  const { operation } = prepareOperation(ctx, {
    caseId,
    role: "buyer",
    action: "buyer_create_dispute",
    approvalId,
    simulate,
  });
  return dispatchOperation(ctx, operation.id);
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : String(err);
  }
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : String(err);
  }
}

describe("one claim per charge", () => {
  it("AUD01: an open provider case blocks a second buyer claim for the same charge, before any write", async () => {
    h = createTestHarness();
    const creates = countCreates(h.ctx);
    escalate(h.ctx, h.caseId);
    const first = await submit(h.ctx, h.caseId, (await approveDispute(h.ctx, h.caseId)).id);
    expect(first.status).toBe("SUCCEEDED");
    expect(claims.get(h.ctx.db, requireBundle(h.ctx, h.caseId).charge.id)?.state).toBe("OPEN");

    // Regenerate and re-approve: rejected at the approval boundary (earlier than dispatch).
    const code = await asyncCodeOf(() => approveDispute(h.ctx, h.caseId));
    expect(code).toBe("CLAIM_ALREADY_ACTIVE");
    expect(creates.calls).toBe(1);
  });

  it("a forged second approval is still stopped by the reservation inside the prepare transaction", async () => {
    h = createTestHarness();
    const creates = countCreates(h.ctx);
    escalate(h.ctx, h.caseId);
    const a1 = await approveDispute(h.ctx, h.caseId);
    expect((await submit(h.ctx, h.caseId, a1.id)).status).toBe("SUCCEEDED");
    // Generating a new claim draft is already refused while the case is open.
    expect(
      await asyncCodeOf(() =>
        generateDraft(h.ctx, { caseId: h.caseId, role: "buyer", action: "buyer_create_dispute" }),
      ),
    ).toBe("CLAIM_ALREADY_ACTIVE");
    // Forge an approval that bypasses every earlier check (e.g. a stale second tab).
    const bundle = requireBundle(h.ctx, h.caseId);
    const forged = { ...a1, id: `${a1.id}-forged`, consumedByOperationId: null };
    approvals.insert(h.ctx.db, forged);
    expect(
      codeOf(() =>
        prepareOperation(h.ctx, {
          caseId: h.caseId,
          role: "buyer",
          action: "buyer_create_dispute",
          approvalId: forged.id,
        }),
      ),
    ).not.toBeNull();
    expect(operations.listForCase(h.ctx.db, h.caseId)).toHaveLength(1);
    expect(claims.get(h.ctx.db, bundle.charge.id)?.state).toBe("OPEN");
    expect(creates.calls).toBe(1);
  });

  it("two processes on the same database cannot both reserve the claim (concurrent attempts)", async () => {
    h = createTestHarness({ onDisk: true });
    escalate(h.ctx, h.caseId);
    const a1 = await approveDispute(h.ctx, h.caseId);
    // A second process opens the same database file (sharing the simulated provider).
    const creates = countCreates(h.ctx);
    const other = createAppContext({ config: h.ctx.config, clock: h.clock, adapter: h.adapter });
    try {
      // Both "processes" pass their pre-checks before either one reserves.
      const a2 = {
        ...a1,
        id: `${a1.id}-other-tab`,
        consumedByOperationId: null,
        revokedReason: null,
      };
      approvals.insert(other.db, a2);
      const prepared = prepareOperation(h.ctx, {
        caseId: h.caseId,
        role: "buyer",
        action: "buyer_create_dispute",
        approvalId: a1.id,
      });
      const secondCode = codeOf(() =>
        prepareOperation(other, {
          caseId: h.caseId,
          role: "buyer",
          action: "buyer_create_dispute",
          approvalId: a2.id,
        }),
      );
      expect(secondCode).toBe("CLAIM_ALREADY_ACTIVE");
      // The repository-level constraint itself refuses a second row for the charge.
      const charge = requireBundle(other, h.caseId).charge.id;
      expect(
        claims.reserve(other.db, {
          chargeId: charge,
          environment: "fixture",
          caseId: h.caseId,
          channel: "paypal",
          state: "RESERVED",
          operationId: "op-raced",
          providerRef: null,
          openedAt: h.clock.now().toISOString(),
          updatedAt: h.clock.now().toISOString(),
        }),
      ).toBe(false);
      const [d1, d2] = await Promise.all([
        dispatchOperation(h.ctx, prepared.operation.id),
        dispatchOperation(other, prepared.operation.id),
      ]);
      expect([d1.status, d2.status]).toContain("SUCCEEDED");
      expect(creates.calls).toBe(1);
    } finally {
      other.db.close();
    }
  });

  it("AUD02: an UNKNOWN submission blocks every channel change, and the reservation survives a restart", async () => {
    h = createTestHarness({ onDisk: true });
    const creates = countCreates(h.ctx);
    escalate(h.ctx, h.caseId);
    const unknown = await submit(
      h.ctx,
      h.caseId,
      (await approveDispute(h.ctx, h.caseId)).id,
      "timeout",
    );
    expect(unknown.status).toBe("UNKNOWN");
    for (const channel of ["chargeback", "paypal", "merchant_refund"] as const) {
      expect(
        codeOf(() =>
          transferChannel(h.ctx, {
            caseId: h.caseId,
            role: "buyer",
            channel,
            reason: "another channel",
          }),
        ),
      ).toBe("IN_FLIGHT");
    }
    // Restart: a fresh process on the same files still sees the unresolved reservation.
    h.ctx.db.close();
    const restarted = createAppContext({
      config: h.ctx.config,
      clock: h.clock,
      adapter: h.adapter,
    });
    try {
      sweepExpiredLeases(restarted);
      const charge = requireBundle(restarted, h.caseId).charge.id;
      expect(claims.get(restarted.db, charge)?.state).toBe("RESERVED");
      expect(
        codeOf(() =>
          transferChannel(restarted, {
            caseId: h.caseId,
            role: "buyer",
            channel: "chargeback",
            reason: "after restart",
          }),
        ),
      ).toBe("IN_FLIGHT");
      expect(creates.calls).toBe(1);
    } finally {
      restarted.db.close();
      h.ctx.db = new Database(":memory:"); // let cleanup close something harmless
    }
  });

  it("keeps the claim when the provider created the case but an incomplete list misses it", async () => {
    h = createTestHarness();
    escalate(h.ctx, h.caseId);
    const creates = countCreates(h.ctx);
    // The provider applied the request; only the response was lost.
    const op = await submit(h.ctx, h.caseId, (await approveDispute(h.ctx, h.caseId)).id, "timeout");
    expect(op.status).toBe("UNKNOWN");
    const chargeId = requireBundle(h.ctx, h.caseId).charge.id;
    const providerCases = async () => {
      const all = await original({ pageSize: 50 });
      return all.ok ? all.data.items.length : -1;
    };
    const original = h.ctx.adapter.listDisputes.bind(h.ctx.adapter);
    expect(await providerCases()).toBe(1);
    // The read-back sees a first page without the new case: 0 of 100.
    h.ctx.adapter.listDisputes = async () => ({
      ok: true,
      data: { items: [], total: 100, complete: false },
      provenance: "synthetic",
      observedAt: h.clock.now().toISOString(),
      correlationId: null,
    });
    const readback = await readBackForRecovery(h.ctx, op.id);
    expect(readback.candidateDisputeId).toBeNull();
    expect(readback.findings.join(" ")).toContain("could read only 0 of 100");
    expect(readback.findings.join(" ")).toContain("does not show the request was not applied");
    expect(
      await asyncCodeOf(() =>
        resolveUnknownOperation(h.ctx, {
          operationId: op.id,
          decision: "confirmed_failed",
          note: "Read-back found no case.",
        }),
      ),
    ).toBe("RECOVERY_EVIDENCE_REQUIRED");
    // Nothing was released: the operation is still unknown and still holds the charge.
    expect(operations.get(h.ctx.db, op.id)!.status).toBe("UNKNOWN");
    expect(claims.get(h.ctx.db, chargeId)?.operationId).toBe(op.id);
    // A new review and approval cannot reach the provider for the same charge.
    const again = await asyncCodeOf(async () =>
      submit(h.ctx, h.caseId, (await approveDispute(h.ctx, h.caseId)).id),
    );
    expect(again).not.toBeNull();
    expect(creates.calls).toBe(1);
    expect(await providerCases()).toBe(1);
  });

  it.each([
    ["a complete empty list", "empty"],
    ["a failed read", "failed"],
    ["no read-back at all", "none"],
  ] as const)(
    "does not record a case creation as failed after %s, and sends nothing again",
    async (_label, mode) => {
      h = createTestHarness();
      escalate(h.ctx, h.caseId);
      const creates = { calls: 0 };
      // The response is lost; whether the provider applied the request is not known.
      h.ctx.adapter.createBuyerDispute = async () => {
        creates.calls += 1;
        const outcome: WriteOutcome<{ disputeId: string; status: string | null }> = {
          kind: "unknown",
          error: {
            code: "NETWORK_TIMEOUT",
            message: "No response.",
            correlationId: null,
            httpStatus: null,
          },
        };
        return outcome;
      };
      const op = await submit(h.ctx, h.caseId, (await approveDispute(h.ctx, h.caseId)).id);
      expect(op.status).toBe("UNKNOWN");
      const chargeId = requireBundle(h.ctx, h.caseId).charge.id;
      if (mode === "failed")
        h.ctx.adapter.listDisputes = async () => ({
          ok: false,
          error: {
            code: "NETWORK_TIMEOUT",
            message: "No response.",
            correlationId: null,
            httpStatus: null,
          },
          retriable: true,
        });
      if (mode !== "none") {
        const readback = await readBackForRecovery(h.ctx, op.id);
        expect(readback.candidateDisputeId).toBeNull();
        if (mode === "empty")
          expect(readback.findings.join(" ")).toContain("a new case can take time to appear");
      }
      expect(
        await asyncCodeOf(() =>
          resolveUnknownOperation(h.ctx, {
            operationId: op.id,
            decision: "confirmed_failed",
            note: "I think it failed",
          }),
        ),
      ).toBe("RECOVERY_EVIDENCE_REQUIRED");
      expect(operations.get(h.ctx.db, op.id)!.status).toBe("UNKNOWN");
      expect(claims.get(h.ctx.db, chargeId)?.operationId).toBe(op.id);
      // Keeping it for review changes nothing but the note.
      await resolveUnknownOperation(h.ctx, {
        operationId: op.id,
        decision: "needs_manual_review",
        note: "Will check the Resolution Center tomorrow.",
      });
      expect(operations.get(h.ctx.db, op.id)!.status).toBe("UNKNOWN");
      const again = await asyncCodeOf(async () =>
        submit(h.ctx, h.caseId, (await approveDispute(h.ctx, h.caseId)).id),
      );
      expect(again).not.toBeNull();
      expect(creates.calls).toBe(1);
    },
  );

  it("refuses to record failure when the read-back found a matching case, and success needs the case ID", async () => {
    h = createTestHarness();
    escalate(h.ctx, h.caseId);
    const op = await submit(h.ctx, h.caseId, (await approveDispute(h.ctx, h.caseId)).id, "timeout");
    const readback = await readBackForRecovery(h.ctx, op.id);
    expect(readback.candidateDisputeId).toMatch(/^FX-DISPUTE-/);
    expect(
      await asyncCodeOf(() =>
        resolveUnknownOperation(h.ctx, {
          operationId: op.id,
          decision: "confirmed_failed",
          note: "want to retry",
        }),
      ),
    ).toBe("RECOVERY_EVIDENCE_REQUIRED");
    expect(
      await asyncCodeOf(() =>
        resolveUnknownOperation(h.ctx, {
          operationId: op.id,
          decision: "confirmed_succeeded",
          note: "seen in provider view",
        }),
      ),
    ).toBe("DISPUTE_ID_REQUIRED");
    await resolveUnknownOperation(h.ctx, {
      operationId: op.id,
      decision: "confirmed_succeeded",
      note: "seen in provider view",
      disputeId: readback.candidateDisputeId,
    });
    const charge = requireBundle(h.ctx, h.caseId).charge.id;
    expect(claims.get(h.ctx.db, charge)).toMatchObject({
      state: "OPEN",
      providerRef: readback.candidateDisputeId,
    });
  });

  it("a provider-reported resolution releases the open claim; a local transfer never does", async () => {
    h = createTestHarness();
    escalate(h.ctx, h.caseId);
    const op = await submit(h.ctx, h.caseId, (await approveDispute(h.ctx, h.caseId)).id);
    const disputeId = (op.result as { disputeId: string }).disputeId;
    expect(
      codeOf(() =>
        transferChannel(h.ctx, {
          caseId: h.caseId,
          role: "buyer",
          channel: "paypal",
          reason: "same channel again",
        }),
      ),
    ).toBe("PROVIDER_CLAIM_OPEN");
    const read = h.ctx.adapter.getDispute.bind(h.ctx.adapter);
    h.ctx.adapter.getDispute = async (id) => {
      const r = await read(id);
      if (!r.ok) return r;
      return {
        ...r,
        data: {
          ...r.data,
          observation: { ...r.data.observation, status: "RESOLVED", allowedActions: [] },
        },
      };
    };
    h.clock.advanceMinutes(1);
    await refreshProviderObservation(h.ctx, h.caseId, disputeId);
    const bundle = requireBundle(h.ctx, h.caseId);
    expect(claims.get(h.ctx.db, bundle.charge.id)).toBeNull();
    expect(bundle.caseRecord.claimActive).toBe(false);
    expect(bundle.caseRecord.claimClosedReason).toMatch(/RESOLVED/);
    expect(() =>
      transferChannel(h.ctx, {
        caseId: h.caseId,
        role: "buyer",
        channel: "chargeback",
        reason: "provider case closed",
      }),
    ).not.toThrow();
  });

  it("a prepared operation that was never dispatched frees the claim once its approval expires", async () => {
    h = createTestHarness();
    escalate(h.ctx, h.caseId);
    const approval = await approveDispute(h.ctx, h.caseId);
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      approvalId: approval.id,
    });
    const charge = requireBundle(h.ctx, h.caseId).charge.id;
    expect(claims.get(h.ctx.db, charge)?.state).toBe("RESERVED");
    expect(sweepExpiredLeases(h.ctx)).toHaveLength(0);
    h.clock.advanceMinutes(16);
    const swept = sweepExpiredLeases(h.ctx);
    expect(swept.map((o) => [o.id, o.status, o.errorCode])).toEqual([
      [operation.id, "FAILED", "NEVER_DISPATCHED"],
    ]);
    expect(claims.get(h.ctx.db, charge)).toBeNull();
    // Dispatching the swept operation later never sends anything.
    expect((await dispatchOperation(h.ctx, operation.id)).status).toBe("FAILED");
  });

  it("a definitive provider rejection frees the reservation; nothing remains open", async () => {
    h = createTestHarness();
    escalate(h.ctx, h.caseId);
    h.ctx.adapter.createBuyerDispute = async () => ({
      kind: "failed",
      error: {
        code: "UNPROCESSABLE_ENTITY",
        message: "Rejected.",
        correlationId: null,
        httpStatus: 422,
      },
    });
    const op = await submit(h.ctx, h.caseId, (await approveDispute(h.ctx, h.caseId)).id);
    expect(op.status).toBe("FAILED");
    expect(claims.get(h.ctx.db, requireBundle(h.ctx, h.caseId).charge.id)).toBeNull();
  });
});

describe("schema migration v1 → v2", () => {
  it("backfills reservations for open claims and unsettled claim operations", () => {
    h = createTestHarness({ onDisk: true });
    const charge = requireBundle(h.ctx, h.caseId).charge.id;
    h.ctx.db.prepare("UPDATE dispute_cases SET claim_active = 1 WHERE id = ?").run(h.caseId);
    h.ctx.db.prepare("DROP TABLE claim_reservations").run();
    h.ctx.db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
    h.ctx.db.close();
    const opened = openDatabase(h.ctx.config.envDir, "fixture");
    try {
      const version = opened.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string };
      expect(Number(version.value)).toBe(SCHEMA_VERSION);
      expect(claims.get(opened.db, charge)?.state).toBe("OPEN");
      expect(fs.existsSync(path.join(h.ctx.config.envDir, "cancelcase.sqlite"))).toBe(true);
    } finally {
      opened.db.close();
      h.ctx.db = new Database(":memory:");
    }
  });
});
