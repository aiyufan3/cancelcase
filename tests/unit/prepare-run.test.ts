import { describe, expect, it } from "vitest";
import {
  MAX_ACTS,
  actWords,
  continues,
  deriveNextStep,
  draftRows,
  lastFailedRequest,
  paymentRows,
  providerRows,
  type StepAct,
} from "@/components/workbench/NextStep";
import { formatInterval } from "@/components/workbench/shared";
import type { CaseView } from "@/server/services/case-view";

/**
 * The one-press run: the next-step button takes a read or a draft itself and stops where the
 * person is needed. These tests pin down what it may take, when it stops, and that every line it
 * shows comes from what the server returned.
 */

function buyerView(over: Record<string, unknown> = {}): CaseView {
  return {
    mode: { environment: "fixture" },
    case: {
      id: "fx_case_1",
      classification: "CANDIDATE_AFTER_CANCEL",
      reasonCodes: [{ text: "The charge was initiated after the effective cancellation time." }],
      classificationText: {
        title: "Candidate: charged after cancellation",
        summary: "A completed charge was initiated after the effective cancellation time.",
      },
    },
    subscription: {
      providerRefs: [],
      cancellation: { state: "CANCEL_CONFIRMED" },
      billingWatch: null,
      paymentsReadable: false,
    },
    charge: {
      eventTime: "2026-11-09T08:00:00Z",
      amountText: "$19.99 USD",
      providerRefs: [{ kind: "subscription_sale_id" }],
      status: "COMPLETED",
    },
    provider: null,
    operations: [],
    availableActions: ["export_refund_request"],
    drafts: {},
    approvals: {},
    readiness: {
      export_refund_request: { generate: null, approve: null, submit: null, reviewPending: false },
    },
    ...over,
  } as unknown as CaseView;
}

function withDraft(view: CaseView, ok = true): CaseView {
  return {
    ...view,
    drafts: {
      export_refund_request: {
        id: "d1",
        version: 1,
        originLabel: "Template — no model call",
        stale: false,
        validation: {
          ok,
          issues: ok
            ? []
            : [
                { code: "UNTRACEABLE_FACT", claimId: "c2", message: "No source.", blocking: true },
                { code: "TONE", claimId: "c3", message: "Strong wording.", blocking: false },
              ],
        },
      },
    },
    readiness: {
      export_refund_request: {
        generate: null,
        approve: ok ? null : { code: "DRAFT_INVALID", message: "The draft has blocking issues." },
        submit: { code: "NOT_APPROVED", message: "Approve this exact version before submitting." },
        reviewPending: true,
      },
    },
  } as unknown as CaseView;
}

describe("which steps the app may take itself", () => {
  it("takes a first draft for the buyer and for the merchant", () => {
    const step = deriveNextStep(buyerView(), "buyer");
    expect(step.title).toBe("Draft the refund request to the merchant");
    expect(step.act).toEqual({ kind: "draft", action: "export_refund_request", regenerate: false });

    const merchant = buyerView({
      availableActions: ["merchant_provide_evidence"],
      readiness: {
        merchant_provide_evidence: { generate: null, approve: null, reviewPending: false },
      },
      provider: {
        status: "WAITING_FOR_SELLER_RESPONSE",
        stale: false,
        evidenceCapability: { allowed: true, codes: [] },
      },
    });
    expect(deriveNextStep(merchant, "merchant").act).toEqual({
      kind: "draft",
      action: "merchant_provide_evidence",
      regenerate: false,
    });
  });

  it("keeps the provider's name as a name inside a step title", () => {
    const view = buyerView({
      mode: { environment: "sandbox" },
      availableActions: ["buyer_create_dispute"],
      readiness: {
        buyer_create_dispute: { generate: null, approve: null, submit: null, reviewPending: false },
      },
    });
    expect(deriveNextStep(view, "buyer").title).toBe("Draft the PayPal case (Sandbox)");
  });

  it("takes a new evidence response as a regeneration", () => {
    const view = buyerView({
      availableActions: ["merchant_provide_evidence"],
      drafts: { merchant_provide_evidence: { version: 1, stale: true } },
      readiness: {
        merchant_provide_evidence: { generate: null, approve: null, reviewPending: false },
      },
      provider: {
        status: "WAITING_FOR_SELLER_RESPONSE",
        stale: false,
        evidenceCapability: { allowed: true, codes: [] },
      },
    });
    const step = deriveNextStep(view, "merchant");
    expect(step.title).toBe("Prepare a new evidence response");
    expect(step.act).toEqual({
      kind: "draft",
      action: "merchant_provide_evidence",
      regenerate: true,
    });
  });

  it("reads the payments once a planned billing is due or nothing has been read", () => {
    const watch = (due: boolean) =>
      buyerView({
        mode: { environment: "sandbox" },
        subscription: {
          providerRefs: [{ kind: "subscription_id" }],
          cancellation: { state: "CANCEL_CONFIRMED" },
          billingWatch: {
            nextBillingAt: "2026-11-10T10:00:00Z",
            observedAt: "2026-11-10T07:44:33Z",
            provenance: "sandbox_api",
            due,
          },
          paymentsReadable: true,
        },
        charge: { eventTime: null, amountText: null, providerRefs: [], status: "UNKNOWN" },
      });
    expect(deriveNextStep(watch(true), "buyer").act).toEqual({ kind: "read_payments" });
    // A billing that is still ahead is a warning, not something to read now.
    expect(deriveNextStep(watch(false), "buyer").act).toBeUndefined();

    const noPlan = watch(true);
    noPlan.subscription.billingWatch = null;
    noPlan.case.classification = "NEEDS_REVIEW";
    const step = deriveNextStep(noPlan, "buyer");
    expect(step.title).toBe("No payment yet");
    expect(step.act).toEqual({ kind: "read_payments" });
  });

  it("reads the provider case back while the provider has it", () => {
    for (const stale of [false, true]) {
      const view = buyerView({
        provider: { status: "UNDER_REVIEW", stale, evidenceCapability: { allowed: false } },
        availableActions: [],
        readiness: {},
      });
      expect(deriveNextStep(view, "buyer").act).toEqual({ kind: "refresh_provider" });
    }
  });

  it("never takes what belongs to the person: recording, reviewing, approving, sending, recovery", () => {
    const unrecorded = buyerView();
    unrecorded.subscription.cancellation.state = "ACTIVE";
    expect(deriveNextStep(unrecorded, "buyer").act).toBeUndefined();

    const unresolved = buyerView();
    unresolved.case.classification = "NEEDS_REVIEW";
    expect(deriveNextStep(unresolved, "buyer").act).toBeUndefined();

    const reviewing = deriveNextStep(withDraft(buyerView()), "buyer");
    expect(reviewing.title).toBe("Review version 1 and decide");
    expect(reviewing.act).toBeUndefined();

    const approved = withDraft(buyerView());
    approved.approvals = { export_refund_request: { usable: true } } as CaseView["approvals"];
    approved.readiness.export_refund_request!.submit = null;
    const sending = deriveNextStep(approved, "buyer");
    expect(sending.title).toBe("Export the approved request");
    expect(sending.act).toBeUndefined();

    for (const status of ["UNKNOWN", "DISPATCHING", "PREPARED"]) {
      const inFlight = buyerView({ operations: [{ status, action: "export_refund_request" }] });
      expect(deriveNextStep(inFlight, "buyer").act).toBeUndefined();
    }
  });

  it("puts no approval or sending word on a button that acts", () => {
    const acts: StepAct[] = [
      { kind: "read_payments" },
      { kind: "draft", action: "export_refund_request", regenerate: false },
      { kind: "draft", action: "merchant_provide_evidence", regenerate: true },
      { kind: "refresh_provider" },
    ];
    for (const act of acts)
      for (const role of ["buyer", "merchant"] as const) {
        const words = actWords(act, role);
        expect(words.label).not.toMatch(/approve|send|submit|export/i);
        expect(words.short).not.toMatch(/approve|send|submit|export/i);
      }
    for (const role of ["buyer", "merchant"] as const)
      expect(actWords(acts[1]!, role).hint).toContain("stops for your approval");
  });
});

describe("with two things the buyer can prepare, the step follows the channel and what is under way", () => {
  const free = { generate: null, approve: null, submit: null, reviewPending: false };
  const pending = {
    generate: null,
    approve: null,
    submit: { code: "NOT_APPROVED", message: "Approve this exact version before submitting." },
    reviewPending: true,
  };
  const draft = { version: 1, stale: false, validation: { ok: true, issues: [] } };
  function both(channel: string, over: Record<string, unknown> = {}): CaseView {
    const view = buyerView({
      mode: { environment: "sandbox" },
      availableActions: ["export_refund_request", "buyer_create_dispute"],
      readiness: { export_refund_request: free, buyer_create_dispute: free },
      ...over,
    });
    (view.case as { channel: string }).channel = channel;
    return view;
  }

  it("prepares the PayPal case first on the PayPal channel", () => {
    const step = deriveNextStep(both("paypal"), "buyer");
    expect(step.title).toBe("Draft the PayPal case (Sandbox)");
    expect(step.target).toBe("#action-buyer_create_dispute");
    expect(step.act).toEqual({ kind: "draft", action: "buyer_create_dispute", regenerate: false });
  });

  it("prepares the request to the merchant on any other channel", () => {
    const blocked = {
      ...free,
      generate: { code: "CHANNEL_NOT_PAYPAL", message: "Choose the PayPal channel first." },
    };
    const view = both("merchant_refund", {
      readiness: { export_refund_request: free, buyer_create_dispute: blocked },
    });
    const step = deriveNextStep(view, "buyer");
    expect(step.title).toBe("Draft the refund request to the merchant");
    expect(step.act).toEqual({ kind: "draft", action: "export_refund_request", regenerate: false });
  });

  it("never hides a draft that waits for a decision behind starting another one", () => {
    // The PayPal case is drafted and waits; the request to the merchant was never drafted.
    const waitingDispute = both("merchant_refund", {
      drafts: { buyer_create_dispute: draft },
      readiness: { export_refund_request: free, buyer_create_dispute: pending },
    });
    const step = deriveNextStep(waitingDispute, "buyer");
    expect(step.title).toBe("Review version 1 and decide");
    expect(step.target).toBe("#action-buyer_create_dispute");
    expect(step.act).toBeUndefined();

    // The same the other way round, on the PayPal channel.
    const waitingExport = both("paypal", {
      drafts: { export_refund_request: draft },
      readiness: { export_refund_request: pending, buyer_create_dispute: free },
    });
    expect(deriveNextStep(waitingExport, "buyer").target).toBe("#action-export_refund_request");
  });

  it("goes to the channel's own draft when both wait for a decision", () => {
    const view = both("paypal", {
      drafts: { export_refund_request: draft, buyer_create_dispute: draft },
      readiness: { export_refund_request: pending, buyer_create_dispute: pending },
    });
    expect(deriveNextStep(view, "buyer").target).toBe("#action-buyer_create_dispute");
    (view.case as { channel: string }).channel = "merchant_refund";
    expect(deriveNextStep(view, "buyer").target).toBe("#action-export_refund_request");
  });

  it("follows an open provider case instead of offering a second request for the same charge", () => {
    const open = both("paypal", {
      provider: { status: "OPEN", stale: false, evidenceCapability: { allowed: false } },
      drafts: { buyer_create_dispute: draft },
      readiness: {
        export_refund_request: free,
        buyer_create_dispute: {
          ...free,
          generate: { code: "CLAIM_ALREADY_ACTIVE", message: "A provider case is already open." },
        },
      },
    });
    (open.case as { claimActive: boolean }).claimActive = true;
    const step = deriveNextStep(open, "buyer");
    expect(step.title).toBe("Follow the provider case");
    expect(step.target).toBe("#provider");
    expect(step.act).toEqual({ kind: "refresh_provider" });
    // Once no claim is active any more, the request to the merchant can be offered again.
    (open.case as { claimActive: boolean }).claimActive = false;
    expect(deriveNextStep(open, "buyer").title).toBe("Draft the refund request to the merchant");
  });

  it("still lets the merchant prepare a response to an open provider case", () => {
    const view = buyerView({
      availableActions: ["merchant_provide_evidence"],
      readiness: {
        merchant_provide_evidence: { generate: null, approve: null, reviewPending: false },
      },
      provider: {
        status: "WAITING_FOR_SELLER_RESPONSE",
        stale: false,
        evidenceCapability: { allowed: true, codes: [] },
      },
    });
    (view.case as { claimActive: boolean }).claimActive = true;
    expect(deriveNextStep(view, "merchant").title).toBe(
      "Draft the evidence response to the reviewer",
    );
  });

  it("uses an approval that is waiting before anything else", () => {
    const view = both("paypal", {
      drafts: { export_refund_request: draft },
      approvals: { export_refund_request: { usable: true } },
      readiness: {
        export_refund_request: { ...pending, submit: null },
        buyer_create_dispute: free,
      },
    });
    const step = deriveNextStep(view, "buyer");
    expect(step.title).toBe("Export the approved request");
    expect(step.target).toBe("#action-export_refund_request");
  });
});

describe("a decided provider case", () => {
  function decided(outcome: string | null, over: Record<string, unknown> = {}): CaseView {
    const view = buyerView({
      mode: { environment: "sandbox" },
      provider: {
        status: "RESOLVED",
        outcome,
        stale: false,
        evidenceCapability: { allowed: false, codes: [] },
        testControls: [],
      },
      ...over,
    });
    (view.case as { recoveredCents: number; recoveredText: string }).recoveredCents = 0;
    (view.case as { recoveredText: string }).recoveredText = "$0.00 USD";
    (view.subscription as { paymentsReadable: boolean }).paymentsReadable = true;
    return view;
  }

  it("asks the buyer to read the refund back, and says when the decision was simulated", () => {
    const view = decided("RESOLVED_BUYER_FAVOUR");
    let step = deriveNextStep(view, "buyer");
    expect(step.title).toBe("Read the refund back");
    expect(step.act).toEqual({ kind: "read_payments" });
    expect(step.body).toContain("PayPal decided the case in the buyer's favour.");
    expect(step.body).toContain("counts as recovered only when PayPal reports it");

    view.provider!.testControls = [
      {
        kind: "settlement",
        outcome: "BUYER_FAVOR",
        status: "SUCCEEDED",
        at: "2026-11-11T14:00:00Z",
      },
    ];
    step = deriveNextStep(view, "buyer");
    expect(step.body).toContain(
      "PayPal's Sandbox test control decided the case in the buyer's favour.",
    );
  });

  it("reports a refund read back as recovered, and stops", () => {
    const view = decided("RESOLVED_BUYER_FAVOUR");
    (view.case as { recoveredCents: number }).recoveredCents = 1999;
    (view.case as { recoveredText: string }).recoveredText = "$19.99 USD";
    const step = deriveNextStep(view, "buyer");
    expect(step.title).toBe("Resolved, and the refund was read back");
    expect(step.body).toContain("PayPal reports $19.99 USD refunded");
    expect(step.act).toBeUndefined();
  });

  it("reports any other decision as read, for both roles, without offering anything new", () => {
    for (const outcome of ["RESOLVED_SELLER_FAVOUR", "DENIED"]) {
      for (const role of ["buyer", "merchant"] as const) {
        const step = deriveNextStep(decided(outcome), role);
        expect(step.title).toBe("PayPal decided the case");
        expect(step.tone).toBe("blocked");
        expect(step.act).toBeUndefined();
        expect(step.body).toContain("it does not judge it");
      }
    }
    expect(deriveNextStep(decided("RESOLVED_SELLER_FAVOUR"), "buyer").body).toContain(
      "in the seller's favour",
    );
    expect(deriveNextStep(decided("DENIED"), "merchant").body).toContain("with the outcome denied");
    // Resolved without an outcome code: the decision is not known yet, so the case is read again.
    for (const role of ["buyer", "merchant"] as const) {
      const step = deriveNextStep(decided(null), role);
      expect(step.title).toBe("Follow the provider case");
      expect(step.act).toEqual({ kind: "refresh_provider" });
    }
    // The merchant is never asked to read the buyer's refund.
    expect(deriveNextStep(decided("RESOLVED_BUYER_FAVOUR"), "merchant").act).toBeUndefined();
  });

  it("still puts a request with an unknown result first", () => {
    const view = decided("RESOLVED_BUYER_FAVOUR", {
      operations: [{ status: "UNKNOWN", action: "buyer_create_dispute" }],
    });
    expect(deriveNextStep(view, "buyer").title).toBe("Check what happened to the last request");
  });

  it("lists a refund that a payments read brought back", () => {
    const before = decided("RESOLVED_BUYER_FAVOUR");
    const after = decided("RESOLVED_BUYER_FAVOUR");
    (after.case as { recoveredCents: number }).recoveredCents = 1999;
    (after.case as { recoveredText: string }).recoveredText = "$19.99 USD";
    const rows = paymentRows(before, after, "No new payment.", []);
    expect(rows).toContainEqual({
      state: "done",
      text: "Refund read back",
      detail: "$19.99 USD reported refunded by the provider",
    });
    expect(paymentRows(before, before, "No new payment.", [])).toHaveLength(1);
  });
});

describe("when a run goes on and when it stops", () => {
  const read: StepAct = { kind: "read_payments" };
  const draft: StepAct = { kind: "draft", action: "export_refund_request", regenerate: false };
  const refresh: StepAct = { kind: "refresh_provider" };

  it("stops when the next step has nothing the app can take", () => {
    expect(continues(undefined, [])).toBe(false);
    expect(continues(undefined, ["read_payments"])).toBe(false);
  });

  it("goes from a read to a draft, and never past a draft", () => {
    expect(continues(read, [])).toBe(true);
    expect(continues(draft, ["read_payments"])).toBe(true);
    expect(continues(draft, ["refresh_provider"])).toBe(true);
    expect(continues(refresh, ["draft"])).toBe(false);
    expect(continues(read, ["read_payments", "draft"])).toBe(false);
  });

  it("does not repeat a read that changed nothing", () => {
    expect(continues(read, ["read_payments"])).toBe(false);
    expect(continues(refresh, ["refresh_provider"])).toBe(false);
  });

  it("is bounded whatever the server answers", () => {
    expect(MAX_ACTS).toBe(3);
    expect(continues(draft, ["read_payments", "refresh_provider", "read_payments"])).toBe(false);
  });

  it("ends at the person's review after one press from a due billing", () => {
    // What the loop does, with the views a server would return: read, then draft, then stop.
    const taken: StepAct["kind"][] = [];
    const due = buyerView({
      mode: { environment: "sandbox" },
      subscription: {
        providerRefs: [{ kind: "subscription_id" }],
        cancellation: { state: "CANCEL_CONFIRMED" },
        billingWatch: {
          nextBillingAt: "2026-11-10T10:00:00Z",
          observedAt: "2026-11-10T13:49:00Z",
          provenance: "sandbox_api",
          due: true,
        },
        paymentsReadable: true,
      },
      charge: { eventTime: null, amountText: null, providerRefs: [], status: "UNKNOWN" },
    });
    const afterRead = buyerView({ mode: { environment: "sandbox" } });
    const afterDraft = withDraft(afterRead);
    let act = deriveNextStep(due, "buyer").act;
    for (const next of [afterRead, afterDraft]) {
      expect(continues(act, taken)).toBe(true);
      taken.push(act!.kind);
      act = deriveNextStep(next, "buyer").act;
    }
    expect(taken).toEqual(["read_payments", "draft"]);
    expect(continues(act, taken)).toBe(false);
    expect(deriveNextStep(afterDraft, "buyer").title).toBe("Review version 1 and decide");
  });
});

describe("a failed request stays in sight until something newer exists", () => {
  const op = (status: string, createdAt: string, providerWrite = true) =>
    ({ id: createdAt, status, createdAt, providerWrite, action: "buyer_create_dispute" }) as never;

  it("is the latest request when that one failed", () => {
    const view = buyerView({
      operations: [
        op("SUCCEEDED", "2026-11-10T10:00:00Z", false),
        op("FAILED", "2026-11-10T18:58:40Z"),
      ],
    });
    expect(lastFailedRequest(view)?.createdAt).toBe("2026-11-10T18:58:40Z");
    // Whatever order the list comes in.
    view.operations.reverse();
    expect(lastFailedRequest(view)?.createdAt).toBe("2026-11-10T18:58:40Z");
  });

  it("is nothing once a newer request exists, or when nothing was sent", () => {
    expect(lastFailedRequest(buyerView())).toBeNull();
    const recovered = buyerView({
      operations: [op("FAILED", "2026-11-10T18:58:40Z"), op("SUCCEEDED", "2026-11-11T17:00:00Z")],
    });
    expect(lastFailedRequest(recovered)).toBeNull();
    const unknown = buyerView({ operations: [op("UNKNOWN", "2026-11-10T18:58:40Z")] });
    expect(lastFailedRequest(unknown)).toBeNull();
  });
});

describe("what a run reports", () => {
  it("reads the graph's own line for the facts and the draft the view holds", () => {
    const log = [
      "gathered 9 facts and 4 sources visible to buyer (snapshot v2)",
      "drafted d0 v1 · Template — no model call (valid)",
      "review decision: reject",
      "gathered 12 facts and 5 sources visible to buyer (snapshot v3)",
      "drafted d1 v1 · Template — no model call (valid)",
    ];
    const rows = draftRows(log, withDraft(buyerView()), "export_refund_request");
    expect(rows.map((r) => r.text)).toEqual([
      "Facts gathered",
      "Draft v1 written",
      "Validation passed",
      "Your approval is next",
    ]);
    // The latest gathering, not an earlier one of the same thread.
    expect(rows[0]!.detail).toBe("12 facts, 5 sources");
    expect(rows[1]!.detail).toBe("Template — no model call");
    expect(rows.at(-1)).toMatchObject({
      state: "waiting",
      detail: "Nothing was approved or sent.",
    });
  });

  it("says so when validation blocked the draft, and counts only what blocks", () => {
    const rows = draftRows(
      ["gathered 1 facts and 1 sources visible to buyer (snapshot v1)"],
      withDraft(buyerView(), false),
      "export_refund_request",
    );
    expect(rows[0]!.detail).toBe("1 fact, 1 source");
    expect(rows[2]).toMatchObject({ state: "attention", text: "Validation blocked the draft" });
    expect(rows[2]!.detail).toBe("1 finding to resolve before it can be approved");
    expect(rows.at(-1)).toMatchObject({ state: "waiting", text: "Your edits are next" });
    expect(rows.some((r) => r.text === "Validation passed")).toBe(false);
  });

  it("claims no count it cannot read and no draft that is not there", () => {
    const rows = draftRows(["something else"], buyerView(), "export_refund_request");
    expect(rows[0]).toEqual({ state: "done", text: "Facts gathered", detail: undefined });
    expect(rows[1]).toEqual({ state: "failed", text: "No draft was produced" });
    expect(rows).toHaveLength(2);
  });

  it("reports a recorded payment with the check's own result", () => {
    const before = buyerView({
      charge: { eventTime: null, amountText: null, providerRefs: [], status: "UNKNOWN" },
    });
    before.case.classification = "NEEDS_REVIEW";
    const after = buyerView();
    const message =
      "A payment was read. It is recorded in this case and checked against the cancellation you recorded.";
    const rows = paymentRows(before, after, message, []);
    expect(rows).toEqual([
      { state: "done", text: "Payments read", detail: message },
      {
        state: "done",
        text: "Checked against your cancellation",
        detail: "Candidate: charged after cancellation",
      },
    ]);
  });

  it("reports nothing found as nothing found", () => {
    const view = buyerView({
      charge: { eventTime: null, amountText: null, providerRefs: [], status: "UNKNOWN" },
    });
    const message = "No payment yet. PayPal lists none for this subscription.";
    expect(paymentRows(view, view, message, [])).toEqual([
      { state: "done", text: "Payments read", detail: message },
    ]);
  });

  it("links a later payment to its own case", () => {
    const view = buyerView();
    const rows = paymentRows(view, view, "1 new payment found.", ["sb_case_new"]);
    expect(rows.at(-1)).toMatchObject({
      text: "A later payment has its own case",
      href: "/cases/sb_case_new",
    });
    expect(paymentRows(view, view, "2 new payments found.", ["a", "b"]).at(-1)).toMatchObject({
      text: "Later payments have their own cases",
      href: "/cases/a",
    });
  });

  it("reports the provider's state as last observed, or the failed read", () => {
    const view = buyerView({ provider: { status: "WAITING_FOR_SELLER_RESPONSE" } });
    expect(providerRows(view, null)).toEqual([
      {
        state: "done",
        text: "Provider case read",
        detail: "Last observed as waiting for seller response",
      },
    ]);
    expect(providerRows(view, "The provider did not answer.")).toEqual([
      {
        state: "failed",
        text: "The provider case could not be read",
        detail: "The provider did not answer.",
      },
    ]);
  });
});

describe("the time between the cancellation and the charge is never rounded up", () => {
  const from = "2026-11-10T07:43:01Z";
  it.each([
    ["2026-11-10T16:31:47Z", "8 h 48 min after"],
    ["2026-11-10T08:03:01Z", "20 min after"],
    ["2026-11-10T09:43:01Z", "2 h after"],
    ["2026-11-10T07:43:31Z", "less than a minute after"],
    ["2026-11-11T10:55:00Z", "1 day 3 h after"],
    ["2026-11-13T07:50:00Z", "3 days after"],
    ["2026-11-10T07:13:01Z", "30 min before"],
    ["2026-11-10T07:43:01Z", "at the same moment as"],
  ])("%s reads as %s", (to, expected) => {
    expect(formatInterval(from, to)).toBe(expected);
  });

  it("says nothing when a time is missing or unreadable", () => {
    expect(formatInterval(null, from)).toBeNull();
    expect(formatInterval(from, null)).toBeNull();
    expect(formatInterval(from, "not a time")).toBeNull();
  });
});
