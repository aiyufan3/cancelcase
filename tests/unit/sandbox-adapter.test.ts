import { describe, expect, it } from "vitest";
import {
  PayPalRestClient,
  buildBuyerAuthAssertion,
  buildBuyerConsentUrl,
  SCOPES,
} from "@/paypal/rest-client";
import { SandboxAdapter, providerDateTime } from "@/paypal/sandbox-adapter";
import type { ToolkitHandle } from "@/paypal/toolkit";
import { fixedClock } from "@/domain/time";

/**
 * The Sandbox adapter is exercised against a scripted fetch. These tests pin the request
 * shapes documented by PayPal (token, multipart create-dispute with PayPal-Auth-Assertion,
 * provide-evidence multipart with an `input` part) and the failure classification rules.
 * They are test doubles, not provider verification.
 */

type Scripted = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  throws?: Error;
};

function scriptedFetch(
  script: Scripted[],
  calls: { url: string; init: RequestInit }[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const step = script.shift();
    calls.push({ url: String(input), init: init ?? {} });
    if (!step) throw new Error("unexpected fetch call");
    if (step.throws) throw step.throws;
    const headers = new Headers({ "content-type": "application/json", ...(step.headers ?? {}) });
    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
      status: step.status,
      headers,
    });
  }) as typeof fetch;
}

const TOKEN = {
  status: 200,
  body: {
    access_token: "A21AAtoken",
    token_type: "Bearer",
    expires_in: 3600,
    scope: `${SCOPES.disputesReadSeller} ${SCOPES.subscriptions}`,
    app_id: "APP-123",
  },
};
const clock = fixedClock("2026-11-09T10:00:00Z");

function client(script: Scripted[], calls: { url: string; init: RequestInit }[]) {
  return new PayPalRestClient(
    { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "cid", clientSecret: "csecret" },
    clock,
    scriptedFetch(script, calls),
  );
}

describe("rest client", () => {
  it("refuses OAuth redirects without a second credential-bearing request (CC18)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      // Model fetch's default redirect following without performing network I/O.
      if (init?.redirect !== "manual" && init?.redirect !== "error") {
        calls.push({ url: "https://redirect.example.invalid/token", init: init ?? {} });
        return new Response(JSON.stringify({ access_token: "synthetic-redirect-token" }));
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://redirect.example.invalid/token" },
      });
    }) as typeof fetch;
    const c = new PayPalRestClient(
      {
        baseUrl: "https://api-m.sandbox.paypal.com",
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
      },
      clock,
      fetchImpl,
    );
    const result = await c.getToken();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNEXPECTED_REDIRECT");
      expect(result.ambiguous).toBe(false);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("refuses non-sandbox origins at construction", () => {
    expect(
      () =>
        new PayPalRestClient(
          { baseUrl: "https://api-m.paypal.com", clientId: "a", clientSecret: "b" },
          clock,
        ),
    ).toThrow(/Sandbox/);
  });

  it("issues a token with basic auth and exposes scopes without the token value", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const c = client([TOKEN], calls);
    const t = await c.getToken();
    expect(t.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    expect(c.grantedScopes()).toContain(SCOPES.disputesReadSeller);
  });

  it("retries reads on 5xx with bounded attempts and refreshes once on 401, but never retries writes", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const c = client(
      [
        TOKEN,
        { status: 503, body: { name: "SERVICE_UNAVAILABLE" }, headers: { "retry-after": "0" } },
        { status: 200, body: { items: [] } },
      ],
      calls,
    );
    const r = await c.read<{ items: unknown[] }>("/v1/customer/disputes?page_size=1");
    expect(r.ok).toBe(true);
    expect(calls.filter((x) => x.url.includes("/v1/customer/disputes")).length).toBe(2);

    const calls2: { url: string; init: RequestInit }[] = [];
    const c2 = client(
      [
        TOKEN,
        { status: 401, body: { error: "invalid_token" } },
        TOKEN,
        { status: 200, body: { ok: true } },
      ],
      calls2,
    );
    const r2 = await c2.read<{ ok: boolean }>("/v1/billing/plans?page_size=1");
    expect(r2.ok).toBe(true);

    const calls3: { url: string; init: RequestInit }[] = [];
    const c3 = client(
      [TOKEN, { status: 500, body: { name: "INTERNAL_SERVER_ERROR", debug_id: "dbg-1" } }],
      calls3,
    );
    const w = await c3.write("POST", "/v1/customer/disputes/PP-D-1/provide-evidence", { json: {} });
    expect(w.ok).toBe(false);
    if (!w.ok) {
      expect(w.ambiguous).toBe(true);
      expect(w.error.correlationId).toBe("dbg-1");
    }
    expect(calls3.filter((x) => x.url.includes("provide-evidence")).length).toBe(1);
  });

  it("classifies 4xx writes as definitive failures with redacted details and treats timeouts as ambiguous", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const c = client(
      [
        TOKEN,
        {
          status: 422,
          body: {
            name: "UNPROCESSABLE_ENTITY",
            message: "Bad input for buyer@example.com",
            details: [{ field: "/reason", issue: "INVALID_PARAMETER_VALUE" }],
            debug_id: "dbg-2",
          },
        },
      ],
      calls,
    );
    const w = await c.write("POST", "/v1/customer/disputes", { json: {} });
    expect(w.ok).toBe(false);
    if (!w.ok) {
      expect(w.ambiguous).toBe(false);
      expect(w.error.code).toBe("UNPROCESSABLE_ENTITY");
      expect(w.error.message).not.toContain("buyer@example.com");
      expect(w.error.message).toContain("INVALID_PARAMETER_VALUE");
    }
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const c2 = client([TOKEN, { status: 0, throws: abort }], []);
    const w2 = await c2.write("POST", "/v1/customer/disputes", { json: {} });
    expect(w2.ok).toBe(false);
    if (!w2.ok) {
      expect(w2.ambiguous).toBe(true);
      expect(w2.error.code).toBe("NETWORK_TIMEOUT");
    }
  });

  it("never follows redirects with credentials and rejects foreign absolute URLs", async () => {
    const c = client([TOKEN, { status: 302, headers: { location: "https://evil.example/x" } }], []);
    const r = await c.request("GET", "/v1/customer/disputes/PP-D-1", { kind: "read" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("UNEXPECTED_REDIRECT");
    const c2 = client([TOKEN], []);
    const r2 = await c2.request("GET", "https://api-m.paypal.com/v1/customer/disputes", {
      kind: "read",
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("builds the Sandbox buyer consent link with the dispute scopes and a local return page", () => {
    const url = new URL(
      buildBuyerConsentUrl("client-id", "http://127.0.0.1:3000/sandbox/consent", "state-1"),
    );
    expect(url.origin).toBe("https://www.sandbox.paypal.com");
    expect(url.pathname).toBe("/connect");
    expect(url.searchParams.get("flowEntry")).toBe("static");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3000/sandbox/consent");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      SCOPES.disputesCreate,
      SCOPES.disputesReadBuyer,
    ]);
    expect(url.search).not.toContain("+");
    expect(() => buildBuyerConsentUrl("client-id", "http://example.com/x", "s")).toThrow();
  });

  it("builds the documented unsigned buyer assertion", () => {
    const jwt = buildBuyerAuthAssertion("client-id", "buyer@example.com");
    const [h, p, sig] = jwt.split(".");
    expect(sig).toBe("");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({
      alg: "none",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({
      iss: "client-id",
      email: "buyer@example.com",
    });
  });
});

describe("sandbox adapter mapping and payloads", () => {
  const disputeBody = {
    dispute_id: "PP-D-1",
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_life_cycle_stage: "INQUIRY",
    reason: "CANCELED_RECURRING_BILLING",
    dispute_amount: { currency_code: "USD", value: "19.99" },
    create_time: "2026-11-09T09:00:00Z",
    update_time: "2026-11-09T09:30:00Z",
    seller_response_due_date: "2026-11-19T09:00:00Z",
    evidences: [{ evidence_type: "CANCELLATION_DETAILS", source: "REQUESTED_FROM_SELLER" }],
    links: [
      {
        rel: "self",
        href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1",
        method: "GET",
      },
      {
        rel: "provide_evidence",
        href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-evidence",
        method: "POST",
      },
      {
        rel: "send_message",
        href: "https://api-m.paypal.com/v1/customer/disputes/PP-D-1/send-message",
        method: "POST",
      },
      {
        rel: "accept_claim",
        href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-2/accept-claim",
        method: "POST",
      },
    ],
  };

  function adapter(
    script: Scripted[],
    calls: { url: string; init: RequestInit }[],
    opts?: { buyerEmail?: string | null; enabled?: boolean },
  ) {
    const c = client(script, calls);
    return new SandboxAdapter(c, clock, {
      clientId: "cid",
      buyerEmail: opts?.buyerEmail ?? "buyer@example.com",
      buyerDisputesEnabled: opts?.enabled ?? true,
    });
  }

  it("reports the provider's total and whether a list page is complete, never the page length", async () => {
    const page = (extra: Record<string, unknown>) =>
      adapter([TOKEN, { status: 200, body: { items: [disputeBody], ...extra } }], []).listDisputes({
        pageSize: 20,
      });
    const partial = await page({ total_items: 100 });
    expect(partial.ok && partial.data).toMatchObject({ total: 100, complete: false });
    const more = await page({
      total_items: 1,
      links: [{ rel: "next", href: "https://api-m.sandbox.paypal.com/v1/customer/disputes?p=2" }],
    });
    expect(more.ok && more.data).toMatchObject({ total: 1, complete: false });
    // Without a count the page cannot be called complete.
    const uncounted = await page({});
    expect(uncounted.ok && uncounted.data).toMatchObject({ total: null, complete: false });
    const whole = await page({ total_items: 1 });
    expect(whole.ok && whole.data).toMatchObject({ total: 1, complete: true });
    if (whole.ok) expect(whole.data.items).toHaveLength(1);
  });

  it("maps a dispute, validating links against the sandbox origin and resource (CC18)", async () => {
    const a = adapter(
      [TOKEN, { status: 200, body: disputeBody, headers: { "paypal-debug-id": "dbg-9" } }],
      [],
    );
    const r = await a.getDispute("PP-D-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.observation.provenance).toBe("sandbox_api");
      expect(r.data.observation.allowedActions).toEqual(["provide_evidence"]);
      expect(r.data.summary.rejectedLinks.map((l) => l.reason).sort()).toEqual([
        "ORIGIN_NOT_ALLOWED",
        "RESOURCE_MISMATCH",
      ]);
      expect(r.data.observation.requestedEvidenceTypes).toEqual(["CANCELLATION_DETAILS"]);
      expect(r.data.observation.enumsUnderstood).toBe(true);
      expect(r.correlationId).toBe("dbg-9");
    }
  });

  it("creates a buyer dispute with multipart input and the assertion header, from a real transaction reference only", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const a = adapter(
      [
        TOKEN,
        {
          status: 201,
          body: {
            links: [
              {
                rel: "self",
                href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-77",
                method: "GET",
              },
            ],
          },
        },
      ],
      calls,
    );
    const payload = {
      buyerTransactionId: "8AB12345CD678901E",
      buyerTransactionProvenance: "sandbox_api" as const,
      reason: "CANCELED_RECURRING_BILLING" as const,
      disputeAmountCents: 1999,
      currency: "USD" as const,
      note: "Charged after cancellation.",
      merchantContacted: false,
      merchantContactedAt: null,
      cancellation: {
        cancelledAt: "2026-11-07T12:00:00Z",
        cancellationNumber: null,
        cancellationMode: null,
      },
    };
    const input = a.buildBuyerDisputeInput(payload);
    expect(input).toMatchObject({
      disputed_transactions: [{ buyer_transaction_id: "8AB12345CD678901E" }],
      reason: "CANCELED_RECURRING_BILLING",
      dispute_amount: { currency_code: "USD", value: "19.99" },
      extensions: {
        merchant_contacted: false,
        billing_dispute_properties: {
          canceled_recurring_billing: {
            expected_refund: { value: "19.99" },
            // The recorded instant, written the way the provider writes instants.
            cancellation_details: {
              cancellation_date: "2026-11-07T12:00:00.000Z",
              cancelled: true,
            },
          },
        },
      },
    });
    const w = await a.createBuyerDispute(payload, { operationId: "op1", requestId: "r1" });
    expect(w.kind).toBe("succeeded");
    if (w.kind === "succeeded") expect(w.result.disputeId).toBe("PP-D-77");
    const create = calls.find((c) => c.url.endsWith("/v1/customer/disputes"))!;
    const headers = create.init.headers as Record<string, string>;
    expect(headers["PayPal-Auth-Assertion"]).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.$/);
    expect(headers["PayPal-Request-Id"]).toBeUndefined();
    expect(create.init.body).toBeInstanceOf(FormData);
    expect((create.init.body as FormData).get("input")).toBeInstanceOf(Blob);

    const synthetic = await a.createBuyerDispute(
      { ...payload, buyerTransactionProvenance: "synthetic" },
      { operationId: "op2", requestId: "r2" },
    );
    expect(synthetic.kind).toBe("failed");
    if (synthetic.kind === "failed")
      expect(synthetic.error.code).toBe("SYNTHETIC_REFERENCE_REJECTED");

    const disabled = adapter([TOKEN], [], { enabled: false });
    const off = await disabled.createBuyerDispute(payload, { operationId: "op3", requestId: "r3" });
    expect(off.kind).toBe("failed");
    if (off.kind === "failed") expect(off.error.code).toBe("BUYER_PATH_NOT_CONFIGURED");
  });

  it("writes a recorded instant the way the provider writes instants, without moving it", () => {
    expect(providerDateTime("2026-11-10T07:43:01Z")).toBe("2026-11-10T07:43:01.000Z");
    // An offset is the same moment; it is sent in UTC.
    expect(providerDateTime("2026-11-09T23:43:01-08:00")).toBe("2026-11-10T07:43:01.000Z");
    expect(providerDateTime("2026-11-10T07:43:01.250Z")).toBe("2026-11-10T07:43:01.250Z");
    // Nothing is invented for a value that is not a time: the provider rejects it as it is.
    expect(providerDateTime("")).toBe("");
    expect(providerDateTime("last Tuesday")).toBe("last Tuesday");
  });

  it("sends evidence multipart after the dispatcher's authoritative preflight (CC17)", async () => {
    const payload = {
      disputeId: "PP-D-1",
      disputeIdProvenance: "sandbox_api" as const,
      evidenceType: "CANCELLATION_DETAILS",
      notes: "n",
      attachmentEvidenceIds: [],
    };
    const calls2: { url: string; init: RequestInit }[] = [];
    const a2 = adapter([TOKEN, { status: 200, body: { links: [] } }], calls2);
    const ok = await a2.provideEvidence(
      payload,
      [
        {
          evidenceId: "e1",
          filename: "doc.pdf",
          mime: "application/pdf",
          sha256: "x",
          bytes: new TextEncoder().encode("%PDF-1.4"),
        },
      ],
      { operationId: "op", requestId: "r" },
    );
    expect(ok.kind).toBe("succeeded");
    const post = calls2.find((c) => c.url.endsWith("/provide-evidence"))!;
    const form = post.init.body as FormData;
    expect(form.get("input")).toBeInstanceOf(Blob);
    expect(form.get("file1")).toBeInstanceOf(Blob);
    const inputJson = JSON.parse(await (form.get("input") as Blob).text()) as {
      evidences: { evidence_type: string; documents: { name: string }[] }[];
    };
    expect(inputJson.evidences[0]!.evidence_type).toBe("CANCELLATION_DETAILS");
    expect(inputJson.evidences[0]!.documents).toEqual([{ name: "doc.pdf" }]);
  });

  it("cross-checks a dispute read through the toolkit read tool when a handle is supplied", async () => {
    const c = client([TOKEN, { status: 200, body: disputeBody }], []);
    const invoked: { name: string; args: Record<string, unknown> }[] = [];
    const toolkit = {
      toolNames: ["get_dispute", "list_disputes"],
      async invoke(name: string, args: Record<string, unknown>) {
        invoked.push({ name, args });
        return JSON.stringify({ dispute_id: "PP-D-1", status: "WAITING_FOR_SELLER_RESPONSE" });
      },
    };
    const a = new SandboxAdapter(
      c,
      clock,
      { clientId: "cid", buyerEmail: null, buyerDisputesEnabled: false },
      toolkit as never,
    );
    const r = await a.getDispute("PP-D-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.summary.toolkitCrossCheck).toMatchObject({
        ok: true,
        status: "WAITING_FOR_SELLER_RESPONSE",
        agrees: true,
      });
    }
    expect(invoked).toEqual([{ name: "get_dispute", args: { dispute_id: "PP-D-1" } }]);
  });

  it.each([
    "fictionalPrivateCredentialMarker",
    "fictional-account-identifier-123",
    "https://private-sdk.example.invalid/resource",
  ])(
    "never includes a toolkit exception marker in readback metadata: %s (CC18, CC23)",
    async (marker) => {
      const toolkit: ToolkitHandle = {
        toolNames: ["get_dispute"],
        async invoke() {
          throw new Error(`SDK request failed: ${marker}`);
        },
      };
      const a = new SandboxAdapter(
        client([TOKEN, { status: 200, body: disputeBody }], []),
        clock,
        { clientId: "cid", buyerEmail: null, buyerDisputesEnabled: false },
        toolkit,
      );
      const result = await a.getDispute("PP-D-1");
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain(marker);
      if (result.ok)
        expect(result.data.summary.toolkitCrossCheck).toEqual({
          ok: false,
          status: null,
          agrees: null,
          note: "Toolkit cross-check failed; the direct REST observation is retained.",
        });
    },
  );

  it("sends a subscription start time only for a delayed-start request", async () => {
    const preview = {
      product: {
        name: "Example",
        description: "Synthetic.",
        type: "SERVICE",
        category: "SOFTWARE",
      },
      plan: {
        name: "Example plan",
        description: "Synthetic.",
        priceValue: "19.99",
        currency: "USD",
        intervalUnit: "DAY",
        intervalCount: 1,
      },
      subscription: {
        customId: "cancelcase-sandbox-test",
        returnUrl: "http://127.0.0.1:3000/sandbox/approved",
        cancelUrl: "http://127.0.0.1:3000/sandbox/cancelled",
      },
    };
    const created = {
      status: 201,
      body: {
        id: "I-SYNTHETIC0000",
        status: "APPROVAL_PENDING",
        links: [
          {
            rel: "approve",
            href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-SYN",
            method: "GET",
          },
        ],
      },
    };
    const calls: { url: string; init: RequestInit }[] = [];
    const a = adapter([TOKEN, created, created], calls);
    const wctx = { operationId: "op", requestId: "cc-req" };

    const immediate = await a.createSubscription("P-SYN-1", preview, wctx);
    expect(immediate.kind).toBe("succeeded");
    const first = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
    expect(calls[1]!.url).toBe("https://api-m.sandbox.paypal.com/v1/billing/subscriptions");
    expect(first.plan_id).toBe("P-SYN-1");
    expect("start_time" in first).toBe(false);

    const delayed = await a.createSubscription("P-SYN-1", preview, wctx, {
      startTime: "2026-11-09T11:00:00Z",
    });
    expect(delayed.kind).toBe("succeeded");
    const second = JSON.parse(String(calls[2]!.init.body)) as Record<string, unknown>;
    expect(second.start_time).toBe("2026-11-09T11:00:00Z");
    expect(second.custom_id).toBe("cancelcase-sandbox-test");
  });

  it("sends the Sandbox evidence-request simulation as one documented request", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const a = adapter(
      [TOKEN, { status: 200, body: { links: [] }, headers: { "paypal-debug-id": "dbg-sim" } }],
      calls,
    );
    const r = await a.requireEvidence("PP-D-1", "SELLER_EVIDENCE", {
      operationId: "op",
      requestId: "r",
    });
    expect(r.kind).toBe("succeeded");
    if (r.kind === "succeeded") expect(r.correlationId).toBe("dbg-sim");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(
      "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/require-evidence",
    );
    expect(calls[1]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ action: "SELLER_EVIDENCE" });

    // A fixture alias or a malformed reference never reaches the provider.
    const none: { url: string; init: RequestInit }[] = [];
    const b = adapter([TOKEN], none);
    for (const bad of ["FX-DISPUTE-1", "../v1/payments", "PP D 1", ""]) {
      const refused = await b.requireEvidence(bad, "SELLER_EVIDENCE", {
        operationId: "op",
        requestId: "r",
      });
      expect(refused.kind).toBe("failed");
      if (refused.kind === "failed")
        expect(refused.error.code).toBe("SYNTHETIC_REFERENCE_REJECTED");
    }
    expect(none).toHaveLength(0);
  });

  it("sends the Sandbox settlement simulation as one documented request", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const a = adapter(
      [TOKEN, { status: 200, body: { links: [] }, headers: { "paypal-debug-id": "dbg-adj" } }],
      calls,
    );
    const r = await a.adjudicate("PP-D-1", "BUYER_FAVOR", { operationId: "op", requestId: "r" });
    expect(r.kind).toBe("succeeded");
    if (r.kind === "succeeded") expect(r.correlationId).toBe("dbg-adj");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(
      "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/adjudicate",
    );
    expect(calls[1]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      adjudication_outcome: "BUYER_FAVOR",
    });
    // The endpoint does not document an idempotency header, so none is sent.
    const headers = new Headers(calls[1]!.init.headers);
    expect(headers.has("PayPal-Request-Id")).toBe(false);

    // A fixture alias, a malformed reference or an undocumented outcome never reaches the provider.
    const none: { url: string; init: RequestInit }[] = [];
    const b = adapter([TOKEN], none);
    for (const bad of ["FX-DISPUTE-1", "../v1/payments", "PP D 1", ""]) {
      const refused = await b.adjudicate(bad, "SELLER_FAVOR", {
        operationId: "op",
        requestId: "r",
      });
      expect(refused.kind).toBe("failed");
      if (refused.kind === "failed")
        expect(refused.error.code).toBe("SYNTHETIC_REFERENCE_REJECTED");
    }
    const odd = await b.adjudicate("PP-D-1", "BOTH" as never, {
      operationId: "op",
      requestId: "r",
    });
    expect(odd.kind).toBe("failed");
    if (odd.kind === "failed") expect(odd.error.code).toBe("INVALID_OUTCOME");
    expect(none).toHaveLength(0);
  });

  it("refuses to send a synthetic dispute id to the provider", async () => {
    const a = adapter([TOKEN], []);
    const r = await a.provideEvidence(
      {
        disputeId: "FX-DISPUTE-1",
        disputeIdProvenance: "synthetic",
        evidenceType: "OTHER",
        notes: "",
        attachmentEvidenceIds: [],
      },
      [],
      { operationId: "op", requestId: "r" },
    );
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.error.code).toBe("SYNTHETIC_REFERENCE_REJECTED");
  });
});
