import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { config as loadDotenv } from "dotenv";
import { LLM_REASONING_EFFORTS, startupTracingEnv, type LlmConfig } from "@/server/config";

/** Minimal CLI helpers shared by the root commands. Nothing here prints secret values. */

export interface Args {
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
}

export function parseArgs(argv: string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) values.set(a.slice(2, eq), a.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        values.set(a.slice(2), argv[i + 1]!);
        i += 1;
      } else flags.add(a.slice(2));
    } else positional.push(a);
  }
  return { flags, values, positional };
}

/** Load .env server-side into process.env (without overriding already-set variables). Never logs values. */
export function loadLocalEnv(): { loaded: boolean; path: string } {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return { loaded: false, path: file };
  loadDotenv({ path: file, quiet: true, override: false });
  return { loaded: true, path: file };
}

export async function confirm(question: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) return true;
  if (!process.stdin.isTTY) {
    console.error("Non-interactive terminal: pass --yes to confirm.");
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export function ledgerDir(dataDir: string): string {
  const dir = path.join(dataDir, "ledger");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeLedger(dataDir: string, name: string, payload: unknown): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(ledgerDir(dataDir), `${name}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return file;
}

export function presence(name: string, env: NodeJS.ProcessEnv = process.env): "set" | "missing" {
  return env[name]?.trim() ? "set" : "missing";
}

export function spawnNext(
  mode: "dev" | "start",
  port: number,
  extraEnv: Record<string, string>,
): Promise<number> {
  const bin = path.resolve(process.cwd(), "node_modules", ".bin", "next");
  const args = [mode, "--hostname", "127.0.0.1", "--port", String(port)];
  const child = spawn(bin, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
      NEXT_TELEMETRY_DISABLED: "1",
      HOSTNAME: "127.0.0.1",
      // The server reads tracing as this process started: LANGSMITH_TRACING turns on the
      // redacting tracer only together with LANGSMITH_API_KEY; LangChain's own switch stays off.
      ...(startupTracingEnv().LANGSMITH_TRACING !== undefined
        ? { LANGSMITH_TRACING: startupTracingEnv().LANGSMITH_TRACING! }
        : {}),
      LANGCHAIN_TRACING_V2: startupTracingEnv().LANGCHAIN_TRACING_V2 ?? "false",
    },
  });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
}

export function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]!);
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => (r[k] ?? "").length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join("  ");
  console.log(line(keys));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(keys.map((k) => r[k] ?? "")));
}

export function banner(title: string): void {
  console.log(`\n${title}\n${"=".repeat(title.length)}`);
}

/**
 * What a toolkit list call supports. Only a result that parses as a list is evidence that the
 * read worked; a value that cannot be read is reported as blocked, never as verified.
 */
export function classifyToolkitList(
  raw: unknown,
  toolNames: readonly string[],
): { state: "VERIFIED" | "BLOCKED"; detail: string } {
  const tools = `tools [${toolNames.join(", ")}] match the allowlist`;
  let items: unknown;
  try {
    items = (JSON.parse(String(raw)) as { items?: unknown } | null)?.items;
  } catch {
    return {
      state: "BLOCKED",
      detail: `${tools}; list_disputes returned a value that could not be parsed, so the read is not verified`,
    };
  }
  if (!Array.isArray(items))
    return {
      state: "BLOCKED",
      detail: `${tools}; list_disputes returned no list of items, so the read is not verified`,
    };
  return { state: "VERIFIED", detail: `${tools}; list_disputes returned ${items.length} item(s)` };
}

/**
 * Problems in the local model settings, by name and never by value. An empty list means the
 * settings are present and well-formed; it does not mean a call was made or would succeed.
 */
export function llmConfigIssues(llm: LlmConfig): string[] {
  const issues: string[] = [];
  const transport = (llm.provider ?? "").toLowerCase();
  if (!llm.provider) issues.push("LLM_PROVIDER is missing");
  else if (transport !== "openai" && transport !== "anthropic")
    issues.push("LLM_PROVIDER is not a supported transport");
  if (!llm.model) issues.push("LLM_MODEL is missing");
  if (!llm.baseUrl) issues.push("LLM_BASE_URL is missing");
  else {
    const url = (() => {
      try {
        return new URL(llm.baseUrl);
      } catch {
        return null;
      }
    })();
    if (!url) issues.push("LLM_BASE_URL is not a URL");
    else if (url.protocol !== "https:") issues.push("LLM_BASE_URL is not https");
  }
  if (!llm.apiKeyPresent) issues.push("LLM_API_KEY is missing");
  if (
    llm.reasoningEffort &&
    !(LLM_REASONING_EFFORTS as readonly string[]).includes(llm.reasoningEffort)
  )
    issues.push("LLM_REASONING_EFFORT is not a supported value");
  return issues;
}
