import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runAudit(output: unknown, status: number | "signal" = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cancelcase-dependency-gate-"));
  temporary.push(dir);
  const fakePnpm = path.join(dir, "pnpm");
  const json = JSON.stringify(JSON.stringify(output));
  fs.writeFileSync(
    fakePnpm,
    `#!${process.execPath}\nrequire("node:fs").writeSync(1, ${json});\n${
      status === "signal" ? 'process.kill(process.pid, "SIGTERM");' : `process.exit(${status});`
    }\n`,
    { mode: 0o755 },
  );
  return spawnSync(
    process.execPath,
    [require.resolve("tsx/cli"), path.join(root, "scripts/deps-audit.ts")],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
    },
  );
}

describe("CC23 dependency audit fails closed on unavailable or invalid evidence", () => {
  it("rejects a registry error encoded as valid JSON rather than reporting zero advisories", () => {
    const result = runAudit({ error: { code: "REGISTRY_UNAVAILABLE", message: "Try later" } }, 1);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("deps:audit: OK");
  });

  it("rejects a report without an advisory map", () => {
    expect(runAudit({}).status).not.toBe(0);
  });

  it("rejects a failed process even if its partial output looks like an empty audit", () => {
    expect(runAudit({ advisories: {} }, 1).status).not.toBe(0);
  });

  it("rejects a terminated audit process with partial valid JSON", () => {
    expect(runAudit({ advisories: {} }, "signal").status).not.toBe(0);
  });

  it("rejects malformed advisory findings instead of accepting an unreviewable path", () => {
    const report = {
      advisories: {
        example: {
          github_advisory_id: "GHSA-29qv-4j9f-fjw5",
          module_name: "mathjs",
          severity: "high",
          title: "Synthetic advisory",
          findings: [],
        },
      },
    };
    expect(runAudit(report, 1).status).not.toBe(0);
  });

  it("accepts a successful report with an explicit empty advisory map", () => {
    const result = runAudit({ advisories: {} });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("deps:audit: OK");
  });
});
