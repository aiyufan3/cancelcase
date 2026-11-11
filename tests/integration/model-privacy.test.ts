import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/context";
import { setAppContextForTests } from "@/server/context";
import { ROLE_COOKIE, CSRF_COOKIE, CSRF_HEADER, encodeRoleCookie } from "@/server/http/session";
import { GET as caseGet } from "@/app/api/cases/[id]/route";
import { POST as threadStart } from "@/app/api/cases/[id]/threads/[action]/start/route";
import { LiveDrafter } from "@/llm/live-drafter";
import type { ModelCallDiagnostic } from "@/llm/diagnostics";
import { fileDiagnostics } from "@/llm/diagnostics";
import type { LlmConfig } from "@/server/config";
import { buildCaseView } from "@/server/services/case-view";
import { decideApproval, generateDraft, requireBundle } from "@/server/services/case-service";
import { dispatchOperation, prepareOperation } from "@/server/services/operation-service";
import { buildRoleSnapshot } from "@/server/services/snapshot";
import { audit } from "@/server/db/repos";

/**
 * The configured model service is private operator configuration. These tests use fictional
 * configuration and fictional upstream responses and assert that none of it reaches drafts,
 * view DTOs, API JSON, thread logs, audit details or exported files — while the private
 * diagnostics file keeps the precise detail for the operator.
 */

const MODEL = "fictional-vendor/secret-model-zz9";
const BASE = "https://models.fictional-vendor.invalid/v7";
const KEY = "fictional-key-0123456789abcdef";
const MARKERS = [
  MODEL,
  "secret-model-zz9",
  "models.fictional-vendor.invalid",
  "fictional-vendor",
  KEY,
];

function config(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    enabled: true,
    provider: "openai",
    model: MODEL,
    apiKeyPresent: true,
    baseUrl: BASE,
    reasoningEffort: null,
    maxTokens: 1500,
    ...over,
  };
}

function expectNoMarkers(text: string) {
  for (const m of MARKERS) expect(text.toLowerCase()).not.toContain(m.toLowerCase());
}

type FetchCall = { url: string; body: Record<string, unknown> };

function stubFetch(
  respond: (call: FetchCall) => { status: number; body: unknown },
  calls: FetchCall[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(call);
    const r = respond(call);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const upstreamEcho = {
  error: {
    message: `The model \`${MODEL}\` does not exist at ${BASE}/chat/completions for key ${KEY}`,
    type: "invalid_request_error",
  },
};

let h: TestHarness | null = null;
afterEach(() => {
  setAppContextForTests(null);
  h?.cleanup();
  h = null;
});

describe("connected-model transport (generic, no default host)", () => {
  it("posts to {base}/chat/completions with the configured options only", async () => {
    const calls: FetchCall[] = [];
    const drafter = new LiveDrafter(
      config({ reasoningEffort: "none", maxTokens: 900 }),
      KEY,
      stubFetch(() => ({ status: 500, body: "{}" }), calls),
    );
    h = createTestHarness();
    const snapshot = buildRoleSnapshot(h.ctx, requireBundle(h.ctx, h.caseId), "buyer");
    await drafter.draft({
      snapshot,
      action: "export_refund_request",
      role: "buyer",
      attachmentEvidenceIds: [],
    });
    expect(calls[0]!.url).toBe(`${BASE}/chat/completions`);
    expect(calls[0]!.body).toMatchObject({
      model: MODEL,
      max_tokens: 900,
      reasoning_effort: "none",
      response_format: { type: "json_object" },
    });
    const without = new LiveDrafter(
      config(),
      KEY,
      stubFetch(() => ({ status: 500, body: "{}" }), calls),
    );
    await without.draft({
      snapshot,
      action: "export_refund_request",
      role: "buyer",
      attachmentEvidenceIds: [],
    });
    expect(calls[1]!.body).not.toHaveProperty("reasoning_effort");
  });

  it("requires a base URL instead of falling back to any built-in host", async () => {
    const drafter = new LiveDrafter(
      config({ baseUrl: null }),
      KEY,
      stubFetch(() => ({ status: 200, body: {} })),
    );
    h = createTestHarness();
    const result = await drafter.draft({
      snapshot: buildRoleSnapshot(h.ctx, requireBundle(h.ctx, h.caseId), "buyer"),
      action: "export_refund_request",
      role: "buyer",
      attachmentEvidenceIds: [],
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_CONFIGURED", calls: 0 });
  });

  it("reports truncated and empty output honestly", async () => {
    h = createTestHarness();
    const snapshot = buildRoleSnapshot(h.ctx, requireBundle(h.ctx, h.caseId), "buyer");
    const truncated = await new LiveDrafter(
      config(),
      KEY,
      stubFetch(() => ({
        status: 200,
        body: {
          choices: [{ message: { content: '{"subject":"x","cla' }, finish_reason: "length" }],
        },
      })),
    ).draft({
      snapshot,
      action: "export_refund_request",
      role: "buyer",
      attachmentEvidenceIds: [],
    });
    expect(truncated).toMatchObject({ ok: false, code: "TRUNCATED_OUTPUT", calls: 1 });
    const empty = await new LiveDrafter(
      config(),
      KEY,
      stubFetch(() => ({
        status: 200,
        body: { choices: [{ message: { content: "   " }, finish_reason: "stop" }] },
      })),
    ).draft({
      snapshot,
      action: "export_refund_request",
      role: "buyer",
      attachmentEvidenceIds: [],
    });
    expect(empty).toMatchObject({ ok: false, code: "EMPTY_OUTPUT", calls: 2 });
  });
});

describe("model configuration never leaves the server", () => {
  it("CC23: private diagnostics redact an exact credential without relying on its shape", async () => {
    const credential = "opaqueCredentialForSyntheticTest";
    const recorded: ModelCallDiagnostic[] = [];
    const drafter = new LiveDrafter(
      config(),
      credential,
      stubFetch(() => ({
        status: 400,
        body: { error: { message: `Credential ${credential} was rejected for ${MODEL}.` } },
      })),
      { record: (entry) => recorded.push(entry) },
    );
    h = createTestHarness();
    const result = await drafter.draft({
      snapshot: buildRoleSnapshot(h.ctx, requireBundle(h.ctx, h.caseId), "buyer"),
      action: "export_refund_request",
      role: "buyer",
      attachmentEvidenceIds: [],
    });
    expect(result).toMatchObject({ ok: false, code: "PROVIDER_ERROR", calls: 1 });
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(recorded[0]?.detail).not.toContain(credential);
    expect(recorded[0]?.detail).toContain("[redacted-key]");
    expect(recorded[0]?.model).toBe(MODEL);
  });

  it.each([
    ["subject", MODEL],
    ["subject", "secret-model-zz9"],
    ["claim", "fictional-vendor"],
    ["subject", "MODELS.FICTIONAL-VENDOR.INVALID"],
    ["claim", BASE],
    ["claim", KEY],
  ])("CC23: rejects private configuration echoed in a successful %s", async (field, marker) => {
    h = createTestHarness();
    const recorded: ModelCallDiagnostic[] = [];
    const calls: FetchCall[] = [];
    const content = {
      subject: field === "subject" ? `Draft by ${marker}` : "Request for review",
      claims: [
        {
          id: "c1",
          kind: "context",
          text: field === "claim" ? `Prepared by ${marker}.` : "Please review these records.",
          source_ids: [],
          fact_ids: [],
        },
      ],
    };
    const drafter = new LiveDrafter(
      config(),
      KEY,
      stubFetch(
        () => ({
          status: 200,
          body: {
            choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
          },
        }),
        calls,
      ),
      { record: (entry) => recorded.push(entry) },
    );
    const result = await drafter.draft({
      snapshot: buildRoleSnapshot(h.ctx, requireBundle(h.ctx, h.caseId), "buyer"),
      action: "export_refund_request",
      role: "buyer",
      attachmentEvidenceIds: [],
    });
    expect(result).toMatchObject({ ok: false, code: "PROVIDER_ERROR", calls: 1 });
    expect(calls).toHaveLength(1);
    expectNoMarkers(JSON.stringify(result));
    expect(recorded[0]).toMatchObject({ outcome: "private_output_rejected", detail: null });
    expect(JSON.stringify(recorded)).not.toContain(KEY);
  });

  it("CC23: rejected success content never reaches a draft, API, audit or export", async () => {
    const drafter = new LiveDrafter(
      config(),
      KEY,
      stubFetch(() => ({
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  subject: `Request from ${MODEL}`,
                  claims: [{ id: "c1", kind: "context", text: KEY, source_ids: [], fact_ids: [] }],
                }),
              },
              finish_reason: "stop",
            },
          ],
        },
      })),
    );
    h = createTestHarness({ drafter, onDisk: true });
    setAppContextForTests(h.ctx);
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    expect(draft.origin).toBe("fixture_template");
    expect(draft.validation.ok).toBe(true);
    expectNoMarkers(JSON.stringify(draft));
    expectNoMarkers(JSON.stringify(buildCaseView(h.ctx, h.caseId, "buyer")));
    expectNoMarkers(JSON.stringify(audit.listForCase(h.ctx.db, h.caseId, 500)));
    const cookie = `${ROLE_COOKIE}=${encodeURIComponent(encodeRoleCookie(h.ctx, "buyer"))}`;
    const api = await caseGet(
      new Request(`http://127.0.0.1:3999/api/cases/${h.caseId}`, {
        headers: { host: "127.0.0.1:3999", cookie },
      }),
      { params: Promise.resolve({ id: h.caseId }) },
    );
    expectNoMarkers(await api.text());
    const approval = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: draft.id,
      expectedContentHash: draft.contentHash,
      decision: "approved",
    });
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      approvalId: approval.id,
    });
    const done = await dispatchOperation(h.ctx, operation.id);
    expect(done.status).toBe("SUCCEEDED");
    for (const file of fs.readdirSync(path.join(h.ctx.exportDir, h.caseId), { recursive: true })) {
      const full = path.join(h.ctx.exportDir, h.caseId, String(file));
      if (fs.statSync(full).isFile()) expectNoMarkers(fs.readFileSync(full, "utf8"));
    }
  });

  it("upstream errors are sanitized publicly and kept precisely in private diagnostics", async () => {
    const recorded: ModelCallDiagnostic[] = [];
    const drafter = new LiveDrafter(
      config(),
      KEY,
      stubFetch(() => ({ status: 404, body: upstreamEcho })),
      { record: (e) => recorded.push(e) },
    );
    h = createTestHarness();
    const result = await drafter.draft({
      snapshot: buildRoleSnapshot(h.ctx, requireBundle(h.ctx, h.caseId), "buyer"),
      action: "export_refund_request",
      role: "buyer",
      attachmentEvidenceIds: [],
    });
    expect(result.ok).toBe(false);
    expectNoMarkers(JSON.stringify(result));
    expect(drafter.label).toBe("Connected model");
    // The private record has what the operator needs, minus the key.
    expect(recorded[0]).toMatchObject({
      model: MODEL,
      endpointHost: "models.fictional-vendor.invalid",
      httpStatus: 404,
      outcome: "http_error",
    });
    expect(JSON.stringify(recorded)).not.toContain(KEY);
  });

  it("drafts, views, thread logs, audit and API JSON stay neutral after a failed model call", async () => {
    const drafter = new LiveDrafter(
      config(),
      KEY,
      stubFetch(() => ({ status: 404, body: upstreamEcho })),
    );
    h = createTestHarness({ drafter });
    setAppContextForTests(h.ctx);
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    expect(draft.origin).toBe("fixture_template");
    expectNoMarkers(JSON.stringify(draft));
    const view = buildCaseView(h.ctx, h.caseId, "buyer");
    expect(view.drafts.export_refund_request?.originLabel).toBe("Template — no model call");
    expectNoMarkers(JSON.stringify(view));
    expectNoMarkers(JSON.stringify(audit.listForCase(h.ctx.db, h.caseId, 500)));

    const cookie = `${ROLE_COOKIE}=${encodeURIComponent(encodeRoleCookie(h.ctx, "buyer"))}; ${CSRF_COOKIE}=tok`;
    const started = await threadStart(
      new Request(
        `http://127.0.0.1:3999/api/cases/${h.caseId}/threads/export_refund_request/start`,
        {
          method: "POST",
          headers: {
            host: "127.0.0.1:3999",
            origin: "http://127.0.0.1:3999",
            cookie,
            [CSRF_HEADER]: "tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({ regenerate: true }),
        },
      ),
      { params: Promise.resolve({ id: h.caseId, action: "export_refund_request" }) },
    );
    expectNoMarkers(await started.text());
    const api = await caseGet(
      new Request(`http://127.0.0.1:3999/api/cases/${h.caseId}`, {
        headers: { host: "127.0.0.1:3999", cookie },
      }),
      { params: Promise.resolve({ id: h.caseId }) },
    );
    expectNoMarkers(await api.text());
  });

  it("a successful connected draft is labelled 'Connected model' without naming the configuration", async () => {
    h = createTestHarness();
    const snapshot = buildRoleSnapshot(h.ctx, requireBundle(h.ctx, h.caseId), "buyer");
    const effective = snapshot.facts.find((f) => f.kind === "cancellation_effective")!;
    const charge = snapshot.facts.find((f) => f.kind === "charge")!;
    const content = {
      subject: "Refund request for a charge after cancellation",
      claims: [
        {
          id: "c1",
          kind: "fact",
          text: "My cancellation took effect on 2026-11-07.",
          source_ids: effective.sourceIds.slice(0, 1),
          fact_ids: [effective.id],
        },
        {
          id: "c2",
          kind: "fact",
          text: "A charge of $19.99 was initiated on 2026-11-08.",
          source_ids: charge.sourceIds.slice(0, 1),
          fact_ids: [charge.id],
        },
      ],
    };
    const drafter = new LiveDrafter(
      config(),
      KEY,
      stubFetch(() => ({
        status: 200,
        body: {
          model: MODEL,
          choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
        },
      })),
    );
    const local = createTestHarness({ drafter });
    try {
      const draft = await generateDraft(local.ctx, {
        caseId: local.caseId,
        role: "buyer",
        action: "export_refund_request",
      });
      expect(draft.origin).toBe("live_model");
      const view = buildCaseView(local.ctx, local.caseId, "buyer");
      expect(view.drafts.export_refund_request?.originLabel).toBe("Connected model");
      expectNoMarkers(JSON.stringify(view));
      expectNoMarkers(JSON.stringify(draft));
    } finally {
      local.cleanup();
    }
  });

  it("the private diagnostics file lives under the ignored data directory", () => {
    h = createTestHarness({ onDisk: true });
    const dir = path.join(h.ctx.config.envDir, "diagnostics");
    fileDiagnostics(dir).record({
      at: "2026-11-09T00:00:00Z",
      transport: "openai",
      model: MODEL,
      endpointHost: "models.fictional-vendor.invalid",
      endpointPath: "/v7/chat/completions",
      attempt: 1,
      ok: false,
      outcome: "http_error",
      httpStatus: 404,
      finishReason: null,
      elapsedMs: 5,
      detail: null,
    });
    const file = path.join(dir, "model-calls.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    expect(path.relative(h.ctx.config.dataDir, file)).toBe(
      path.join("fixture", "diagnostics", "model-calls.jsonl"),
    );
    expect((fs.statSync(file).mode & 0o077) === 0).toBe(true);
  });
});
