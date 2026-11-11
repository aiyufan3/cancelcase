import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/context";
import { generateDraft } from "@/server/services/case-service";
import { buildCaseView } from "@/server/services/case-view";
import { MERCHANT_FIRST_CONTEXT } from "@/llm/fixture-drafter";

/** The refund request drafted on the fixture case, end to end through the service. */

let h: TestHarness;
afterEach(() => h?.cleanup());

describe("the drafted refund request", () => {
  it("ends with the transaction ID of the cited payment record and passes validation", async () => {
    h = createTestHarness();
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    expect(draft.validation.ok).toBe(true);
    expect(draft.renderedText).toContain(
      "Transaction ID: FX-TXN-SELLER-SYNTHETIC-2. Please confirm the refund within 7 days.\n\nThank you,",
    );
    expect(draft.content.claims.map((c) => c.text)).toContain(MERCHANT_FIRST_CONTEXT);
    expect(draft.renderedText).not.toMatch(/not yet received|kept by the buyer\)/);
    // Days in words, never raw ISO instants, in the letter itself.
    expect(draft.content.claims.map((c) => c.text).join(" ")).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    const view = buildCaseView(h.ctx, h.caseId, "buyer").drafts.export_refund_request!;
    expect(view.referenceLine).toBe(
      "Transaction ID: FX-TXN-SELLER-SYNTHETIC-2. Please confirm the refund within 7 days.",
    );
  });

  it("keeps the reference out of the drafted claims, where the validator would check it", async () => {
    h = createTestHarness();
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    expect(draft.content.claims.some((c) => c.text.includes("Transaction ID"))).toBe(false);
  });
});
