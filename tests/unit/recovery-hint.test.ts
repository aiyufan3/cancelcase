import { describe, expect, it } from "vitest";
import { recoveryHint } from "@/components/workbench/CaseOverview";
import type { CaseView } from "@/server/services/case-view";

const view = (provider: { status: string | null; outcome?: string | null } | null) =>
  ({ provider: provider ? { outcome: null, ...provider } : null }) as unknown as CaseView;

describe("the hint shown while nothing has been recovered", () => {
  it("says no refund was read back when there is no provider case", () => {
    expect(recoveryHint(view(null))).toBe("No refund read back yet");
  });

  it("restates the provider case as read", () => {
    expect(recoveryHint(view({ status: "WAITING_FOR_SELLER_RESPONSE" }))).toBe(
      "Awaiting seller response",
    );
    expect(recoveryHint(view({ status: "WAITING_FOR_BUYER_RESPONSE" }))).toBe(
      "Awaiting buyer response",
    );
    expect(recoveryHint(view({ status: "UNDER_REVIEW" }))).toBe("Case under review");
    expect(recoveryHint(view({ status: "OPEN" }))).toBe("Case open");
  });

  it("names a decision only as read, and never claims a refund", () => {
    expect(recoveryHint(view({ status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" }))).toBe(
      "Decided in the seller's favour",
    );
    expect(recoveryHint(view({ status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR" }))).toBe(
      "Decided in the buyer's favour; no refund read back yet",
    );
    expect(recoveryHint(view({ status: "RESOLVED", outcome: null }))).toBe("Case resolved");
  });

  it("falls back to the neutral hint for any other status", () => {
    expect(recoveryHint(view({ status: null }))).toBe("No refund read back yet");
    expect(recoveryHint(view({ status: "SOMETHING_NEW" }))).toBe("No refund read back yet");
  });
});
