import { describe, expect, it } from "vitest";
import { providerReadSinceSent, sentNote, sentVersion } from "@/components/workbench/shared";
import type { CaseView } from "@/server/services/case-view";

type Status = "SUCCEEDED" | "FAILED" | "UNKNOWN" | "EXECUTING";

function view(opts: {
  action?: string;
  approvalDraftId?: string | null;
  consumedBy?: string | null;
  opStatus?: Status;
}): CaseView {
  const action = opts.action ?? "buyer_create_dispute";
  const approval =
    opts.approvalDraftId === null
      ? undefined
      : {
          id: "apr_1",
          action,
          draftId: opts.approvalDraftId ?? "draft_v2",
          decision: "approved",
          decidedAt: "2026-11-10T19:14:00.000Z",
          expiresAt: "2026-11-10T19:29:00.000Z",
          expired: true,
          consumedByOperationId: opts.consumedBy === undefined ? "op_1" : opts.consumedBy,
          revokedReason: null,
          usable: false,
        };
  return {
    approvals: approval ? { [action]: approval } : {},
    operations: [
      { id: "op_1", action, role: "buyer", status: opts.opStatus ?? "SUCCEEDED", attempts: 1 },
    ],
  } as unknown as CaseView;
}

describe("a draft version that was already sent", () => {
  it("is recognised only when its own approval was used by a request that succeeded", () => {
    expect(sentVersion(view({}), "buyer_create_dispute", "draft_v2")).toBe(true);
    for (const opStatus of ["FAILED", "UNKNOWN", "EXECUTING"] as const)
      expect(sentVersion(view({ opStatus }), "buyer_create_dispute", "draft_v2")).toBe(false);
    expect(sentVersion(view({ consumedBy: null }), "buyer_create_dispute", "draft_v2")).toBe(false);
    expect(sentVersion(view({ approvalDraftId: null }), "buyer_create_dispute", "draft_v2")).toBe(
      false,
    );
  });

  it("does not describe a newer version as sent", () => {
    expect(sentVersion(view({}), "buyer_create_dispute", "draft_v3")).toBe(false);
    expect(sentNote(view({}), "buyer_create_dispute", { id: "draft_v3", stale: true })).toBeNull();
  });

  it("says that later facts are not part of a sent request instead of asking to regenerate", () => {
    expect(sentNote(view({}), "buyer_create_dispute", { id: "draft_v2", stale: true })).toBe(
      "This version was sent. Facts recorded since then are not part of it; regenerate the draft only to prepare a new request.",
    );
    expect(sentNote(view({}), "buyer_create_dispute", { id: "draft_v2", stale: false })).toBe(
      "This version was sent. Regenerate the draft only to prepare a new request.",
    );
  });

  it("calls an export an export, because nothing was sent", () => {
    const v = view({ action: "export_refund_request" });
    expect(sentNote(v, "export_refund_request", { id: "draft_v2", stale: false })).toBe(
      "This version was exported. Regenerate the draft only to prepare a new request.",
    );
  });

  it("leaves a draft that was never sent to the server's own blocker", () => {
    expect(
      sentNote(view({ opStatus: "FAILED" }), "buyer_create_dispute", {
        id: "draft_v2",
        stale: true,
      }),
    ).toBeNull();
  });
});

describe("PayPal activity after a version was sent", () => {
  function withProvider(observedAt: string | null, provenance = "sandbox_api", action?: string) {
    const v = view({ action }) as unknown as {
      operations: { createdAt?: string; updatedAt?: string }[];
      provider: unknown;
    };
    v.operations[0]!.createdAt = "2026-11-10T19:15:10.000Z";
    v.operations[0]!.updatedAt = "2026-11-10T19:15:13.150Z";
    v.provider = observedAt === null ? null : { observedAt, provenance };
    return v as unknown as CaseView;
  }

  it("reports a read of the provider case made after the request", () => {
    expect(
      providerReadSinceSent(
        withProvider("2026-11-11T02:08:20.747Z"),
        "buyer_create_dispute",
        "draft_v2",
      ),
    ).toEqual({ readAt: "2026-11-11T02:08:20.747Z", simulated: false });
    expect(
      providerReadSinceSent(
        withProvider("2026-11-10T19:15:12.000Z", "synthetic"),
        "buyer_create_dispute",
        "draft_v2",
      ),
    ).toEqual({ readAt: "2026-11-10T19:15:12.000Z", simulated: true });
  });

  it("reports nothing without a later read, for an export, or for a version never sent", () => {
    expect(
      providerReadSinceSent(
        withProvider("2026-11-10T19:00:00.000Z"),
        "buyer_create_dispute",
        "draft_v2",
      ),
    ).toBeNull();
    expect(
      providerReadSinceSent(withProvider(null), "buyer_create_dispute", "draft_v2"),
    ).toBeNull();
    expect(
      providerReadSinceSent(
        withProvider("2026-11-11T02:08:20.747Z", "sandbox_api", "export_refund_request"),
        "export_refund_request",
        "draft_v2",
      ),
    ).toBeNull();
    expect(
      providerReadSinceSent(
        withProvider("2026-11-11T02:08:20.747Z"),
        "buyer_create_dispute",
        "draft_v3",
      ),
    ).toBeNull();
  });
});
