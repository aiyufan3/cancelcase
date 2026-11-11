import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { createTestHarness, type TestHarness } from "../helpers/context";
import { resumeCaseThread, startCaseThread } from "@/graph/case-graph";
import { EXTERNAL_TRACING_FLAGS } from "@/server/config";
import { flushTraces, setTraceTransport } from "@/server/tracing";

/**
 * Tracing end to end on the fixture graph: without the key nothing leaves the process, and with it
 * only redacted runs reach the (fake) LangSmith endpoint.
 */

let h: TestHarness | null = null;
const savedEnv = Object.fromEntries(EXTERNAL_TRACING_FLAGS.map((f) => [f, process.env[f]]));

afterEach(() => {
  h?.cleanup();
  h = null;
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("tracing off", () => {
  it("makes no network call, even with LangChain's own switches set in the environment", async () => {
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGCHAIN_TRACING_V2 = "true";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    h = createTestHarness();
    expect(h.ctx.config.tracing.enabled).toBe(false);
    // Creating the context removed the switches, so LangChain cannot start its own tracer.
    for (const flag of EXTERNAL_TRACING_FLAGS) expect(process.env[flag]).toBeUndefined();

    // A switch set later is removed before the next graph run as well.
    process.env.LANGCHAIN_TRACING_V2 = "true";
    const run = await startCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    await awaitAllCallbacks();
    expect(run.interrupted).toBe(true);
    expect(process.env.LANGCHAIN_TRACING_V2).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("tracing on", () => {
  it("sends named, tagged runs with personal data, free text and the key removed", async () => {
    h = createTestHarness();
    h.ctx.config.tracing = { enabled: true, project: "cancelcase-test" };
    const sent: { url: string; body: string; headers: string }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : await new Response(init?.body).text(),
        headers: JSON.stringify(init?.headers ?? {}),
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const globalFetch = vi.spyOn(globalThis, "fetch");
    setTraceTransport(h.ctx, {
      apiKey: "test-key-not-a-secret",
      apiUrl: "https://langsmith.example.invalid",
      fetchImplementation: fakeFetch,
      autoBatchTracing: false,
    });

    await startCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    await resumeCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      decision: { kind: "reject", reason: "Alex Example disagrees; write to alex@example.com" },
    });
    await flushTraces(h.ctx);

    expect(globalFetch).not.toHaveBeenCalled();
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent.map((s) => new URL(s.url).host))).toEqual(
      new Set(["langsmith.example.invalid"]),
    );
    const bodies = sent.map((s) => s.body).join("\n");
    for (const node of ["gather", "draft", "review"]) expect(bodies).toContain(`"${node}"`);
    expect(bodies).toContain("CancelCase export refund request: start");
    expect(bodies).toContain(`case:${h.caseId}`);
    expect(bodies).toContain("mode:fixture");
    expect(bodies).not.toContain("alex@example.com");
    expect(bodies).not.toContain("Alex Example");
    expect(bodies).not.toContain("disagrees");
    expect(bodies).not.toContain("test-key-not-a-secret");
    // The key travels only as the request header LangSmith expects.
    expect(sent.every((s) => s.headers.includes("test-key-not-a-secret"))).toBe(true);
  });

  it("keeps the original length of redacted free text when runs are sent in batches", async () => {
    h = createTestHarness();
    h.ctx.config.tracing = { enabled: true, project: "cancelcase-test" };
    const bodies: string[] = [];
    setTraceTransport(h.ctx, {
      apiKey: "test-key-not-a-secret",
      apiUrl: "https://langsmith.example.invalid",
      fetchImplementation: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(
          typeof init?.body === "string" ? init.body : await new Response(init?.body).text(),
        );
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      // As in production: langsmith redacts again on its batch path.
      autoBatchTracing: true,
    });

    await startCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    await resumeCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      decision: { kind: "reject", reason: "Alex Example disagrees; write to alex@example.com" },
    });
    await flushTraces(h.ctx);

    const sent = bodies.join("\n");
    expect(sent).toContain("[redacted-text: 49 characters]");
    expect(sent).not.toMatch(/\[redacted-text: (?!49 )\d+ characters\]/);
    expect(sent).not.toContain("disagrees");
  });

  it("sends the pause for review as a one-line error, without a stack trace or a file path", async () => {
    h = createTestHarness();
    h.ctx.config.tracing = { enabled: true, project: "cancelcase-test" };
    const bodies: string[] = [];
    setTraceTransport(h.ctx, {
      apiKey: "test-key-not-a-secret",
      apiUrl: "https://langsmith.example.invalid",
      fetchImplementation: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(
          typeof init?.body === "string" ? init.body : await new Response(init?.body).text(),
        );
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      autoBatchTracing: false,
    });

    const run = await startCaseThread(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    await flushTraces(h.ctx);

    expect(run.interrupted).toBe(true);
    const errors = bodies
      .map((b) => JSON.parse(b) as { error?: string })
      .flatMap((b) => (b.error ? [b.error] : []));
    // LangChain records the review pause as an error; it is sent, as one line.
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error).toContain("Review the draft");
      expect(error).not.toContain("\n");
      expect(error).not.toMatch(/\bat \S+ \(/);
    }
    expect(bodies.join("\n")).not.toContain(process.cwd());
  });
});
