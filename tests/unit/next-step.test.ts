import { describe, expect, it } from "vitest";
import { deriveNextStep } from "@/components/workbench/NextStep";
import { awaitingFirstPayment, sectionOpen } from "@/components/workbench/shared";
import type { CaseView, ViewOperation } from "@/server/services/case-view";

function merchantView(classification: "NEEDS_REVIEW" | "NO_ANOMALY"): CaseView {
  return {
    mode: { environment: "fixture" },
    case: {
      classification,
      reasonCodes: [{ text: "Refund state has not been verified." }],
      classificationText: { summary: "The facts do not show a charge after cancellation." },
    },
    subscription: { cancellation: { state: "ACTIVE" } },
    provider: {
      status: "WAITING_FOR_SELLER_RESPONSE",
      stale: false,
      evidenceCapability: { allowed: true, codes: [] },
    },
    operations: [],
    availableActions: ["merchant_provide_evidence"],
    drafts: {},
    approvals: {},
    readiness: {
      merchant_provide_evidence: { generate: null, approve: null, reviewPending: false },
    },
  } as unknown as CaseView;
}

function submitted(view: CaseView): CaseView {
  return {
    ...view,
    provider: {
      ...view.provider!,
      status: "UNDER_REVIEW",
      evidenceCapability: { allowed: false, codes: ["STATUS_NOT_ELIGIBLE", "ACTION_LINK_MISSING"] },
    },
    operations: [
      {
        action: "merchant_provide_evidence",
        status: "SUCCEEDED",
        providerWrite: true,
      } as ViewOperation,
    ],
  };
}

describe("merchant next step follows the provider case rather than buyer eligibility (CC17, CC20)", () => {
  it.each(["NEEDS_REVIEW", "NO_ANOMALY"] as const)(
    "offers a seller response for a %s charge when the provider requests evidence",
    (classification) => {
      const step = deriveNextStep(merchantView(classification), "merchant");
      expect(step.target).toBe("#action-merchant_provide_evidence");
      expect(step.title).toMatch(/^Draft the/);
    },
  );

  it.each(["NEEDS_REVIEW", "NO_ANOMALY"] as const)(
    "hands a submitted %s case to the simulated provider without implying an outcome",
    (classification) => {
      const step = deriveNextStep(submitted(merchantView(classification)), "merchant");
      expect(step.title).toBe("The case is with the simulated provider");
      expect(step.target).toBe("#provider");
      expect(step.body).toContain("under review");
      expect(step.body).toContain("The provider decides");
      expect(step.body).not.toMatch(/resolved|refund issued|money recovered/i);
    },
  );

  it("puts an unknown or in-flight submission ahead of the provider handoff", () => {
    const view = submitted(merchantView("NEEDS_REVIEW"));
    view.operations[0]!.status = "UNKNOWN";
    expect(deriveNextStep(view, "merchant").target).toBe("#operations");
    expect(deriveNextStep(view, "merchant").title).toBe("Check what happened to the last request");
    view.operations[0]!.status = "DISPATCHING";
    expect(deriveNextStep(view, "merchant").title).toBe("A request is being sent");
  });

  it("labels a connected handoff and keeps a resolved observation distinct", () => {
    const view = submitted(merchantView("NEEDS_REVIEW"));
    view.mode.environment = "sandbox";
    expect(deriveNextStep(view, "merchant").title).toBe("The case is with PayPal");
    view.provider!.status = "RESOLVED";
    const step = deriveNextStep(view, "merchant");
    expect(step.title).toBe("Follow the provider case");
    expect(step.body).toContain("Last observed as resolved");
  });

  it("asks for a fresh read when the post-submission observation is stale", () => {
    const view = submitted(merchantView("NEEDS_REVIEW"));
    view.provider!.stale = true;
    const step = deriveNextStep(view, "merchant");
    expect(step.title).toBe("Refresh the provider case");
    expect(step.body).toContain("last read could not confirm");
  });

  it("starts a new review when the provider asks for evidence again after submission", () => {
    const view = submitted(merchantView("NO_ANOMALY"));
    view.provider!.status = "WAITING_FOR_SELLER_RESPONSE";
    view.provider!.evidenceCapability = { allowed: true, codes: [] };
    view.drafts.merchant_provide_evidence = {
      version: 1,
      stale: true,
    } as CaseView["drafts"]["merchant_provide_evidence"];
    const step = deriveNextStep(view, "merchant");
    expect(step.title).toBe("Prepare a new evidence response");
    expect(step.target).toBe("#action-merchant_provide_evidence");
  });

  it("keeps the buyer's no-anomaly guidance", () => {
    const view = merchantView("NO_ANOMALY");
    view.subscription.cancellation.state = "CANCEL_CONFIRMED";
    expect(deriveNextStep(view, "buyer").title).toBe("Nothing to request");
  });
});

describe("buyer next step when the provider still plans to bill after a recorded cancellation", () => {
  function watched(
    classification: "NEEDS_REVIEW" | "NO_ANOMALY" | "CANDIDATE_AFTER_CANCEL",
    opts: { due: boolean; readable?: boolean; paid?: boolean },
  ): CaseView {
    const view = merchantView(
      classification === "CANDIDATE_AFTER_CANCEL" ? "NO_ANOMALY" : classification,
    );
    view.case.classification = classification;
    view.provider = null;
    view.availableActions = ["export_refund_request"];
    view.readiness = {
      export_refund_request: { generate: null, approve: null, submit: null, reviewPending: false },
    };
    view.subscription = {
      cancellation: { state: "CANCEL_CONFIRMED" },
      billingWatch: {
        nextBillingAt: "2026-11-11T10:00:00Z",
        observedAt: "2026-11-10T04:00:00Z",
        provenance: "sandbox_api",
        due: opts.due,
      },
      paymentsReadable: opts.readable ?? true,
    } as unknown as CaseView["subscription"];
    view.charge = (opts.paid === false
      ? { eventTime: null, providerRefs: [] }
      : {
          eventTime: "2026-11-10T03:44:44Z",
          providerRefs: [{ kind: "subscription_sale_id" }],
        }) as unknown as CaseView["charge"];
    return view;
  }

  it("warns while the planned time is ahead and asks for a read once it has passed", () => {
    const ahead = deriveNextStep(watched("NO_ANOMALY", { due: false }), "buyer");
    expect(ahead.title).toBe("A billing is still planned");
    expect(ahead.tone).toBe("attention");
    expect(ahead.target).toBe("#cancellation");
    expect(ahead.body).toContain("Nov 11, 2026");
    expect(ahead.body).toContain("does not stop the billing");
    const due = deriveNextStep(watched("NO_ANOMALY", { due: true }), "buyer");
    expect(due.title).toBe("Read the payments");
    expect(due.tone).toBe("go");
    // A plan is not a payment: neither step claims that a charge happened.
    for (const step of [ahead, due]) expect(step.body).not.toMatch(/you were charged|was charged/i);
  });

  it("applies to a case created before any payment, never to another open review or a candidate", () => {
    expect(deriveNextStep(watched("NEEDS_REVIEW", { due: true, paid: false }), "buyer").title).toBe(
      "Read the payments",
    );
    expect(deriveNextStep(watched("NEEDS_REVIEW", { due: true }), "buyer").title).toBe(
      "Resolve what the check could not confirm",
    );
    expect(deriveNextStep(watched("CANDIDATE_AFTER_CANCEL", { due: true }), "buyer").title).toMatch(
      /^Draft the/,
    );
  });

  it("is not offered where payments cannot be read, or to the merchant view", () => {
    expect(
      deriveNextStep(watched("NO_ANOMALY", { due: true, readable: false }), "buyer").title,
    ).toBe("Nothing to request");
    expect(deriveNextStep(watched("NO_ANOMALY", { due: true }), "merchant").title).not.toBe(
      "Read the payments",
    );
  });
});

describe("a case opened before its first payment says so instead of calling it unknown", () => {
  function unpaid(opts: { watch?: boolean; due?: boolean; readable?: boolean } = {}): CaseView {
    return {
      mode: { environment: "sandbox" },
      case: {
        classification: "NEEDS_REVIEW",
        reasonCodes: [{ text: "The charge amount is not known." }],
        classificationText: { summary: "Facts are missing or contradictory." },
      },
      subscription: {
        providerRefs: [{ kind: "subscription_id", value: "I-…", provenance: "sandbox_api" }],
        cancellation: { state: "CANCEL_CONFIRMED" },
        billingWatch: opts.watch
          ? {
              nextBillingAt: "2026-11-10T10:00:00Z",
              observedAt: "2026-11-10T07:44:33Z",
              provenance: "sandbox_api",
              due: opts.due ?? false,
            }
          : null,
        paymentsReadable: opts.readable ?? true,
      },
      charge: { eventTime: null, amountText: null, providerRefs: [], status: "UNKNOWN" },
      provider: null,
      operations: [],
      availableActions: ["export_refund_request"],
      drafts: {},
      approvals: {},
      readiness: {},
    } as unknown as CaseView;
  }

  it("recognises the state only for a connected subscription with nothing read", () => {
    expect(awaitingFirstPayment(unpaid())).toBe(true);
    const paid = unpaid();
    paid.charge.eventTime = "2026-11-10T10:02:11Z";
    expect(awaitingFirstPayment(paid)).toBe(false);
    const amountOnly = unpaid();
    amountOnly.charge.amountText = "$19.99 USD";
    expect(awaitingFirstPayment(amountOnly)).toBe(false);
    const manual = unpaid();
    manual.subscription.providerRefs = [];
    expect(awaitingFirstPayment(manual)).toBe(false);
  });

  it("asks for a read, not for facts to be resolved by hand", () => {
    const step = deriveNextStep(unpaid(), "buyer");
    expect(step.title).toBe("No payment yet");
    expect(step.target).toBe("#cancellation");
    expect(step.body).toContain("Read the payments");
    expect(step.body).not.toMatch(/you were charged|was charged/i);
  });

  it("says the first payment is recorded in this case once the planned time has passed", () => {
    const step = deriveNextStep(unpaid({ watch: true, due: true }), "buyer");
    expect(step.title).toBe("Read the payments");
    expect(step.body).toContain("recorded in this case");
    expect(step.body).not.toContain("becomes its own case");
  });

  it("falls back to the ordinary review step where payments cannot be read", () => {
    expect(deriveNextStep(unpaid({ readable: false }), "buyer").title).toBe(
      "Resolve what the check could not confirm",
    );
  });
});

describe("which sections of the case file are unfolded", () => {
  const none: ReadonlySet<string> = new Set();
  it("shows everything on a wide screen unless a section was folded by hand", () => {
    const wide = { closed: none, opened: none, compact: false, stepTarget: "charge" };
    for (const id of ["cancellation", "charge", "evidence", "timeline"])
      expect(sectionOpen(wide, id)).toBe(true);
    expect(sectionOpen({ ...wide, closed: new Set(["timeline"]) }, "timeline")).toBe(false);
  });

  it("in the compact view opens the current step's section and what was opened since", () => {
    const compact = {
      closed: none,
      opened: new Set(["cancellation"]),
      compact: true,
      stepTarget: "action-export_refund_request",
    };
    expect(sectionOpen(compact, "action-export_refund_request")).toBe(true);
    expect(sectionOpen(compact, "cancellation")).toBe(true);
    expect(sectionOpen(compact, "evidence")).toBe(false);
    expect(sectionOpen(compact, "housekeeping")).toBe(false);
  });

  it("keeps the section of the step just left open beside the new one, and no older one", () => {
    const state = {
      closed: none,
      opened: none,
      compact: true,
      stepTarget: "action-export_refund_request",
      previousTarget: "cancellation",
    };
    expect(sectionOpen(state, "cancellation")).toBe(true);
    expect(sectionOpen(state, "action-export_refund_request")).toBe(true);
    expect(sectionOpen(state, "charge")).toBe(false);
  });

  it("never reopens a section the person folded, even when the step points at it", () => {
    const state = {
      closed: new Set(["charge"]),
      opened: new Set(["charge"]),
      compact: true,
      stepTarget: "charge",
    };
    expect(sectionOpen(state, "charge")).toBe(false);
  });
});
