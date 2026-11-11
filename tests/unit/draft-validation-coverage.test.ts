import { describe, expect, it } from "vitest";
import { validateDraft, type DraftContent, type RoleSnapshot } from "@/domain";
import { mentionedAmounts, mentionedInstants } from "@/domain/claims";
import { buildTemplateDraft } from "@/llm/fixture-drafter";

/**
 * What the validator checks is the same wherever a statement is written and however it is
 * formatted: the subject is held to the rules of the body, amounts are read in every supported
 * dollar form, months in any letter case, and a date that cannot be read is refused, not skipped.
 */

function snapshot(): RoleSnapshot {
  return {
    version: 1,
    role: "buyer",
    environment: "fixture",
    caseId: "fixture_case_coverage",
    channel: "merchant_refund",
    currency: "USD",
    claimableCents: 1999,
    requestedCents: 1999,
    contactHistory: [],
    gaps: [],
    facts: [
      {
        id: "fact_cancel_effective",
        kind: "cancellation_effective",
        label: "Cancellation effective",
        at: "2026-11-07T12:00:00Z",
        cents: null,
        currency: null,
        text: "merchant confirmation document kept by the buyer",
        sourceIds: ["src_cancel_email"],
        visibleTo: ["buyer", "merchant"],
      },
      {
        id: "fact_charge",
        kind: "charge",
        label: "Charge",
        at: "2026-11-08T16:31:47Z",
        cents: 1999,
        currency: "USD",
        text: "COMPLETED USD 19.99 charge",
        sourceIds: ["src_charge_record"],
        visibleTo: ["buyer", "merchant"],
      },
    ],
    sources: [
      {
        id: "src_cancel_email",
        kind: "cancellation_confirmation",
        label: "Cancellation confirmation email",
        provenance: "synthetic",
        ownerRole: "buyer",
        visibility: "shared",
        sha256: "a".repeat(64),
        capturedAt: "2026-11-06T09:45:00Z",
        eventTime: null,
      },
      {
        id: "src_charge_record",
        kind: "charge_record",
        label: "Charge record",
        provenance: "synthetic",
        ownerRole: "buyer",
        visibility: "shared",
        sha256: "b".repeat(64),
        capturedAt: "2026-11-08T18:00:00Z",
        eventTime: null,
      },
    ],
  };
}

function draft(chargeText: string, subject = "Refund request"): DraftContent {
  return {
    action: "export_refund_request",
    role: "buyer",
    subject,
    attachmentEvidenceIds: [],
    claims: [
      {
        id: "c1",
        kind: "fact",
        text: "The cancellation took effect on Nov 7, 2026.",
        sourceIds: ["src_cancel_email"],
        factIds: ["fact_cancel_effective"],
      },
      {
        id: "c2",
        kind: "fact",
        text: chargeText,
        sourceIds: ["src_charge_record"],
        factIds: ["fact_charge"],
      },
    ],
  };
}

const GOOD = "A charge of $19.99 was completed on Nov 8, 2026.";
const codes = (d: DraftContent) =>
  validateDraft(d, snapshot(), "buyer")
    .issues.filter((i) => i.blocking)
    .map((i) => `${i.claimId ?? "subject"}:${i.code}`);

describe("the baseline still passes", () => {
  it("accepts a correct letter, a correct subject and the template", () => {
    expect(codes(draft(GOOD))).toEqual([]);
    expect(
      codes(draft(GOOD, "Charge after subscription cancellation — $19.99 on 2026-11-08")),
    ).toEqual([]);
    const template = buildTemplateDraft(snapshot(), "export_refund_request", "buyer", []);
    expect(validateDraft(template, snapshot(), "buyer").ok).toBe(true);
  });

  it("accepts every supported way of writing the same correct amount and date", () => {
    for (const text of [
      "A charge of USD 19.99 was completed on 8 November 2026.",
      "A charge of 19.99 USD was completed on november 8th, 2026.",
      "A charge of US$19.99 was completed on NOV 8, 2026 at 4:31 PM UTC.",
      "A charge of 19.99 dollars was completed on 2026-11-08T16:31:47Z.",
      "A charge of $19.99 was completed on Nov 8 at 16:31 UTC.",
      "A charge of $19.99 was completed on 2026-11-08T11:31:47-05:00.",
    ])
      expect(codes(draft(text)), text).toEqual([]);
  });
});

describe("the subject is held to the rules of the body", () => {
  it("rejects a wrong amount, a wrong date and a refund guarantee in the subject", () => {
    expect(codes(draft(GOOD, "Refund of $999.99"))).toEqual(["subject:AMOUNT_MISMATCH"]);
    expect(codes(draft(GOOD, "Charge on Nov 30, 2030"))).toEqual(["subject:DATE_MISMATCH"]);
    expect(codes(draft(GOOD, "Guaranteed refund"))).toEqual(["subject:UNSUPPORTED_CERTAINTY"]);
    expect(codes(draft(GOOD, "You will receive a full refund"))).toEqual([
      "subject:OUTCOME_PROMISE",
    ]);
    expect(codes(draft(GOOD, "Transaction ID: 9XY12345AB678901C"))).toEqual([
      "subject:REFERENCE_MISMATCH",
    ]);
  });
});

describe("a wrong amount is caught in every dollar form", () => {
  it.each([
    "A charge of USD 999.99 was completed on Nov 8, 2026.",
    "A charge of 999.99 USD was completed on Nov 8, 2026.",
    "A charge of US$999.99 was completed on Nov 8, 2026.",
    "A charge of 999.99 dollars was completed on Nov 8, 2026.",
    "A charge of $1,999.00 was completed on Nov 8, 2026.",
  ])("rejects %s", (text) => {
    expect(codes(draft(text))).toEqual(["c2:AMOUNT_MISMATCH"]);
  });

  it("refuses an amount it cannot compare, without guessing", () => {
    // Three decimals, and a currency the facts do not use: neither is rounded or converted.
    expect(codes(draft("A charge of $19.999 was completed on Nov 8, 2026."))).toEqual([
      "c2:AMOUNT_MISMATCH",
    ]);
    expect(codes(draft("A charge of €19.99 was completed on Nov 8, 2026."))).toEqual([
      "c2:AMOUNT_MISMATCH",
    ]);
    expect(codes(draft("A charge of 19.99 EUR was completed on Nov 8, 2026."))).toEqual([
      "c2:AMOUNT_MISMATCH",
    ]);
  });

  it("reads each written amount once and leaves bare numbers alone", () => {
    expect(mentionedAmounts("$19.99 USD, then USD 5 and 1,250.50 dollars")).toEqual([
      { cents: 1999, text: "$19.99", problem: null },
      { cents: 500, text: "USD 5", problem: null },
      { cents: 125050, text: "1,250.50 dollars", problem: null },
    ]);
    expect(mentionedAmounts("Version 2.5 of plan 1999, 3 payments.")).toEqual([]);
  });
});

describe("a wrong date is caught in every supported form", () => {
  it.each([
    "A charge of $19.99 was completed on nov 30, 2030.",
    "A charge of $19.99 was completed on NOVEMBER 30, 2030.",
    "A charge of $19.99 was completed on 30 november 2030.",
    "A charge of $19.99 was completed on Nov 30.",
    "A charge of $19.99 was completed on 2030-11-30.",
  ])("rejects %s", (text) => {
    expect(codes(draft(text))).toEqual(["c2:DATE_MISMATCH"]);
  });

  it("refuses a date or time that cannot exist, in place of skipping it", () => {
    for (const text of [
      "A charge of $19.99 was completed on 2026-11-31T25:61:00Z.",
      "A charge of $19.99 was completed on 2026-02-30T10:00:00Z.",
      "A charge of $19.99 was completed on 2026-13-45.",
      "A charge of $19.99 was completed on Feb 30, 2026.",
      "A charge of $19.99 was completed on Nov 8, 2026 at 25:61 UTC.",
    ])
      expect(codes(draft(text)), text).toEqual(["c2:DATE_MISMATCH"]);
    expect(mentionedInstants("2026-11-31T25:61:00Z")[0]).toMatchObject({ problem: "invalid" });
  });

  it("refuses a form it cannot compare: a numeric date, or a time in another zone", () => {
    for (const text of [
      "A charge of $19.99 was completed on 11/08/2026.",
      "A charge of $19.99 was completed on 08.11.2026.",
      "A charge of $19.99 was completed on Nov 8, 2026 at 11:31 AM EST.",
    ])
      expect(codes(draft(text)), text).toEqual(["c2:DATE_MISMATCH"]);
  });

  it("compares times in UTC to the minute, and to the second only when seconds are written", () => {
    // The fact is 16:31:47 UTC.
    expect(codes(draft("A charge of $19.99 was completed on Nov 8, 2026 at 4:31 PM UTC."))).toEqual(
      [],
    );
    expect(codes(draft("A charge of $19.99 was completed on Nov 8, 2026 at 4:32 PM UTC."))).toEqual(
      ["c2:DATE_MISMATCH"],
    );
    expect(codes(draft("A charge of $19.99 was completed on 2026-11-08T16:31:47Z."))).toEqual([]);
    expect(codes(draft("A charge of $19.99 was completed on 2026-11-08T16:31:05Z."))).toEqual([
      "c2:DATE_MISMATCH",
    ]);
    expect(codes(draft("A charge of $19.99 was completed on 2026-11-08T16:31Z."))).toEqual([]);
  });

  it("does not read the verb may as a month", () => {
    expect(
      codes(draft("A charge of $19.99 was completed; 2 may follow, and it may 3 times.")),
    ).toEqual([]);
  });
});
