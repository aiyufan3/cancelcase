import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/context";
import { setAppContextForTests } from "@/server/context";
import { CSRF_COOKIE, CSRF_HEADER, ROLE_COOKIE, encodeRoleCookie } from "@/server/http/session";
import { POST as cancellationPost } from "@/app/api/cases/[id]/cancellation/route";
import {
  addCaseEvidence,
  generateDraft,
  recordCancellation,
  requireBundle,
  transferChannel,
} from "@/server/services/case-service";
import { buildRoleSnapshot } from "@/server/services/snapshot";
import { buildCaseView, channelAdapter } from "@/server/services/case-view";
import { refreshSubscriptionObservation } from "@/server/services/setup-service";
import { validateDraft } from "@/domain/claims";
import { LiveDrafter } from "@/llm/live-drafter";
import { evidence as evidenceRepo } from "@/server/db/repos";
import { AppError } from "@/server/services/errors";
import { readDemoHints } from "@/server/services/fixture-seed";

/**
 * Honest provenance (independent audit AUD04, AUD08 and the label findings): a manual record
 * cannot claim a provider observation, evidence references must be real records of the case
 * the buyer can see, facts must trace to an actual source, and adapter/mandate/timeline labels
 * say what really happened.
 */

let h: TestHarness;
beforeEach(() => {
  h = createTestHarness({ confirmCancellation: false });
});
afterEach(() => {
  setAppContextForTests(null);
  h.cleanup();
});

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : String(err);
  }
}

function confirm(basis: string, evidenceIds: string[]) {
  const hints = readDemoHints(h.ctx)!;
  return () =>
    recordCancellation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      event: {
        type: "RECORD_CONFIRMATION",
        receivedAt: hints.confirmation.receivedAt,
        effectiveAt: hints.confirmation.effectiveAt,
        basis: basis as "user_attestation",
        evidenceIds,
      },
    });
}

describe("AUD04 manual cancellation records", () => {
  it("cannot claim provider provenance (service and HTTP)", async () => {
    const hints = readDemoHints(h.ctx)!;
    expect(codeOf(confirm("provider_api_observation", hints.confirmation.evidenceIds))).toBe(
      "MANUAL_PROVENANCE_REJECTED",
    );
    setAppContextForTests(h.ctx);
    const res = await cancellationPost(
      new Request(`http://127.0.0.1:3999/api/cases/${h.caseId}/cancellation`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:3999",
          origin: "http://127.0.0.1:3999",
          cookie: `${ROLE_COOKIE}=${encodeURIComponent(encodeRoleCookie(h.ctx, "buyer"))}; ${CSRF_COOKIE}=t`,
          [CSRF_HEADER]: "t",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "RECORD_CONFIRMATION",
          receivedAt: hints.confirmation.receivedAt,
          effectiveAt: hints.confirmation.effectiveAt,
          basis: "provider_api_observation",
          evidenceIds: hints.confirmation.evidenceIds,
        }),
      }),
      { params: Promise.resolve({ id: h.caseId }) },
    );
    expect(res.status).toBe(400);
    expect(requireBundle(h.ctx, h.caseId).subscription.cancellation.state).not.toBe(
      "CANCEL_CONFIRMED",
    );
  });

  it("rejects missing, cross-case and hidden evidence, and a confirmation basis without a confirmation document", () => {
    expect(codeOf(confirm("user_attestation", ["missing-evidence"]))).toBe("EVIDENCE_NOT_FOUND");
    // Evidence that belongs to another case.
    const other = seedFixtureCopy();
    expect(codeOf(confirm("user_attestation", [other]))).toBe("EVIDENCE_NOT_FOUND");
    // The merchant's private record is not something the buyer can cite.
    const merchantPrivate = evidenceRepo
      .listForCase(h.ctx.db, h.caseId, requireBundle(h.ctx, h.caseId).subscription.id)
      .find((e) => e.ownerRole === "merchant" && e.visibility === "private")!;
    expect(codeOf(confirm("user_attestation", [merchantPrivate.id]))).toBe("EVIDENCE_NOT_FOUND");
    // A receipt alone is not a merchant confirmation document.
    const receipt = evidenceRepo
      .listForCase(h.ctx.db, h.caseId, requireBundle(h.ctx, h.caseId).subscription.id)
      .find((e) => e.kind === "receipt")!;
    expect(codeOf(confirm("merchant_confirmation_document", [receipt.id]))).toBe(
      "EVIDENCE_TYPE_REQUIRED",
    );
    expect(requireBundle(h.ctx, h.caseId).subscription.cancellation.state).not.toBe(
      "CANCEL_CONFIRMED",
    );
    // A real confirmation document of this case works, and stays labelled as a kept document.
    const hints = readDemoHints(h.ctx)!;
    expect(
      codeOf(confirm("merchant_confirmation_document", hints.confirmation.evidenceIds)),
    ).toBeNull();
    const view = buildCaseView(h.ctx, h.caseId, "buyer");
    expect(view.subscription.cancellation.basisLabel).toMatch(/kept by the buyer/);
    expect(view.subscription.cancellation.providerMandateStatus).toBeNull();
  });

  function seedFixtureCopy(): string {
    // A confirmation document that belongs to a different case in the same database.
    const mine = evidenceRepo
      .listForCase(h.ctx.db, h.caseId, requireBundle(h.ctx, h.caseId).subscription.id)
      .find((e) => e.kind === "cancellation_confirmation")!;
    const theirs = {
      ...mine,
      id: "fx_ev_other_case",
      caseId: "fx_case_other",
      subscriptionId: "fx_sub_other",
    };
    evidenceRepo.insert(h.ctx.db, theirs);
    return theirs.id;
  }
});

describe("AUD08 traceable fact chains", () => {
  it("a fact ID whose sources are all gone cannot support a claim", async () => {
    confirm("merchant_confirmation_document", readDemoHints(h.ctx)!.confirmation.evidenceIds)();
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const snapshot = buildRoleSnapshot(h.ctx, requireBundle(h.ctx, h.caseId), "buyer");
    expect(validateDraft(draft.content, snapshot, "buyer").ok).toBe(true);
    const severed = validateDraft(
      {
        ...draft.content,
        attachmentEvidenceIds: [],
        claims: draft.content.claims.map((c) => ({ ...c, sourceIds: [] })),
      },
      { ...snapshot, sources: [], facts: snapshot.facts.map((f) => ({ ...f, sourceIds: [] })) },
      "buyer",
    );
    expect(severed.ok).toBe(false);
    expect(severed.issues.map((i) => i.code)).toContain("UNTRACEABLE_FACT");
  });

  it("the connected model is offered only facts it can cite, with sources from this snapshot", async () => {
    const full = buildRoleSnapshot(h.ctx, requireBundle(h.ctx, h.caseId), "merchant");
    // As on an imported case: the subscription is known, but nothing in the snapshot backs it.
    const snapshot = {
      ...full,
      facts: full.facts.map((f) =>
        f.kind === "subscription"
          ? { ...f, sourceIds: [] }
          : f.kind === "charge"
            ? { ...f, sourceIds: [...f.sourceIds, "fx_ev_not_in_snapshot"] }
            : f,
      ),
    };
    type Offered = { id: string; label: string; source_ids: string[] };
    let offered: Offered[] = [];
    // A model that states and cites everything it was shown.
    const citeEverything = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const prompt = body.messages[1]!.content;
      offered = (JSON.parse(prompt.slice(prompt.indexOf("{"))) as { facts: Offered[] }).facts;
      const content = {
        subject: "Merchant response",
        claims: offered.map((f, i) => ({
          id: `c${i + 1}`,
          kind: "fact",
          text: `Our records include the ${f.label.toLowerCase()}.`,
          source_ids: f.source_ids,
          fact_ids: [f.id],
        })),
      };
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const drafter = new LiveDrafter(
      {
        enabled: true,
        provider: "openai",
        model: "fictional-model",
        apiKeyPresent: true,
        baseUrl: "https://llm.example.invalid/v1",
        reasoningEffort: null,
        maxTokens: 1500,
      },
      "fictional-key",
      citeEverything,
    );
    const result = await drafter.draft({
      snapshot,
      action: "merchant_provide_evidence",
      role: "merchant",
      attachmentEvidenceIds: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const available = new Set(snapshot.sources.map((s) => s.id));
    expect(offered.map((f) => f.id)).toContain("fact_charge");
    expect(offered.map((f) => f.id)).not.toContain("fact_subscription");
    for (const f of offered) {
      expect(f.source_ids.length).toBeGreaterThan(0);
      expect(f.source_ids.every((id) => available.has(id))).toBe(true);
    }
    // Whatever such a model cites can therefore be approved on traceability grounds.
    const validation = validateDraft(result.content, snapshot, "merchant");
    expect(validation.issues.filter((i) => i.blocking)).toEqual([]);
  });

  it("sources must support the cited facts, and amounts/dates must belong to them", () => {
    confirm("merchant_confirmation_document", readDemoHints(h.ctx)!.confirmation.evidenceIds)();
    const snapshot = buildRoleSnapshot(h.ctx, requireBundle(h.ctx, h.caseId), "buyer");
    const charge = snapshot.facts.find((f) => f.kind === "charge")!;
    const effective = snapshot.facts.find((f) => f.kind === "cancellation_effective")!;
    const base = {
      action: "export_refund_request" as const,
      role: "buyer" as const,
      subject: "s",
      attachmentEvidenceIds: [],
    };
    const mismatch = validateDraft(
      {
        ...base,
        claims: [
          {
            id: "c1",
            kind: "fact",
            text: "The charge happened.",
            sourceIds: effective.sourceIds
              .filter((id) => !charge.sourceIds.includes(id))
              .slice(0, 1),
            factIds: [charge.id],
          },
        ],
      },
      snapshot,
      "buyer",
    );
    expect(mismatch.issues.map((i) => i.code)).toContain("CITATION_MISMATCH");
    const wrongAssociation = validateDraft(
      {
        ...base,
        claims: [
          {
            id: "c1",
            kind: "fact",
            text: "My cancellation took effect on 2026-11-08 and cost $19.99.",
            sourceIds: [],
            factIds: [effective.id],
          },
        ],
      },
      snapshot,
      "buyer",
    );
    const codes = wrongAssociation.issues.map((i) => i.code);
    expect(codes).toContain("DATE_MISMATCH");
    expect(codes).toContain("AMOUNT_MISMATCH");
  });

  it("case-level facts trace to typed, recorded observations rather than nothing", () => {
    confirm("merchant_confirmation_document", readDemoHints(h.ctx)!.confirmation.evidenceIds)();
    const snapshot = buildRoleSnapshot(h.ctx, requireBundle(h.ctx, h.caseId), "buyer");
    const charge = snapshot.facts.find((f) => f.id === "fact_charge")!;
    const obs = snapshot.sources.find(
      (s) => s.id === `obs_charge_${requireBundle(h.ctx, h.caseId).charge.id}`,
    );
    expect(obs).toMatchObject({ provenance: "synthetic", ownerRole: "system", sha256: null });
    expect(charge.sourceIds).toContain(obs!.id);
    // A user-attested evidence file stays user_attestation; nothing is relabelled.
    const note = addCaseEvidence(h.ctx, "buyer", {
      caseId: h.caseId,
      visibility: "shared",
      provenance: "user_attestation",
      kind: "communication",
      label: "My email to support",
      filename: "email.txt",
      declaredMime: "text/plain",
      bytes: new TextEncoder().encode("I asked for a refund."),
      capturedAt: h.clock.now().toISOString(),
      eventTime: null,
      facts: [],
    });
    const after = buildRoleSnapshot(h.ctx, requireBundle(h.ctx, h.caseId), "buyer");
    expect(after.sources.find((s) => s.id === note.id)?.provenance).toBe("user_attestation");
  });
});

describe("labels say what really happened", () => {
  it("fixture mode shows a simulated adapter, a simulated mandate read and the true subscription source", async () => {
    transferChannel(h.ctx, { caseId: h.caseId, role: "buyer", channel: "paypal", reason: "x" });
    await refreshSubscriptionObservation(h.ctx, h.caseId);
    const view = buildCaseView(h.ctx, h.caseId, "buyer");
    expect(view.case.channelAdapter).toBe("simulated");
    expect(view.case.channelConnected).toBe(false);
    expect(view.subscription.cancellation.providerMandateProvenance).toBe("synthetic");
    expect(view.timeline.find((t) => t.title === "Subscription tracked")?.provenance).toBe(
      "synthetic",
    );
    expect(channelAdapter("paypal", "sandbox")).toBe("connected");
    expect(channelAdapter("chargeback", "sandbox")).toBe("export_only");
    expect(channelAdapter("paypal", "fixture")).toBe("simulated");
  });
});
