import { describe, expect, it } from "vitest";
import { validateDraft, type DraftContent, type RoleSnapshot } from "@/domain";
import { mentionedInstants } from "@/domain/claims";
import { formatUtc, sameUtcDay } from "@/domain/time";
import { buildTemplateDraft } from "@/llm/fixture-drafter";
import { formatClock, formatDay, formatInstant } from "@/components/ui";

/**
 * Dates are shown and written for people ("Nov 10, 2026"), while every check still compares the
 * canonical UTC instants of the facts.
 */

function snapshot(
  instants: { cancelEffective: string; charge: string } = {
    cancelEffective: "2026-11-07T12:00:00Z",
    charge: "2026-11-08T12:00:00Z",
  },
): RoleSnapshot {
  return {
    version: 1,
    role: "buyer",
    environment: "fixture",
    caseId: "fixture_case_dates",
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
        at: instants.cancelEffective,
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
        at: instants.charge,
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

function draftSaying(text: string, factId = "fact_charge"): DraftContent {
  const sourceId = factId === "fact_charge" ? "src_charge_record" : "src_cancel_email";
  return {
    action: "export_refund_request",
    role: "buyer",
    subject: "Refund request",
    attachmentEvidenceIds: [],
    claims: [
      {
        id: "c1",
        kind: "fact",
        text: "The cancellation took effect as the confirmation shows.",
        sourceIds: ["src_cancel_email"],
        factIds: ["fact_cancel_effective"],
      },
      { id: "c2", kind: "fact", text, sourceIds: [sourceId], factIds: [factId] },
    ],
  };
}

function dateIssues(text: string, snap = snapshot(), factId = "fact_charge"): string[] {
  return validateDraft(draftSaying(text, factId), snap, "buyer")
    .issues.filter((i) => i.code === "DATE_MISMATCH")
    .map((i) => i.message);
}

describe("formatUtc", () => {
  it("writes the day in words, and the time only when asked", () => {
    expect(formatUtc("2026-11-10T16:31:47.000Z")).toBe("Nov 10, 2026");
    expect(formatUtc("2026-11-10T16:31:47.000Z", { time: true })).toBe(
      "Nov 10, 2026 at 4:31 PM UTC",
    );
    expect(formatUtc("2026-11-11T00:00:00Z", { time: true })).toBe("Nov 11, 2026 at 12:00 AM UTC");
    expect(formatUtc("2026-11-11T12:05:00Z", { time: true })).toBe("Nov 11, 2026 at 12:05 PM UTC");
    expect(formatUtc("2026-11-10")).toBe("Nov 10, 2026");
  });

  it("uses the UTC day, whatever the offset the instant was written with", () => {
    // 23:30 in New York on Nov 10 is already Nov 11 in UTC.
    expect(formatUtc("2026-11-10T23:30:00-05:00")).toBe("Nov 11, 2026");
    expect(formatUtc("2026-11-10T23:30:00-05:00", { time: true })).toBe(
      "Nov 11, 2026 at 4:30 AM UTC",
    );
    expect(sameUtcDay("2026-11-10T07:43:01Z", "2026-11-10T16:31:47.000Z")).toBe(true);
    expect(sameUtcDay("2026-11-10T23:30:00-05:00", "2026-11-10T12:00:00Z")).toBe(false);
  });

  it("gives the views a day, a time of day, or both", () => {
    expect(formatDay("2026-11-10T16:31:47.000Z")).toBe("Nov 10, 2026");
    expect(formatClock("2026-11-10T16:31:47.000Z")).toBe("4:31 PM UTC");
    expect(formatInstant("2026-11-10T16:31:47.000Z")).toBe("Nov 10, 2026 at 4:31 PM UTC");
    expect(formatInstant(null)).toBe("—");
  });

  it("refuses values that are not instants with an explicit offset", () => {
    expect(formatUtc(null)).toBeNull();
    expect(formatUtc("")).toBeNull();
    expect(formatUtc("2026-11-10T16:31:47")).toBeNull();
    expect(formatUtc("next Tuesday")).toBeNull();
  });
});

describe("the validator reads written dates", () => {
  it("accepts the formatted form of the cited fact's date", () => {
    expect(dateIssues("A charge of $19.99 was completed on Nov 8, 2026.")).toEqual([]);
    expect(dateIssues("A charge of $19.99 was completed on November 8, 2026.")).toEqual([]);
    expect(dateIssues("A charge of $19.99 was completed on 8 Nov 2026.")).toEqual([]);
    expect(dateIssues("A charge of $19.99 was completed on 2026-11-08.")).toEqual([]);
  });

  it("rejects a formatted date that is not the cited fact's date", () => {
    expect(dateIssues("A charge of $19.99 was completed on Nov 9, 2026.")).toHaveLength(1);
    expect(dateIssues("A charge of $19.99 was completed on 9 November 2026.")).toHaveLength(1);
    // A real date of another fact must still be cited from that fact.
    expect(dateIssues("A charge of $19.99 was completed on Nov 7, 2026.")).toEqual([
      "Date 2026-11-07 is not part of the facts this claim cites; cite the fact it comes from.",
    ]);
  });

  it("checks a written time against the cited fact, in UTC", () => {
    expect(dateIssues("The charge was completed on Nov 8, 2026 at 12:00 PM UTC.")).toEqual([]);
    expect(dateIssues("The charge was completed at 12:00 PM UTC.")).toEqual([]);
    expect(dateIssues("The charge was completed on Nov 8, 2026 at 1:00 PM UTC.")).toHaveLength(1);
    expect(dateIssues("The charge was completed at 2026-11-08T12:00:00Z.")).toEqual([]);
    expect(dateIssues("The charge was completed at 2026-11-08T13:15:00Z.")).toHaveLength(1);
  });

  it("compares in UTC at the edge of a day", () => {
    // The charge is 03:30 UTC on Nov 11, which is still Nov 10 in New York.
    const late = snapshot({
      cancelEffective: "2026-11-10T07:43:01Z",
      charge: "2026-11-11T03:30:00Z",
    });
    expect(dateIssues("A charge of $19.99 was completed on Nov 11, 2026.", late)).toEqual([]);
    expect(dateIssues("A charge of $19.99 was completed on Nov 10, 2026.", late)).toHaveLength(1);
    // The same instant written with a New York offset is the same moment.
    expect(dateIssues("The charge was completed at 2026-11-10T22:30:00-05:00.", late)).toEqual([]);
    // A New York wall-clock time read as UTC is not the time of the charge.
    expect(
      dateIssues("The charge was completed on Nov 11, 2026 at 10:30 PM UTC.", late),
    ).toHaveLength(1);
  });

  it("does not read amounts, ratios or versions as times", () => {
    expect(mentionedInstants("Refund $19.99, version 2:1 of the plan.")).toEqual([]);
    expect(mentionedInstants("Nov 10, 2026 at 4:31 PM UTC")).toEqual([
      {
        day: "2026-11-10",
        monthDay: null,
        minute: 16 * 60 + 31,
        second: null,
        problem: null,
        text: "Nov 10, 2026 at 4:31 PM UTC",
      },
    ]);
  });
});

describe("the template writes dates for people", () => {
  it("writes days in words and adds times only when the order needs them", () => {
    const apart = buildTemplateDraft(snapshot(), "export_refund_request", "buyer", []);
    const text = apart.claims.map((c) => c.text).join("\n");
    expect(text).toContain("effective on Nov 7, 2026 ");
    expect(text).toContain("completed on Nov 8, 2026,");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(text).not.toContain(" UTC");

    const sameDay = snapshot({
      cancelEffective: "2026-11-10T07:43:01Z",
      charge: "2026-11-10T16:31:47.000Z",
    });
    const close = buildTemplateDraft(sameDay, "export_refund_request", "buyer", []);
    const closeText = close.claims.map((c) => c.text).join("\n");
    expect(closeText).toContain("effective on Nov 10, 2026 at 7:43 AM UTC");
    expect(closeText).toContain("completed on Nov 10, 2026 at 4:31 PM UTC");
    expect(validateDraft(close, sameDay, "buyer").ok).toBe(true);
  });
});
