import { describe, expect, it } from "vitest";
import {
  dedupeChargeObservations,
  initialCancellation,
  reconcile,
  reduceCancellation,
  type ChargeFacts,
  type SubscriptionFacts,
} from "@/domain";

const EFFECTIVE = "2026-11-07T12:00:00Z";
const CHARGE_TIME = "2026-11-08T12:00:00Z";

function confirmedSubscription(overrides: Partial<SubscriptionFacts> = {}): SubscriptionFacts {
  let cancellation = initialCancellation();
  cancellation = reduceCancellation(cancellation, {
    type: "RECORD_CANCELLATION_REQUEST",
    requestedAt: "2026-11-06T09:30:00Z",
  });
  cancellation = reduceCancellation(cancellation, {
    type: "RECORD_CONFIRMATION",
    receivedAt: "2026-11-06T09:45:00Z",
    effectiveAt: EFFECTIVE,
    basis: "merchant_confirmation_document",
    evidenceIds: ["src_cancel_email"],
  });
  return {
    id: "fixture_sub_1",
    environment: "fixture",
    accountAlias: "buyer_alex",
    merchantAlias: "Example Studio",
    cancellation,
    sourceIds: ["src_receipt_original"],
    ...overrides,
  };
}

function charge(overrides: Partial<ChargeFacts> = {}): ChargeFacts {
  return {
    id: "fixture_charge_1",
    environment: "fixture",
    accountAlias: "buyer_alex",
    merchantAlias: "Example Studio",
    subscriptionId: "fixture_sub_1",
    matchMethod: "explicit_reviewed_association",
    eventTime: CHARGE_TIME,
    postedTime: "2026-11-08T12:05:00Z",
    ingestedTime: "2026-11-08T18:00:00Z",
    status: "COMPLETED",
    amount: { cents: 1999, currency: "USD" },
    refundedCents: 0,
    refundStateKnown: true,
    currency: "USD",
    servicePeriodStart: "2026-11-08T00:00:00Z",
    servicePeriodEnd: "2026-12-08T00:00:00Z",
    arrearsIndicator: false,
    sourceIds: ["src_charge_record"],
    ...overrides,
  };
}

describe("CC01 valid cancellation + later completed charge", () => {
  it("produces one candidate with source refs and reason codes and no write", () => {
    const result = reconcile(confirmedSubscription(), charge());
    expect(result.classification).toBe("CANDIDATE_AFTER_CANCEL");
    expect(result.reasonCodes).toContain("CHARGE_AFTER_EFFECTIVE_CANCELLATION");
    expect(result.claimableCents).toBe(1999);
    expect(result.sourceIds).toEqual(
      expect.arrayContaining(["src_cancel_email", "src_receipt_original", "src_charge_record"]),
    );
    expect(result.facts.effectiveAt).toBe(EFFECTIVE);
  });
});

describe("CC02 cancellation without confirmation or with conflicting proof", () => {
  it("requested but not confirmed needs review", () => {
    const sub = confirmedSubscription();
    const requestedOnly = reduceCancellation(initialCancellation(), {
      type: "RECORD_CANCELLATION_REQUEST",
      requestedAt: "2026-11-06T09:30:00Z",
    });
    const result = reconcile({ ...sub, cancellation: requestedOnly }, charge());
    expect(result.classification).toBe("NEEDS_REVIEW");
    expect(result.reasonCodes).toContain("CANCELLATION_NOT_CONFIRMED");
    expect(result.claimableCents).toBeNull();
  });

  it("confirmation without effective time or evidence lands in NEEDS_REVIEW", () => {
    const rec = reduceCancellation(
      reduceCancellation(initialCancellation(), {
        type: "RECORD_CANCELLATION_REQUEST",
        requestedAt: "2026-11-06T09:30:00Z",
      }),
      {
        type: "RECORD_CONFIRMATION",
        receivedAt: "2026-11-06T09:45:00Z",
        effectiveAt: null,
        basis: "user_attestation",
        evidenceIds: [],
      },
    );
    expect(rec.state).toBe("NEEDS_REVIEW");
    expect(rec.reviewReasons).toEqual(
      expect.arrayContaining(["MISSING_EVIDENCE", "MISSING_EFFECTIVE_TIME"]),
    );
    const result = reconcile({ ...confirmedSubscription(), cancellation: rec }, charge());
    expect(result.classification).toBe("NEEDS_REVIEW");
    expect(result.reasonCodes).toContain("CANCELLATION_NEEDS_REVIEW");
  });

  it("a second confirmation with a different effective time is a conflict", () => {
    const sub = confirmedSubscription();
    const conflicting = reduceCancellation(sub.cancellation, {
      type: "RECORD_CONFIRMATION",
      receivedAt: "2026-11-06T10:00:00Z",
      effectiveAt: "2026-11-09T12:00:00Z",
      basis: "user_attestation",
      evidenceIds: ["src_other"],
    });
    expect(conflicting.state).toBe("NEEDS_REVIEW");
    expect(conflicting.reviewReasons).toContain("CONFLICTING_EFFECTIVE_TIME");
  });

  it("a user attestation is recorded as such and does not change provider mandate state", () => {
    const rec = reduceCancellation(confirmedSubscription().cancellation, {
      type: "OBSERVE_PROVIDER_MANDATE",
      status: "ACTIVE",
      observedAt: "2026-11-08T00:00:00Z",
    });
    expect(rec.state).toBe("CANCEL_CONFIRMED");
    expect(rec.providerMandateStatus).toBe("ACTIVE");
  });

  it("the provider's next planned billing is recorded with the observation that states it", () => {
    const base = confirmedSubscription().cancellation;
    const stated = reduceCancellation(base, {
      type: "OBSERVE_PROVIDER_MANDATE",
      status: "ACTIVE",
      observedAt: "2026-11-08T00:00:00Z",
      nextBillingAt: "2026-11-09T10:00:00Z",
    });
    expect(stated.providerMandateNextBillingAt).toBe("2026-11-09T10:00:00Z");
    // The plan is recorded beside the cancellation facts and changes none of them.
    expect(stated.state).toBe(base.state);
    expect(stated.effectiveAt).toBe(base.effectiveAt);
    // An observation that does not state the plan leaves it; one that states "none" clears it.
    const silent = reduceCancellation(stated, {
      type: "OBSERVE_PROVIDER_MANDATE",
      status: "ACTIVE",
      observedAt: "2026-11-08T01:00:00Z",
    });
    expect(silent.providerMandateNextBillingAt).toBe("2026-11-09T10:00:00Z");
    const cleared = reduceCancellation(silent, {
      type: "OBSERVE_PROVIDER_MANDATE",
      status: "CANCELLED",
      observedAt: "2026-11-08T02:00:00Z",
      nextBillingAt: null,
    });
    expect(cleared.providerMandateNextBillingAt).toBeNull();
    // An older observation never replaces a newer one, including its plan.
    const older = reduceCancellation(cleared, {
      type: "OBSERVE_PROVIDER_MANDATE",
      status: "ACTIVE",
      observedAt: "2026-11-07T00:00:00Z",
      nextBillingAt: "2026-11-08T10:00:00Z",
    });
    expect(older.providerMandateNextBillingAt).toBeNull();
    // A record written before this field existed is unchanged by an ordinary observation.
    expect(
      "providerMandateNextBillingAt" in
        reduceCancellation(base, {
          type: "OBSERVE_PROVIDER_MANDATE",
          status: "ACTIVE",
          observedAt: "2026-11-08T00:00:00Z",
        }),
    ).toBe(false);
  });
});

describe("CC03 time boundaries and representations", () => {
  it("charge initiated before cancellation but posted later is not a candidate", () => {
    const result = reconcile(
      confirmedSubscription(),
      charge({ eventTime: "2026-11-07T11:59:59Z", postedTime: "2026-11-08T12:00:00Z" }),
    );
    expect(result.classification).toBe("NO_ANOMALY");
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["CHARGE_BEFORE_CANCELLATION", "POSTED_AFTER_BUT_INITIATED_BEFORE"]),
    );
  });

  it("exact boundary equality needs review", () => {
    const result = reconcile(confirmedSubscription(), charge({ eventTime: EFFECTIVE }));
    expect(result.classification).toBe("NEEDS_REVIEW");
    expect(result.reasonCodes).toContain("BOUNDARY_EQUALITY");
  });

  it("equivalent instants in different offsets compare consistently", () => {
    const equalInOffset = reconcile(
      confirmedSubscription(),
      charge({ eventTime: "2026-11-07T07:00:00-05:00" }),
    );
    expect(equalInOffset.reasonCodes).toContain("BOUNDARY_EQUALITY");
    const laterInOffset = reconcile(
      confirmedSubscription(),
      charge({ eventTime: "2026-11-07T07:00:01-05:00" }),
    );
    expect(laterInOffset.classification).toBe("CANDIDATE_AFTER_CANCEL");
  });

  it("missing or offset-less event time needs review", () => {
    expect(reconcile(confirmedSubscription(), charge({ eventTime: null })).reasonCodes).toContain(
      "MISSING_EVENT_TIME",
    );
    expect(
      reconcile(confirmedSubscription(), charge({ eventTime: "2026-11-08T12:00:00" })).reasonCodes,
    ).toContain("INVALID_TIMESTAMP");
  });
});

describe("CC04 association rules", () => {
  it("merchant-name-only matching is not an association", () => {
    const result = reconcile(
      confirmedSubscription(),
      charge({ matchMethod: "merchant_name_only" }),
    );
    expect(result.classification).toBe("NEEDS_REVIEW");
    expect(result.reasonCodes).toContain("ASSOCIATION_UNRELIABLE");
  });
  it("another subscription, account or environment does not match", () => {
    expect(
      reconcile(confirmedSubscription(), charge({ subscriptionId: "fixture_sub_2" })).reasonCodes,
    ).toContain("DIFFERENT_SUBSCRIPTION");
    expect(
      reconcile(confirmedSubscription(), charge({ accountAlias: "buyer_other" })).reasonCodes,
    ).toContain("ACCOUNT_MISMATCH");
    expect(
      reconcile(confirmedSubscription(), charge({ environment: "sandbox" })).reasonCodes,
    ).toContain("ENVIRONMENT_MISMATCH");
  });
  it("missing association needs review", () => {
    const result = reconcile(
      confirmedSubscription(),
      charge({ subscriptionId: null, matchMethod: "none" }),
    );
    expect(result.classification).toBe("NEEDS_REVIEW");
    expect(result.reasonCodes).toContain("NO_ASSOCIATION");
  });
});

describe("CC05 statuses, refunds and exact decimals", () => {
  it("pending needs review; failed/reversed/zero/full refund open no payable claim", () => {
    expect(reconcile(confirmedSubscription(), charge({ status: "PENDING" })).classification).toBe(
      "NEEDS_REVIEW",
    );
    for (const status of ["FAILED", "DENIED", "REVERSED", "REFUNDED"] as const) {
      const r = reconcile(confirmedSubscription(), charge({ status }));
      expect(r.classification).toBe("NO_ANOMALY");
      expect(r.claimableCents).toBe(0);
    }
    const zero = reconcile(
      confirmedSubscription(),
      charge({ amount: { cents: 0, currency: "USD" } }),
    );
    expect(zero.classification).toBe("NO_ANOMALY");
    expect(zero.reasonCodes).toContain("ZERO_AMOUNT");
  });
  it("partial refund caps the remaining amount", () => {
    const r = reconcile(
      confirmedSubscription(),
      charge({ status: "PARTIALLY_REFUNDED", refundedCents: 500, refundStateKnown: true }),
    );
    expect(r.classification).toBe("CANDIDATE_AFTER_CANCEL");
    expect(r.claimableCents).toBe(1499);
    expect(r.reasonCodes).toContain("PARTIAL_REFUND_REDUCES_CLAIM");
  });
  it("unknown refund state blocks a payable amount but keeps the candidate visible", () => {
    const r = reconcile(
      confirmedSubscription(),
      charge({ refundStateKnown: false, refundedCents: null }),
    );
    expect(r.classification).toBe("CANDIDATE_AFTER_CANCEL");
    expect(r.claimableCents).toBeNull();
    expect(r.reasonCodes).toContain("REFUND_STATE_UNKNOWN");
  });
  it("non-USD needs review", () => {
    const r = reconcile(confirmedSubscription(), charge({ currency: "EUR" }));
    expect(r.reasonCodes).toContain("UNSUPPORTED_CURRENCY");
  });
  it("arrears or a service period ending before cancellation needs review", () => {
    expect(
      reconcile(confirmedSubscription(), charge({ arrearsIndicator: true })).reasonCodes,
    ).toContain("POSSIBLE_ARREARS");
    expect(
      reconcile(
        confirmedSubscription(),
        charge({
          servicePeriodStart: "2026-10-07T00:00:00Z",
          servicePeriodEnd: "2026-11-07T00:00:00Z",
        }),
      ).reasonCodes,
    ).toContain("SERVICE_PERIOD_BEFORE_CANCELLATION");
  });
});

describe("CC06 duplicate observations", () => {
  it("deduplicates reporting rows into one charge and ignores non-balance rows", () => {
    const rows = [
      {
        environment: "fixture",
        accountAlias: "a",
        refs: [{ kind: "seller_transaction_id", value: "T1" }],
        balanceAffecting: true,
        amount: 1999,
      },
      {
        environment: "fixture",
        accountAlias: "a",
        refs: [
          { kind: "seller_transaction_id", value: "T1" },
          { kind: "reporting_row_id", value: "R2" },
        ],
        balanceAffecting: true,
        amount: 1999,
      },
      {
        environment: "fixture",
        accountAlias: "a",
        refs: [{ kind: "reporting_row_id", value: "R3" }],
        balanceAffecting: false,
        amount: 1999,
      },
      {
        environment: "fixture",
        accountAlias: "a",
        refs: [{ kind: "seller_transaction_id", value: "T2" }],
        balanceAffecting: true,
        amount: 500,
      },
    ];
    const kept = dedupeChargeObservations(rows);
    expect(kept).toHaveLength(2);
    expect(kept.reduce((s, r) => s + r.amount, 0)).toBe(2499);
  });
  it("repeated reconciliation of the same inputs is idempotent", () => {
    const a = reconcile(confirmedSubscription(), charge());
    const b = reconcile(confirmedSubscription(), charge());
    expect(a).toEqual(b);
  });
});
