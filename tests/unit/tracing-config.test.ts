import os from "node:os";
import { describe, expect, it } from "vitest";
import { ConfigError, loadAppConfig } from "@/server/config";
import { redactForTrace, redactTraceError } from "@/server/tracing";

/** LangSmith tracing is opt-in, needs its key, and sends only redacted data. */

const config = (extra: Record<string, string>) =>
  loadAppConfig({ APP_MODE: "fixture", ...extra } as unknown as NodeJS.ProcessEnv);

describe("tracing switches", () => {
  it("is off by default and when switched off", () => {
    expect(config({}).tracing).toEqual({ enabled: false, project: "cancelcase" });
    expect(config({ LANGSMITH_TRACING: "false", LANGSMITH_API_KEY: "k" }).tracing.enabled).toBe(
      false,
    );
    expect(config({ LANGSMITH_API_KEY: "k" }).tracing.enabled).toBe(false);
  });

  it("is on only with LANGSMITH_TRACING and LANGSMITH_API_KEY together", () => {
    expect(config({ LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "k" }).tracing).toEqual({
      enabled: true,
      project: "cancelcase",
    });
    expect(
      config({ LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "k", LANGSMITH_PROJECT: "demo" })
        .tracing.project,
    ).toBe("demo");
  });

  it("refuses to start with the switch on and no key, so nothing is sent without one", () => {
    expect(() => config({ LANGSMITH_TRACING: "true" })).toThrow(ConfigError);
    expect(() => config({ LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "  " })).toThrow(
      /LANGSMITH_API_KEY is not set/,
    );
  });

  it("refuses LangChain's own switches, which would trace without redaction", () => {
    for (const flag of ["LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING"])
      expect(() =>
        config({ LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "k", [flag]: "true" }),
      ).toThrow(/unredacted/);
  });
});

describe("redactForTrace", () => {
  it("removes secrets, personal data, free text and PayPal identifiers, and keeps the rest", () => {
    const out = redactForTrace(
      {
        caseId: "sb_case_1df4f5a5d8e9",
        status: "RESOLVED",
        snapshotVersion: 4,
        draftValid: true,
        headers: { authorization: "Bearer abc.def.ghi", "x-api-key": "lsv2_example" },
        payer: { email_address: "buyer@example.com", name: { given_name: "Alex" } },
        decision: { kind: "reject", reason: "Alex disagrees, write to alex@example.com" },
        log: [
          "read PP-D-123456 for I-ABCDEF1234567, transaction 5TY05013RG002845M, from Alex Example",
          "contact alex@example.com with Bearer abcdefghijklmnop",
        ],
      },
      ["Alex Example"],
    );
    expect(out).toEqual({
      caseId: "sb_case_1df4f5a5d8e9",
      status: "RESOLVED",
      snapshotVersion: 4,
      draftValid: true,
      headers: { authorization: "[redacted-secret]", "x-api-key": "[redacted-secret]" },
      payer: { email_address: "[redacted-personal]", name: "[redacted-personal]" },
      decision: { kind: "reject", reason: "[redacted-text: 41 characters]" },
      log: [
        "read [paypal-id] for [paypal-id], transaction [paypal-id], from [redacted-name]",
        "contact [redacted-email] with Bearer [redacted]",
      ],
    });
  });

  it("is idempotent, so a second pass keeps each placeholder, including the original length", () => {
    const once = redactForTrace(
      {
        decision: { kind: "reject", reason: "Alex Example disagrees; write to alex@example.com" },
        payer: { email_address: "alex@example.com" },
        headers: { authorization: "Bearer abcdefghijklmnop" },
        log: ["read PP-D-12345678 for Alex Example"],
      },
      ["Alex Example"],
    );
    expect(once).toMatchObject({ decision: { reason: "[redacted-text: 49 characters]" } });
    expect(redactForTrace(once, ["Alex Example"])).toEqual(once);
  });

  it("survives cycles and deep values without throwing", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(redactForTrace(loop)).toEqual({ a: 1, self: "[circular]" });
    expect(redactForTrace(new Date("2026-11-10T16:31:47.000Z"))).toBe("2026-11-10T16:31:47.000Z");
  });
});

describe("redactTraceError", () => {
  it("keeps the message on one line and drops the stack trace and every file path", () => {
    const stack = [
      "GraphInterrupt: paused for review",
      `    at interrupt (${process.cwd()}/node_modules/@langchain/langgraph/src/interrupt.ts:163:9)`,
      "    at RunnableCallable.func (/srv/example app/cancelcase/src/graph/case-graph.ts:133:24)",
      "    at C:\\work\\cancelcase\\src\\server\\tracing.ts:40:2",
    ].join("\n");
    const out = redactTraceError(`paused for review\nnext: approve or reject\n\n${stack}`);
    expect(out).toBe("paused for review next: approve or reject");
  });

  it("removes file paths, names and email addresses from the message itself", () => {
    const out = redactTraceError(
      `ENOENT: no such file '${process.cwd()}/data/local/x.json' for Alex Example, alex@example.com; also ${os.homedir()}/notes/a.txt and /opt/example/notes/a.txt`,
      ["Alex Example"],
    );
    expect(out).not.toContain(process.cwd());
    expect(out).not.toContain(`${os.homedir()}/notes`);
    expect(out).not.toContain("/opt/example");
    expect(out).not.toContain("Alex Example");
    expect(out).not.toContain("alex@example.com");
    expect(out).toContain("ENOENT: no such file");
    expect(out).not.toContain("\n");
  });
});
