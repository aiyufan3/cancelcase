import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/context";
import { SandboxAdapter } from "@/paypal/sandbox-adapter";
import { PayPalRestClient } from "@/paypal/rest-client";
import { cases } from "@/server/db/repos";
import { decideApproval, generateDraft, requireBundle } from "@/server/services/case-service";
import { dispatchOperation, prepareOperation } from "@/server/services/operation-service";
import { buildActionPayload } from "@/server/services/payloads";
import { buildCaseView } from "@/server/services/case-view";

// Synthetic counterpart of the merchant chargeback read: never a connected request.
const DISPUTE = {
  dispute_id: "PP-SYN-REFUND-1",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_life_cycle_stage: "CHARGEBACK",
  reason: "CREDIT_NOT_PROCESSED",
  dispute_amount: { value: "27.42", currency_code: "USD" },
  create_time: "2026-11-09T08:00:00Z",
  seller_response_due_date: "2026-11-19T09:00:00Z",
  disputed_transactions: [
    {
      seller_transaction_id: "SELLER-SYN-1",
      buyer_transaction_id: "BUYER-SYN-1",
      create_time: "2026-11-08T10:00:00Z",
      transaction_status: "COMPLETED",
      gross_amount: { value: "27.42", currency_code: "USD" },
    },
  ],
  evidences: ["PROOF_OF_REFUND", "OTHER"].map((evidence_type) => ({
    evidence_type,
    source: "REQUESTED_FROM_SELLER",
  })),
  links: [
    {
      rel: "provide_evidence",
      method: "POST",
      href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-SYN-REFUND-1/provide-evidence",
    },
    {
      rel: "accept_claim",
      method: "POST",
      href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-SYN-REFUND-1/accept-claim",
    },
  ],
};

let h: TestHarness;
afterEach(() => h?.cleanup());

function connectedAdapter(readBody: unknown = DISPUTE, confirmCancellation = true) {
  h = createTestHarness({ confirmCancellation });
  const calls: string[] = [];
  let readsBeforeWrite = -1;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method} ${url}`);
    let body: unknown;
    if (url.endsWith("/v1/oauth2/token"))
      body = { access_token: "synthetic-token", expires_in: 3600 };
    else if (init?.method === "POST") {
      readsBeforeWrite = calls.filter((c) => c.startsWith("GET ")).length;
      body = { links: [] };
    } else body = readBody;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const adapter = new SandboxAdapter(
    new PayPalRestClient(
      {
        baseUrl: "https://api-m.sandbox.paypal.com",
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
      },
      h.clock,
      fetchImpl,
    ),
    h.clock,
    {
      clientId: "synthetic-client",
      buyerEmail: null,
      buyerDisputesEnabled: false,
    },
  );
  h.ctx.adapter = adapter;
  cases.update(h.ctx.db, {
    ...requireBundle(h.ctx, h.caseId).caseRecord,
    providerObservation: adapter.mapDispute(DISPUTE, h.clock.now().toISOString()).observation,
  });
  return { calls, adapter, readsBeforeWrite: () => readsBeforeWrite };
}

async function prepareMerchant() {
  const draft = await generateDraft(h.ctx, {
    caseId: h.caseId,
    role: "merchant",
    action: "merchant_provide_evidence",
  });
  const approval = decideApproval(h.ctx, {
    caseId: h.caseId,
    role: "merchant",
    action: "merchant_provide_evidence",
    draftId: draft.id,
    decision: "approved",
  });
  return prepareOperation(h.ctx, {
    caseId: h.caseId,
    role: "merchant",
    action: "merchant_provide_evidence",
    approvalId: approval.id,
  }).operation;
}

describe("authoritative merchant preflight (CC13, CC17, CC18)", () => {
  it("preserves the synthetic real-shape chargeback fields and simulation capability (CC18)", () => {
    const { adapter } = connectedAdapter();
    const mapped = adapter.mapDispute(DISPUTE, h.clock.now().toISOString());
    expect(mapped.observation).toMatchObject({
      status: "WAITING_FOR_SELLER_RESPONSE",
      stage: "CHARGEBACK",
      reason: "CREDIT_NOT_PROCESSED",
      sellerResponseDueAt: DISPUTE.seller_response_due_date,
      requestedEvidenceTypes: ["PROOF_OF_REFUND", "OTHER"],
      allowedActions: ["provide_evidence", "accept_claim"],
      enumsUnderstood: true,
    });
    expect(mapped.summary.transaction).toEqual({
      sellerTransactionId: "SELLER-SYN-1",
      buyerTransactionId: "BUYER-SYN-1",
      createTime: "2026-11-08T10:00:00Z",
      status: "COMPLETED",
      grossValue: "27.42",
      grossCurrency: "USD",
    });
    const later = adapter.mapDispute(
      {
        ...DISPUTE,
        status: "UNDER_REVIEW",
        links: [
          {
            rel: "require_evidence",
            method: "POST",
            href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-SYN-REFUND-1/require-evidence",
          },
        ],
      },
      h.clock.now().toISOString(),
    );
    expect(later.observation.allowedActions).toEqual(["require_evidence"]);
    expect(later.summary.rejectedLinks).toEqual([]);
  });

  it("uses OTHER in payload and preview when cancellation details are requested without proof (CC17)", async () => {
    connectedAdapter(DISPUTE, false);
    const bundle = requireBundle(h.ctx, h.caseId);
    cases.update(h.ctx.db, {
      ...bundle.caseRecord,
      providerObservation: {
        ...bundle.caseRecord.providerObservation!,
        requestedEvidenceTypes: ["CANCELLATION_DETAILS"],
      },
    });
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
    });
    expect(
      buildActionPayload(
        h.ctx,
        requireBundle(h.ctx, h.caseId),
        draft,
        "merchant",
        "merchant_provide_evidence",
      ),
    ).toMatchObject({ evidenceType: "OTHER" });
    expect(buildCaseView(h.ctx, h.caseId, "merchant").provider?.evidenceTypeToSend).toBe("OTHER");
  });

  it("makes one provider preread before final approval verification and one readback", async () => {
    const provider = connectedAdapter();
    const result = await dispatchOperation(h.ctx, (await prepareMerchant()).id);
    expect(result.status).toBe("SUCCEEDED");
    expect(provider.readsBeforeWrite()).toBe(1);
    expect(provider.calls.filter((c) => c.startsWith("GET "))).toHaveLength(2);
    expect(provider.calls.filter((c) => c.includes("/provide-evidence"))).toHaveLength(1);
  });

  it.each([
    { status: "UNDER_REVIEW", links: [] },
    { status: "WAITING_FOR_SELLER_RESPONSE", links: [] },
  ])("refuses a fresh ineligible provider read before any write: %j", async (change) => {
    const provider = connectedAdapter({ ...DISPUTE, ...change });
    const result = await dispatchOperation(h.ctx, (await prepareMerchant()).id);
    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("CAPABILITY_BLOCKED");
    expect(provider.calls.some((c) => c.includes("/provide-evidence"))).toBe(false);
  });
});
