import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/context";
import { decideApproval, requireBundle, transferChannel } from "@/server/services/case-service";
import { operations } from "@/server/db/repos";
import {
  getCaseThread,
  listThreadCheckpoints,
  replayFromCheckpoint,
  resumeCaseThread,
  startCaseThread,
} from "@/graph/case-graph";
import {
  assertAllowlist,
  createReadOnlyToolkit,
  EXPECTED_READ_TOOL_NAMES,
  FORBIDDEN_TOOL_NAMES,
  ToolkitAllowlistError,
} from "@/paypal/toolkit";
import { AppError } from "@/server/services/errors";
import type { Drafter } from "@/llm/drafter";

let h: TestHarness;
beforeEach(() => {
  h = createTestHarness();
});
afterEach(() => h.cleanup());

describe("LangGraph thread with durable interrupt (CC14, CC15)", () => {
  it("pauses at review, resumes once, and a replayed checkpoint repeats no external write", async () => {
    let readbacks = 0;
    const read = h.ctx.adapter.getDispute.bind(h.ctx.adapter);
    h.ctx.adapter.getDispute = async (...args) => {
      readbacks += 1;
      return read(...args);
    };
    transferChannel(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      channel: "paypal",
      reason: "escalate after no merchant response (fixture scenario)",
    });
    const started = await startCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
    });
    expect(started.interrupted).toBe(true);
    expect(started.interruptPayload?.draftId).toBeTruthy();
    expect(started.interruptPayload?.draftValid).toBe(true);
    expect(started.next).toEqual(["review"]);

    // Starting again does not create a second draft or restart the thread.
    const again = await startCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
    });
    expect(again.interruptPayload?.draftId).toBe(started.interruptPayload?.draftId);

    const approval = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      draftId: started.interruptPayload!.draftId!,
      decision: "approved",
    });
    const resumed = await resumeCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      decision: { kind: "approve", approvalId: approval.id },
    });
    expect(resumed.interrupted).toBe(false);
    expect(resumed.state.operationStatus).toBe("SUCCEEDED");
    expect(resumed.state.providerStatus).toBe("WAITING_FOR_SELLER_RESPONSE");
    expect(readbacks).toBe(1);
    expect(operations.listForCase(h.ctx.db, h.caseId)).toHaveLength(1);

    // A second resume (double click / second tab) is refused: no pending interrupt.
    await expect(
      resumeCaseThread(h.ctx, {
        caseId: h.caseId,
        role: "buyer",
        action: "buyer_create_dispute",
        decision: { kind: "approve", approvalId: approval.id },
      }),
    ).rejects.toThrow(AppError);
    expect(operations.listForCase(h.ctx.db, h.caseId)).toHaveLength(1);

    // Time travel: replay from the checkpoint right before execution. The ledger makes it a no-op.
    const history = await listThreadCheckpoints(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
    });
    const beforeExecute = history.find((c) => c.next.includes("execute"));
    expect(beforeExecute?.checkpointId).toBeTruthy();
    const replayed = await replayFromCheckpoint(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      checkpointId: beforeExecute!.checkpointId!,
    });
    expect(replayed.state.operationStatus).toBe("SUCCEEDED");
    expect(readbacks).toBe(1);
    const ops = operations.listForCase(h.ctx.db, h.caseId);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.attempts).toBe(1);
    const state = await getCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
    });
    expect(state.interrupted).toBe(false);
    expect(requireBundle(h.ctx, h.caseId).caseRecord.claimActive).toBe(true);
  });

  it("rejecting at review ends the thread without an operation", async () => {
    const started = await startCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    expect(started.interrupted).toBe(true);
    decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: started.interruptPayload!.draftId!,
      decision: "rejected",
      reason: "needs edits",
    });
    const resumed = await resumeCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      decision: { kind: "reject", reason: "needs edits" },
    });
    expect(resumed.interrupted).toBe(false);
    expect(resumed.state.operationId).toBeNull();
    expect(operations.listForCase(h.ctx.db, h.caseId)).toHaveLength(0);
    expect(requireBundle(h.ctx, h.caseId).caseRecord.buyerState).toBe("REJECTED");
  });
});

describe("toolkit allowlist (CC19)", () => {
  it("exposes exactly the read tools and none of the forbidden mutations", () => {
    const handle = createReadOnlyToolkit({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    });
    expect(handle.toolNames).toEqual([...EXPECTED_READ_TOOL_NAMES].sort());
    for (const forbidden of FORBIDDEN_TOOL_NAMES) expect(handle.toolNames).not.toContain(forbidden);
    expect(() => assertAllowlist([...EXPECTED_READ_TOOL_NAMES, "accept_dispute_claim"])).toThrow(
      ToolkitAllowlistError,
    );
    expect(() => assertAllowlist(["list_disputes"])).toThrow(ToolkitAllowlistError);
  });
});

describe("drafting failures (CC11)", () => {
  it("falls back to a labelled template after a failing live drafter and never reports a live run", async () => {
    const failing: Drafter = {
      kind: "live_model",
      label: "failing",
      async draft() {
        return {
          ok: false,
          code: "MALFORMED_OUTPUT",
          message: "garbage after one repair",
          calls: 2,
        };
      },
    };
    const local = createTestHarness({ drafter: failing });
    try {
      const { generateDraft } = await import("@/server/services/case-service");
      const draft = await generateDraft(local.ctx, {
        caseId: local.caseId,
        role: "buyer",
        action: "export_refund_request",
      });
      expect(draft.origin).toBe("fixture_template");
      expect(draft.providerLabel).toBe("Template — no model call");
      expect(draft.modelLabel).toBeNull();
      expect(
        draft.validation.issues.some(
          (i) => i.code === "NOTE" && /MALFORMED_OUTPUT/.test(i.message),
        ),
      ).toBe(true);
      expect(draft.validation.ok).toBe(true);
    } finally {
      local.cleanup();
    }
  });
});

describe("durable interrupt across a process restart (CC15)", () => {
  it("resumes a review that was interrupted before the process stopped", async () => {
    const first = createTestHarness({ onDisk: true });
    const dataDir = first.ctx.config.dataDir;
    try {
      const started = await startCaseThread(first.ctx, {
        caseId: first.caseId,
        role: "buyer",
        action: "export_refund_request",
      });
      expect(started.interrupted).toBe(true);
      const draftId = started.interruptPayload!.draftId!;
      const approval = decideApproval(first.ctx, {
        caseId: first.caseId,
        role: "buyer",
        action: "export_refund_request",
        draftId,
        decision: "approved",
      });
      // "Process stops": close the database handles without resuming.
      first.ctx.db.close();

      // "Process starts again" on the same data directory.
      const { createAppContext } = await import("@/server/context");
      const { loadAppConfig } = await import("@/server/config");
      const { FixtureAdapter } = await import("@/paypal/fixture-adapter");
      const path = await import("node:path");
      const config = loadAppConfig({
        APP_MODE: "fixture",
        DATA_DIR: dataDir,
        APP_ORIGIN: "http://127.0.0.1:3999",
      } as unknown as NodeJS.ProcessEnv);
      const second = createAppContext({
        config,
        clock: first.clock,
        adapter: new FixtureAdapter(path.join(dataDir, "provider-simulation.json"), first.clock),
      });
      try {
        const pending = await getCaseThread(second, {
          caseId: first.caseId,
          role: "buyer",
          action: "export_refund_request",
        });
        expect(pending.interrupted).toBe(true);
        expect(pending.interruptPayload?.draftId).toBe(draftId);
        const resumed = await resumeCaseThread(second, {
          caseId: first.caseId,
          role: "buyer",
          action: "export_refund_request",
          decision: { kind: "approve", approvalId: approval.id },
        });
        expect(resumed.state.operationStatus).toBe("SUCCEEDED");
        expect(operations.listForCase(second.db, first.caseId)).toHaveLength(1);
      } finally {
        second.db.close();
      }
    } finally {
      first.cleanup();
    }
  });
});
