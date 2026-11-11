import { describe, expect, it } from "vitest";
import {
  mentionedReferences,
  renderDraftText,
  transactionReferenceLine,
  validateDraft,
  type DraftContent,
  type RoleSnapshot,
} from "@/domain";
import { MERCHANT_FIRST_CONTEXT, buildTemplateDraft } from "@/llm/fixture-drafter";
import { SYSTEM_PROMPT } from "@/llm/live-drafter";
import { maskIdsInText } from "@/server/services/case-view";
import type { AppContext } from "@/server/context";

/** The buyer's letter: what it says, how it ends, and which references it may name. */

function snapshot(overrides: Partial<RoleSnapshot> = {}): RoleSnapshot {
  return {
    version: 1,
    role: "buyer",
    environment: "fixture",
    caseId: "fixture_case_letter",
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
        at: "2026-11-08T12:00:00Z",
        cents: 1999,
        currency: "USD",
        text: "COMPLETED USD 19.99 charge by Example Studio",
        sourceIds: ["src_charge_email", "obs_charge_fx"],
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
        id: "src_charge_email",
        kind: "charge_record",
        label: "Payment notification",
        provenance: "synthetic",
        ownerRole: "buyer",
        visibility: "shared",
        sha256: "b".repeat(64),
        capturedAt: "2026-11-08T18:00:00Z",
        eventTime: null,
      },
      {
        id: "obs_charge_fx",
        kind: "provider_observation",
        label: "Simulated payment record (fixture)",
        provenance: "synthetic",
        ownerRole: "system",
        visibility: "shared",
        sha256: null,
        capturedAt: "2026-11-08T18:00:00Z",
        eventTime: "2026-11-08T12:00:00Z",
      },
    ],
    ...overrides,
  };
}

const RECORD_ID = "FX-TXN-SELLER-SYNTHETIC-2";
const references = { transactionIdsByFact: new Map([["fact_charge", [RECORD_ID]]]) };

function lettersText(draft: DraftContent): string {
  return draft.claims.map((c) => c.text).join("\n");
}

describe("the template letter", () => {
  it("says it comes first, without a raw basis label or a claim about replies", () => {
    const letter = buildTemplateDraft(snapshot(), "export_refund_request", "buyer", []);
    const text = lettersText(letter);
    expect(text).toContain(
      "The cancellation became effective on Nov 7, 2026 according to the confirmation I kept.",
    );
    expect(text).not.toContain("(merchant confirmation document kept by the buyer)");
    expect(text).not.toMatch(/not yet received|response about this charge/i);
    const context = letter.claims.filter((c) => c.kind === "context");
    expect(context.map((c) => c.text)).toEqual([MERCHANT_FIRST_CONTEXT]);
    expect(context[0]!.sourceIds).toEqual([]);
    expect(validateDraft(letter, snapshot(), "buyer", undefined, references).ok).toBe(true);
  });

  it("does not say it comes first once PayPal is involved", () => {
    const toPayPal = buildTemplateDraft(
      snapshot({ channel: "paypal" }),
      "buyer_create_dispute",
      "buyer",
      [],
    );
    expect(lettersText(toPayPal)).not.toContain(MERCHANT_FIRST_CONTEXT);
    const withCase = snapshot();
    withCase.facts.push({
      id: "fact_provider_case",
      kind: "provider_case",
      label: "Provider case",
      at: "2026-11-09T12:00:00Z",
      cents: null,
      currency: null,
      text: "simulated provider case, status OPEN",
      sourceIds: ["obs_charge_fx"],
      visibleTo: ["buyer", "merchant"],
    });
    const afterCase = buildTemplateDraft(withCase, "export_refund_request", "buyer", []);
    expect(lettersText(afterCase)).not.toContain(MERCHANT_FIRST_CONTEXT);
  });

  it("names the basis truthfully when there is no confirmation document", () => {
    const attested = snapshot();
    attested.facts[0] = { ...attested.facts[0]!, text: "user attestation without a document" };
    const text = lettersText(buildTemplateDraft(attested, "export_refund_request", "buyer", []));
    expect(text).toContain("effective on Nov 7, 2026 according to my own record.");
    expect(text).not.toContain("confirmation I kept");
  });
});

describe("the closing reference", () => {
  const letter = buildTemplateDraft(snapshot(), "export_refund_request", "buyer", []);

  it("ends the letter with the record's transaction ID and a short close", () => {
    const text = renderDraftText(letter, snapshot(), "Example Studio", "Alex Example", {
      transactionId: RECORD_ID,
    });
    expect(text).toContain(`${transactionReferenceLine(RECORD_ID)}\n\nThank you,\nAlex Example`);
    expect(transactionReferenceLine(RECORD_ID)).toBe(
      "Transaction ID: FX-TXN-SELLER-SYNTHETIC-2. Please confirm the refund within 7 days.",
    );
  });

  it("is left out without a record, and never closes the merchant's response", () => {
    expect(renderDraftText(letter, snapshot(), "Example Studio", "Alex Example")).not.toContain(
      "Transaction ID",
    );
    const merchant = buildTemplateDraft(
      snapshot({ role: "merchant" }),
      "merchant_provide_evidence",
      "merchant",
      [],
    );
    expect(
      renderDraftText(merchant, snapshot({ role: "merchant" }), "reviewer", "Example Studio", {
        transactionId: RECORD_ID,
      }),
    ).not.toContain("Transaction ID");
  });
});

describe("transaction IDs in drafted text", () => {
  function claiming(text: string, cites = true): DraftContent {
    const letter = buildTemplateDraft(snapshot(), "export_refund_request", "buyer", []);
    letter.claims.push({
      id: "c_ref",
      kind: "fact",
      text,
      sourceIds: cites ? ["obs_charge_fx"] : [],
      factIds: cites ? ["fact_charge"] : [],
    });
    return letter;
  }
  const refusals = (draft: DraftContent, scope = references) =>
    validateDraft(draft, snapshot(), "buyer", undefined, scope).issues.filter(
      (i) => i.code === "REFERENCE_MISMATCH",
    );

  it("accepts the ID the cited record carries", () => {
    expect(refusals(claiming(`The payment has transaction ID ${RECORD_ID}.`))).toEqual([]);
  });

  it("rejects an invented ID, in either form", () => {
    expect(refusals(claiming("The payment has transaction ID FX-TXN-INVENTED-9."))).toHaveLength(1);
    expect(refusals(claiming("PayPal lists it as 9AB12345CD6789012."))).toHaveLength(1);
    expect(refusals(claiming("The order number is 77421."))).toHaveLength(1);
  });

  it("rejects even the right ID when no record is known", () => {
    expect(
      refusals(claiming(`Transaction ID: ${RECORD_ID}.`), {
        transactionIdsByFact: new Map(),
      }),
    ).toHaveLength(1);
  });

  it("does not read ordinary words as references", () => {
    expect(
      mentionedReferences(
        "The payment record read from PayPal shows a payment notification for the November charge.",
      ),
    ).toEqual([]);
  });
});

describe("the model prompt", () => {
  it("carries the same rules as the template", () => {
    expect(SYSTEM_PROMPT).toContain("like Nov 7, 2026");
    expect(SYSTEM_PROMPT).toContain("Never write a transaction ID");
    expect(SYSTEM_PROMPT).toContain(MERCHANT_FIRST_CONTEXT);
    expect(SYSTEM_PROMPT).toContain("do not repeat a fact's text in parentheses");
    expect(SYSTEM_PROMPT).not.toContain("ISO dates like");
    expect(SYSTEM_PROMPT).toContain("The subject is checked like a claim");
  });
});

describe("recording mode", () => {
  const ctx = (recordingMode: boolean) => ({ config: { recordingMode } }) as unknown as AppContext;
  const refs = [
    { value: "5TY05013RG002845M", provenance: "sandbox_api" },
    { value: RECORD_ID, provenance: "synthetic" },
  ];

  it("masks a real ID inside the letter and leaves synthetic ones readable", () => {
    const mask = maskIdsInText(ctx(true), refs);
    expect(
      mask("Transaction ID: 5TY05013RG002845M. Please confirm the refund within 7 days."),
    ).toBe("Transaction ID: 5TY…45M. Please confirm the refund within 7 days.");
    expect(mask(`Transaction ID: ${RECORD_ID}.`)).toBe(`Transaction ID: ${RECORD_ID}.`);
    expect(maskIdsInText(ctx(false), refs)("ID 5TY05013RG002845M")).toBe("ID 5TY05013RG002845M");
  });
});
