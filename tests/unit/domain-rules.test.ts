import { describe, expect, it } from "vitest";
import {
  APPROVAL_LIFETIME_MINUTES,
  approvalExpiry,
  bindingFingerprint,
  canOpenActiveClaim,
  canProvideEvidence,
  canonicalJson,
  centsToDecimalString,
  checkApproval,
  fixedClock,
  formatCents,
  mergeObservation,
  parseProviderAmount,
  parseUsdDecimal,
  transitionWorkflow,
  validateProviderLink,
  WorkflowTransitionError,
  type ApprovalBinding,
  type ProviderObservation,
} from "@/domain";

describe("money", () => {
  it("parses provider decimals exactly", () => {
    expect(parseUsdDecimal("19.99")).toBe(1999);
    expect(parseUsdDecimal("0.10")).toBe(10);
    expect(parseUsdDecimal("1234")).toBe(123400);
    expect(parseUsdDecimal("7.5")).toBe(750);
    expect(() => parseUsdDecimal("19.999")).toThrow();
    expect(() => parseUsdDecimal("1e2")).toThrow();
    expect(() => parseUsdDecimal("-5.00")).toThrow();
  });
  it("rejects non-USD and formats cents", () => {
    expect(() => parseProviderAmount("5.00", "EUR")).toThrow(/USD/);
    expect(formatCents(1999)).toBe("$19.99 USD");
    expect(formatCents(123456789)).toBe("$1,234,567.89 USD");
    expect(centsToDecimalString(1999)).toBe("19.99");
    expect(centsToDecimalString(5)).toBe("0.05");
  });
});

describe("CC07 recovery channels", () => {
  it("blocks a second active financial claim on the same charge", () => {
    const existing = [
      {
        caseId: "c1",
        chargeId: "ch1",
        channel: "paypal" as const,
        active: true,
        closedReason: null,
      },
    ];
    const decision = canOpenActiveClaim(existing, "ch1", "chargeback");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("CONCURRENT_CLAIM_BLOCKED");
  });
  it("a drafted/exported merchant request is not an active claim, so escalation stays possible", () => {
    const existing = [
      {
        caseId: "c1",
        chargeId: "ch1",
        channel: "merchant_refund" as const,
        active: false,
        closedReason: null,
      },
    ];
    expect(canOpenActiveClaim(existing, "ch1", "paypal").allowed).toBe(true);
  });
  it("a closed claim with a reason does not block legitimate escalation", () => {
    const existing = [
      {
        caseId: "c1",
        chargeId: "ch1",
        channel: "merchant_refund" as const,
        active: false,
        closedReason: "merchant did not respond in 7 days",
      },
    ];
    expect(canOpenActiveClaim(existing, "ch1", "paypal").allowed).toBe(true);
  });
});

describe("CC08 provider observations", () => {
  const base: ProviderObservation = {
    disputeId: "PP-D-1",
    provenance: "sandbox_api",
    status: "WAITING_FOR_SELLER_RESPONSE",
    stage: "INQUIRY",
    outcome: null,
    reason: "CANCELED_RECURRING_BILLING",
    sellerResponseDueAt: "2026-11-20T00:00:00Z",
    requestedEvidenceTypes: ["CANCELLATION_DETAILS"],
    allowedActions: ["provide_evidence"],
    observedVersion: 1,
    observedAt: "2026-11-09T10:00:00Z",
    enumsUnderstood: true,
    stale: false,
  };
  it.each([1, 0])("CC08: refuses another dispute for current observation version %i", (version) => {
    const current = { ...base, observedVersion: version };
    const other = {
      ...base,
      disputeId: "PP-D-2",
      status: "RESOLVED",
      observedAt: "2026-11-09T11:00:00Z",
    };
    const outcome = mergeObservation(current, other);
    expect(outcome.kind).toBe("ignored_other_resource");
    expect(outcome.observation).toBe(current);
  });
  it("CC08: replaces a minimal reference with the first read of the same dispute", () => {
    const minimal = { ...base, observedVersion: 0, stale: true, status: null };
    const incoming = { ...base, observedAt: "2026-11-09T11:00:00Z" };
    const outcome = mergeObservation(minimal, incoming);
    expect(outcome.kind).toBe("applied");
    expect(outcome.observation).toEqual(incoming);
    expect(outcome.observation.observedVersion).toBe(1);
  });
  it("does not regress on an older snapshot", () => {
    const older = { ...base, status: "OPEN", observedAt: "2026-11-09T09:00:00Z" };
    const outcome = mergeObservation(base, older);
    expect(outcome.kind).toBe("ignored_older");
    expect(outcome.observation.status).toBe("WAITING_FOR_SELLER_RESPONSE");
  });
  it("flags uncertain ordering as stale", () => {
    const sameTime = { ...base, status: "UNDER_REVIEW" };
    const outcome = mergeObservation(base, sameTime);
    expect(outcome.kind).toBe("ordering_uncertain");
    expect(outcome.observation.stale).toBe(true);
  });
  it("unknown enums are preserved and disable mutations", () => {
    const unknown = {
      ...base,
      status: "SOMETHING_NEW",
      enumsUnderstood: false,
      observedAt: "2026-11-09T11:00:00Z",
    };
    const merged = mergeObservation(base, unknown);
    expect(merged.observation.status).toBe("SOMETHING_NEW");
    const check = canProvideEvidence(
      merged.observation,
      "merchant",
      fixedClock("2026-11-10T00:00:00Z"),
      { requireRealProvider: true },
    );
    expect(check.allowed).toBe(false);
    expect(check.codes).toContain("UNKNOWN_ENUM");
  });
  it("evidence capability requires role, status, link, deadline and a real provider observation", () => {
    const clock = fixedClock("2026-11-10T00:00:00Z");
    expect(canProvideEvidence(base, "merchant", clock, { requireRealProvider: true }).allowed).toBe(
      true,
    );
    expect(canProvideEvidence(base, "buyer", clock, { requireRealProvider: true }).codes).toContain(
      "WRONG_ROLE",
    );
    expect(
      canProvideEvidence({ ...base, allowedActions: [] }, "merchant", clock, {
        requireRealProvider: true,
      }).codes,
    ).toContain("ACTION_LINK_MISSING");
    expect(
      canProvideEvidence({ ...base, status: "OPEN" }, "merchant", clock, {
        requireRealProvider: true,
      }).codes,
    ).toContain("STATUS_NOT_ELIGIBLE");
    expect(
      canProvideEvidence(base, "merchant", fixedClock("2026-12-01T00:00:00Z"), {
        requireRealProvider: true,
      }).codes,
    ).toContain("DEADLINE_PASSED");
    expect(
      canProvideEvidence({ ...base, provenance: "synthetic" }, "merchant", clock, {
        requireRealProvider: true,
      }).codes,
    ).toContain("FIXTURE_OBSERVATION_NOT_PROVIDER");
    expect(
      canProvideEvidence({ ...base, stale: true }, "merchant", clock, { requireRealProvider: true })
        .codes,
    ).toContain("STALE_OBSERVATION");
  });
});

describe("CC18 provider link validation", () => {
  const origins = ["https://api-m.sandbox.paypal.com", "https://api.sandbox.paypal.com"];
  it("accepts a well-formed provide-evidence link for the expected dispute", () => {
    const v = validateProviderLink(
      {
        rel: "provide_evidence",
        href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-evidence",
        method: "POST",
      },
      origins,
      "PP-D-1",
    );
    expect(v.ok).toBe(true);
    expect(v.action).toBe("provide_evidence");
  });
  it("maps the Sandbox settlement link only to the same case's adjudicate path", () => {
    const link = (href: string, rel = "adjudicate") =>
      validateProviderLink({ rel, href, method: "POST" }, origins, "PP-D-1");
    const ok = link("https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/adjudicate");
    expect(ok.ok).toBe(true);
    expect(ok.action).toBe("adjudicate");
    expect(
      link("https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/accept-claim").reason,
    ).toBe("PATH_MISMATCH");
    expect(
      link("https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-2/adjudicate").reason,
    ).toBe("RESOURCE_MISMATCH");
    expect(link("https://api-m.paypal.com/v1/customer/disputes/PP-D-1/adjudicate").reason).toBe(
      "ORIGIN_NOT_ALLOWED",
    );
  });
  it("rejects other origins, resources, methods, http and embedded credentials", () => {
    expect(
      validateProviderLink(
        {
          rel: "provide_evidence",
          href: "https://api-m.paypal.com/v1/customer/disputes/PP-D-1/provide-evidence",
        },
        origins,
        "PP-D-1",
      ).reason,
    ).toBe("ORIGIN_NOT_ALLOWED");
    expect(
      validateProviderLink(
        {
          rel: "provide_evidence",
          href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-2/provide-evidence",
        },
        origins,
        "PP-D-1",
      ).reason,
    ).toBe("RESOURCE_MISMATCH");
    expect(
      validateProviderLink(
        {
          rel: "provide_evidence",
          href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-evidence",
          method: "GET",
        },
        origins,
        "PP-D-1",
      ).reason,
    ).toBe("METHOD_MISMATCH");
    expect(
      validateProviderLink(
        {
          rel: "provide_evidence",
          href: "http://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-evidence",
        },
        origins,
        "PP-D-1",
      ).reason,
    ).toBe("NOT_HTTPS");
    expect(
      validateProviderLink(
        {
          rel: "provide_evidence",
          href: "https://user:pw@api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-evidence",
        },
        origins,
        "PP-D-1",
      ).reason,
    ).toBe("CREDENTIALS_IN_URL");
    expect(
      validateProviderLink(
        {
          rel: "provide_evidence",
          href: "https://api-m.sandbox.paypal.com/evil/PP-D-1/provide-evidence",
        },
        origins,
        "PP-D-1",
      ).reason,
    ).toBe("PATH_MISMATCH");
  });
});

describe("approval binding", () => {
  const binding: ApprovalBinding = {
    actor: "demo-operator",
    role: "buyer",
    environment: "fixture",
    accountAlias: "buyer_alex",
    resourceId: "case1",
    action: "buyer_create_dispute",
    payloadHash: "abc",
    payloadVersion: 3,
    evidenceSnapshotVersion: 2,
    attachmentHashes: ["h2", "h1"],
  };
  it("is order-independent for attachments and sensitive to every bound field", () => {
    const fp = bindingFingerprint(binding);
    expect(bindingFingerprint({ ...binding, attachmentHashes: ["h1", "h2"] })).toBe(fp);
    expect(bindingFingerprint({ ...binding, payloadHash: "abd" })).not.toBe(fp);
    expect(bindingFingerprint({ ...binding, environment: "sandbox" })).not.toBe(fp);
    expect(bindingFingerprint({ ...binding, role: "merchant" })).not.toBe(fp);
    expect(bindingFingerprint({ ...binding, action: "export_refund_request" })).not.toBe(fp);
    expect(bindingFingerprint({ ...binding, attachmentHashes: ["h1"] })).not.toBe(fp);
  });
  it("checks decision, expiry, binding and consumption", () => {
    const decidedAt = "2026-11-09T10:00:00Z";
    const approval = {
      decision: "approved" as const,
      fingerprint: bindingFingerprint(binding),
      expiresAt: approvalExpiry(decidedAt),
      consumedByOperationId: null,
      revokedReason: null,
    };
    expect(approvalExpiry(decidedAt)).toBe(`2026-11-09T10:${APPROVAL_LIFETIME_MINUTES}:00.000Z`);
    expect(checkApproval(approval, binding, fixedClock("2026-11-09T10:05:00Z")).valid).toBe(true);
    expect(checkApproval(approval, binding, fixedClock("2026-11-09T10:15:00Z")).codes).toContain(
      "EXPIRED",
    );
    expect(
      checkApproval(
        approval,
        { ...binding, payloadHash: "zzz" },
        fixedClock("2026-11-09T10:05:00Z"),
      ).codes,
    ).toContain("BINDING_MISMATCH");
    expect(
      checkApproval(
        { ...approval, consumedByOperationId: "op1" },
        binding,
        fixedClock("2026-11-09T10:05:00Z"),
      ).codes,
    ).toContain("ALREADY_CONSUMED");
    expect(
      checkApproval(
        { ...approval, decision: "rejected" },
        binding,
        fixedClock("2026-11-09T10:05:00Z"),
      ).codes,
    ).toContain("REJECTED");
  });
  it("canonical JSON sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe("workflow", () => {
  it("follows the documented transitions and rejects invalid ones", () => {
    let s = transitionWorkflow("FLAGGED", { type: "START_DRAFT" });
    s = transitionWorkflow(s, { type: "DRAFT_READY" });
    s = transitionWorkflow(s, { type: "REQUEST_APPROVAL" });
    expect(s).toBe("AWAITING_APPROVAL");
    expect(transitionWorkflow(s, { type: "EDIT" })).toBe("DRAFTING");
    s = transitionWorkflow(s, { type: "DISPATCH_STARTED" });
    expect(s).toBe("EXECUTING");
    expect(transitionWorkflow(s, { type: "DISPATCH_UNKNOWN" })).toBe("UNKNOWN");
    expect(transitionWorkflow("UNKNOWN", { type: "RECOVERY_CONFIRMED_SUCCESS" })).toBe("SYNCED");
    expect(() => transitionWorkflow("FLAGGED", { type: "APPROVE" })).toThrow(
      WorkflowTransitionError,
    );
    expect(() => transitionWorkflow("SYNCED", { type: "DISPATCH_STARTED" })).toThrow(
      WorkflowTransitionError,
    );
  });
});
