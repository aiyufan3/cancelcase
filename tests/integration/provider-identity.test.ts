import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/context";
import { cases } from "@/server/db/repos";
import {
  decideApproval,
  generateDraft,
  requireBundle,
  transferChannel,
} from "@/server/services/case-service";
import {
  applyObservation,
  dispatchOperation,
  persistObservation,
  prepareOperation,
  readBackForRecovery,
  refreshProviderObservation,
  resolveUnknownOperation,
} from "@/server/services/operation-service";
import type { DisputeReadback, ReadResult } from "@/paypal/adapter";

let h: TestHarness;
afterEach(() => h?.cleanup());
const failedRead: ReadResult<DisputeReadback> = {
  ok: false,
  error: {
    code: "READ_FAILED",
    message: "Synthetic read failure.",
    correlationId: null,
    httpStatus: 500,
  },
  retriable: true,
};

async function submit(simulate: "timeout" | null = null) {
  const draft = await generateDraft(h.ctx, {
    caseId: h.caseId,
    role: "buyer",
    action: "buyer_create_dispute",
  });
  const approval = decideApproval(h.ctx, {
    caseId: h.caseId,
    role: "buyer",
    action: "buyer_create_dispute",
    draftId: draft.id,
    decision: "approved",
  });
  return dispatchOperation(
    h.ctx,
    prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      approvalId: approval.id,
      simulate,
    }).operation.id,
  );
}

async function priorResolvedCase() {
  h = createTestHarness();
  transferChannel(h.ctx, {
    caseId: h.caseId,
    role: "buyer",
    channel: "paypal",
    reason: "reviewed escalation",
  });
  expect((await submit()).status).toBe("SUCCEEDED");
  const prior = requireBundle(h.ctx, h.caseId).caseRecord.providerObservation!;
  h.clock.advanceMinutes(1);
  applyObservation(
    h.ctx,
    h.caseId,
    { ...prior, status: "RESOLVED", allowedActions: [], observedAt: h.clock.now().toISOString() },
    { correlationId: null, toolkitCrossCheck: null },
  );
  h.clock.advanceMinutes(1);
  return prior.disputeId!;
}

describe("provider resource identity across case replacement (AUD09, CC08, CC16)", () => {
  it("refuses a merchant preflight that returns a different provider resource (CC13, CC17)", async () => {
    const priorId = await priorResolvedCase();
    const rec = cases.get(h.ctx.db, h.caseId)!;
    cases.update(h.ctx.db, {
      ...rec,
      providerObservation: {
        ...rec.providerObservation!,
        status: "WAITING_FOR_SELLER_RESPONSE",
        allowedActions: ["provide_evidence"],
      },
    });
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
    });
    const approval = decideApproval(h.ctx, {
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
      approvalId: approval.id,
    });
    const read = h.ctx.adapter.getDispute.bind(h.ctx.adapter);
    h.ctx.adapter.getDispute = async (id) => {
      const result = await read(id);
      return result.ok
        ? {
            ...result,
            data: {
              ...result.data,
              observation: { ...result.data.observation, disputeId: "FX-UNEXPECTED-B" },
              summary: { ...result.data.summary, disputeId: "FX-UNEXPECTED-B" },
            },
          }
        : result;
    };
    let writes = 0;
    const write = h.ctx.adapter.provideEvidence.bind(h.ctx.adapter);
    h.ctx.adapter.provideEvidence = async (...args) => {
      writes += 1;
      return write(...args);
    };
    const result = await dispatchOperation(h.ctx, prepared.operation.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("PREFLIGHT_RESOURCE_MISMATCH");
    expect(writes).toBe(0);
    expect(cases.get(h.ctx.db, h.caseId)?.providerObservation?.disputeId).toBe(priorId);
  });

  it("keeps replacement B canonical when its first read fails after resolved A", async () => {
    const priorId = await priorResolvedCase();
    const read = h.ctx.adapter.getDispute.bind(h.ctx.adapter);
    h.ctx.adapter.getDispute = async () => failedRead;
    const done = await submit();
    expect(done.status).toBe("SUCCEEDED");
    const nextId = (done.result as { disputeId: string }).disputeId;
    expect(nextId).not.toBe(priorId);
    expect(requireBundle(h.ctx, h.caseId).caseRecord.providerObservation).toMatchObject({
      disputeId: nextId,
      observedVersion: 0,
      stale: true,
    });
    h.ctx.adapter.getDispute = read;
    expect((await refreshProviderObservation(h.ctx, h.caseId, null)).observation?.disputeId).toBe(
      nextId,
    );
  });

  it("keeps recovered B canonical when its first read fails after resolved A", async () => {
    const priorId = await priorResolvedCase();
    const unknown = await submit("timeout");
    expect(unknown.status).toBe("UNKNOWN");
    const readback = await readBackForRecovery(h.ctx, unknown.id);
    expect(readback.candidateDisputeId).toBeTruthy();
    const nextId = readback.candidateDisputeId!;
    expect(nextId).not.toBe(priorId);
    h.ctx.adapter.getDispute = async () => failedRead;
    await resolveUnknownOperation(h.ctx, {
      operationId: unknown.id,
      decision: "confirmed_succeeded",
      disputeId: nextId,
      note: "Verified the synthetic replacement case.",
    });
    expect(requireBundle(h.ctx, h.caseId).caseRecord.providerObservation).toMatchObject({
      disputeId: nextId,
      observedVersion: 0,
      stale: true,
    });
  });

  it.each(["succeeded", "failed"] as const)(
    "ignores an old A read that %s after B becomes canonical",
    async (outcome) => {
      const priorId = await priorResolvedCase();
      const oldRead = await h.ctx.adapter.getDispute(priorId);
      expect(oldRead.ok).toBe(true);
      let finishRead!: (result: ReadResult<DisputeReadback>) => void;
      h.ctx.adapter.getDispute = async () =>
        new Promise((resolve) => {
          finishRead = resolve;
        });
      const refreshing = refreshProviderObservation(h.ctx, h.caseId, priorId);
      const before = cases.get(h.ctx.db, h.caseId)!;
      const replacement = {
        ...before.providerObservation!,
        disputeId: "FX-REPLACEMENT-B",
        observedVersion: 0,
        status: "OPEN",
        stale: false,
      };
      persistObservation(h.ctx, { ...before, requestedCents: 1234 }, replacement);
      h.clock.advanceMinutes(1);
      finishRead(
        outcome === "failed"
          ? failedRead
          : oldRead.ok
            ? {
                ...oldRead,
                data: {
                  ...oldRead.data,
                  observation: {
                    ...oldRead.data.observation,
                    observedAt: h.clock.now().toISOString(),
                  },
                },
              }
            : oldRead,
      );
      const result = await refreshing;
      expect(result.observation).toEqual(replacement);
      expect(cases.get(h.ctx.db, h.caseId)).toMatchObject({
        providerObservation: replacement,
        requestedCents: 1234,
      });
    },
  );
});
