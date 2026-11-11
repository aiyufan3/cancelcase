import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyToolkitList, llmConfigIssues } from "../../scripts/lib";
import { loadLlmConfig } from "@/server/config";

/**
 * A diagnostic may not say more than it observed: settings being present, settings being
 * well-formed and a call that succeeded are three different results. Nothing here calls a model
 * or PayPal; the script runs in an empty folder with invented settings.
 */

const repo = path.resolve(import.meta.dirname, "../..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const llm = (env: Record<string, string>) => loadLlmConfig(env as unknown as NodeJS.ProcessEnv);
const COMPLETE = {
  LLM_ENABLED: "true",
  LLM_PROVIDER: "openai",
  LLM_MODEL: "example-model",
  LLM_BASE_URL: "https://llm.example.invalid/v1",
  LLM_API_KEY: "not-a-real-key",
};

describe("toolkit read label", () => {
  it("is verified only for a result that parses as a list", () => {
    expect(classifyToolkitList('{"items":[{},{}]}', ["list_disputes"])).toMatchObject({
      state: "VERIFIED",
      detail: expect.stringContaining("returned 2 item(s)"),
    });
    for (const raw of ["not json", '{"error":"denied"}', "null", '{"items":"3"}', undefined])
      expect(classifyToolkitList(raw, ["list_disputes"]).state, String(raw)).toBe("BLOCKED");
  });
});

describe("model settings", () => {
  it("names each problem without its value", () => {
    expect(llmConfigIssues(llm(COMPLETE))).toEqual([]);
    expect(llmConfigIssues(llm({}))).toEqual([
      "LLM_PROVIDER is missing",
      "LLM_MODEL is missing",
      "LLM_BASE_URL is missing",
      "LLM_API_KEY is missing",
    ]);
    const bad = llmConfigIssues(
      llm({ ...COMPLETE, LLM_PROVIDER: "other", LLM_BASE_URL: "http://llm.example.invalid" }),
    );
    expect(bad).toEqual(["LLM_PROVIDER is not a supported transport", "LLM_BASE_URL is not https"]);
    expect(bad.join(" ")).not.toContain("llm.example.invalid");
  });

  function configOnly(env: Record<string, string>) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cancelcase-llm-check-"));
    dirs.push(cwd);
    // An empty working folder: no .env is read, and nothing but these settings is present.
    return spawnSync(
      path.join(repo, "node_modules", ".bin", "tsx"),
      [path.join(repo, "scripts", "llm-check.ts"), "--config-only", "--data-dir", cwd],
      {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: cwd,
          TSX_TSCONFIG_PATH: path.join(repo, "tsconfig.json"),
          ...env,
        } as unknown as NodeJS.ProcessEnv,
      },
    );
  }

  it("config-only exits non-zero for missing settings and never claims a call", () => {
    const missing = configOnly({});
    expect(missing.status).toBe(2);
    expect(missing.stdout).toContain("RESULT config=INVALID call=NOT_MADE");
    const present = configOnly(COMPLETE);
    expect(present.status).toBe(0);
    expect(present.stdout).toContain("RESULT config=PRESENT call=NOT_MADE");
    expect(present.stdout).toContain("nothing is verified");
    expect(present.stdout).not.toContain("example-model");
    expect(present.stdout).not.toContain("llm.example.invalid");
    expect(present.stdout).not.toContain("not-a-real-key");
  });
});
