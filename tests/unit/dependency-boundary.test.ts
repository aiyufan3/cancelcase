import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ConfigError, EXTERNAL_TRACING_FLAGS, loadAppConfig } from "@/server/config";

/**
 * The accepted residual dependency advisories (scripts/accepted-advisories.json) rest on these
 * reachability facts. If an update or a code change breaks one, this test fails and the
 * acceptance has to be reviewed again.
 */

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts|cts|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

const OWN_CODE = ["src", "scripts"].flatMap((d) => sourceFiles(path.join(root, d)));
const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

function isCore(dir: string): boolean {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
    name?: string;
  };
  return pkg.name === "@langchain/core";
}

function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  return Array.from(text.matchAll(IMPORT), (m) => m[1]!);
}

describe("residual advisories stay unreachable from our code", () => {
  it("our code never imports the modules that carry accepted advisories", () => {
    const banned = /^(ai|openai|mathjs|jsondiffpatch|langsmith|uuid|@ai-sdk\/.*)(\/.*)?$/;
    // One reviewed exception: the opt-in tracer loads the root entry of the direct langsmith
    // dependency, which is not the 0.3 copy the accepted advisories cover (see the next test).
    const allowed = new Set([`${path.join("src", "server", "tracing.ts")} → langsmith`]);
    const offenders = OWN_CODE.flatMap((file) =>
      importsOf(file)
        .filter((spec) => banned.test(spec))
        .map((spec) => `${path.relative(root, file)} → ${spec}`),
    ).filter((entry) => !allowed.has(entry));
    expect(offenders).toEqual([]);
  });

  it("the tracer's langsmith is the direct dependency, outside the advised 0.3 line, and loaded only on demand", () => {
    const pkg = JSON.parse(fs.readFileSync(require.resolve("langsmith/package.json"), "utf8")) as {
      version: string;
    };
    const [major, minor] = pkg.version.split(".").map(Number);
    // GHSA-3644-q5cj-c5c7 is fixed in 0.6; the other accepted langsmith advisories are reviewed
    // only on the toolkit's 0.3 path.
    expect((major ?? 0) > 0 || (minor ?? 0) >= 6).toBe(true);
    const tracer = fs.readFileSync(path.join(root, "src", "server", "tracing.ts"), "utf8");
    expect(tracer).toMatch(/import\("langsmith"\)/);
    expect(tracer).not.toMatch(/from\s+["']langsmith/);
  });

  it("only the toolkit's LangChain entry is used", () => {
    const toolkitImports = OWN_CODE.flatMap((file) =>
      importsOf(file).filter((spec) => spec.startsWith("@paypal/agent-toolkit")),
    );
    expect(new Set(toolkitImports)).toEqual(new Set(["@paypal/agent-toolkit/langchain"]));
  });

  it("the toolkit's LangChain entry loads no AI-SDK, OpenAI client or diff code, and uses mathjs only to round", () => {
    const entry = require.resolve("@paypal/agent-toolkit/langchain");
    const text = fs.readFileSync(entry, "utf8");
    const required = new Set(Array.from(text.matchAll(/require\("([^"]+)"\)/g), (m) => m[1]!));
    for (const mod of ["ai", "openai", "jsondiffpatch", "langsmith", "uuid"])
      expect(required.has(mod)).toBe(false);
    const mathUses = new Set(Array.from(text.matchAll(/import_mathjs\.(\w+)/g), (m) => m[1]!));
    expect(Array.from(mathUses)).toEqual(["round"]);
    expect(text).not.toMatch(/\bevaluate\(|\bparse\(\s*expr/);
  });

  it("the toolkit's LangChain core is on the patched 0.3 line", () => {
    const toolkitRequire = createRequire(require.resolve("@paypal/agent-toolkit/langchain"));
    let dir = path.dirname(toolkitRequire.resolve("@langchain/core/tools"));
    while (!fs.existsSync(path.join(dir, "package.json")) || !isCore(dir)) dir = path.dirname(dir);
    const corePkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      version: string;
    };
    const [major, minor, patch] = corePkg.version.split(".").map(Number);
    expect(major).toBe(0);
    expect(minor).toBe(3);
    expect(patch).toBeGreaterThanOrEqual(80);
  });
});

describe("hosted tracing fails closed", () => {
  it.each(EXTERNAL_TRACING_FLAGS)("refuses to start with %s on", (flag) => {
    expect(() =>
      loadAppConfig({ APP_MODE: "fixture", [flag]: "true" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it("starts with tracing explicitly off", () => {
    expect(
      loadAppConfig({
        APP_MODE: "fixture",
        LANGSMITH_TRACING: "false",
        LANGCHAIN_TRACING_V2: "false",
      } as unknown as NodeJS.ProcessEnv).mode,
    ).toBe("fixture");
  });
});
