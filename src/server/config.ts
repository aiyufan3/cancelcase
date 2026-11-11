import path from "node:path";
import type { Environment } from "@/domain/types";

/**
 * Server-side configuration. Values are read from process.env only here.
 * Fixture mode never reads provider or model credentials, so a clean clone with no
 * .env file runs fully offline. Nothing here is ever exposed to the client bundle.
 */

export const SANDBOX_ORIGINS = [
  "https://api-m.sandbox.paypal.com",
  "https://api.sandbox.paypal.com",
] as const;

export interface PayPalConfig {
  baseUrl: string;
  origin: string;
  clientId: string;
  clientSecret: string;
  buyerDisputesEnabled: boolean;
  buyerEmail: string | null;
  /** Optional privately configured Sandbox dispute ID for merchant read/evidence tests */
  importDisputeId: string | null;
}

/**
 * Model configuration. These values are private operator configuration: they are used to make
 * the call and to write ignored local diagnostics, and never leave the server in any response,
 * export, error or log line meant for others. Public output uses neutral labels only.
 */
export interface LlmConfig {
  enabled: boolean;
  /** Transport selector: "openai" (OpenAI-compatible Chat Completions) or "anthropic" (Messages) */
  provider: string | null;
  model: string | null;
  apiKeyPresent: boolean;
  /** API base URL as the service documents it for its SDK; required, no default host */
  baseUrl: string | null;
  /** Optional reasoning_effort for OpenAI-compatible services that document it */
  reasoningEffort: string | null;
  /** Output token budget; bounded */
  maxTokens: number;
}

export const LLM_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;

export interface AppConfig {
  mode: Environment;
  dataDir: string;
  /** Per-environment storage directory: <dataDir>/<mode> */
  envDir: string;
  appOrigin: string;
  host: string;
  port: number;
  recordingMode: boolean;
  e2e: boolean;
  /** Optional LangSmith tracing of the agent's graph runs; off unless both switches are set. */
  tracing: TracingSettings;
}

export interface TracingSettings {
  enabled: boolean;
  /** LangSmith project the runs are filed under (LANGSMITH_PROJECT, default "cancelcase") */
  project: string;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

function readMode(env: NodeJS.ProcessEnv): Environment {
  const raw = (env.APP_MODE ?? "fixture").trim().toLowerCase();
  if (raw === "fixture" || raw === "sandbox") return raw;
  throw new ConfigError(
    `APP_MODE must be "fixture" or "sandbox" (got ${JSON.stringify(raw)})`,
    "INVALID_MODE",
  );
}

/**
 * Tracing switches LangChain reads from the environment. Any of them set to "true" makes LangChain
 * attach its own tracer, which sends inputs and outputs unredacted. CancelCase never relies on
 * them: it traces only through its redacting tracer (src/server/tracing.ts), turned on by
 * LANGSMITH_TRACING together with LANGSMITH_API_KEY, and removes these switches from the process
 * environment so that LangChain's automatic tracer never starts.
 */
export const EXTERNAL_TRACING_FLAGS = [
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
] as const;

const TRACING_ENV_KEYS = [...EXTERNAL_TRACING_FLAGS, "LANGSMITH_API_KEY", "LANGSMITH_PROJECT"];
const STARTUP_TRACING_ENV = Symbol.for("cancelcase.startupTracingEnv");

/**
 * The tracing variables as this process first saw them, captured before the switches are removed
 * from process.env. Captured on first use, so that a script's own .env loading comes first.
 */
export function startupTracingEnv(): Readonly<Record<string, string | undefined>> {
  const store = globalThis as unknown as Record<symbol, Record<string, string | undefined>>;
  store[STARTUP_TRACING_ENV] ??= Object.fromEntries(
    TRACING_ENV_KEYS.map((name) => [name, process.env[name]]),
  );
  return store[STARTUP_TRACING_ENV];
}

function isOn(value: string | undefined): boolean {
  return ["true", "1", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/**
 * Tracing is opt-in and fails closed. LANGSMITH_TRACING turns it on only together with
 * LANGSMITH_API_KEY; on its own it stops startup, so nothing is ever sent without the key. The
 * other switches would only start LangChain's unredacted tracer and are refused.
 */
function readTracing(env: Readonly<Record<string, string | undefined>>): TracingSettings {
  const project = env.LANGSMITH_PROJECT?.trim() || "cancelcase";
  const legacy = EXTERNAL_TRACING_FLAGS.filter((name) => name !== "LANGSMITH_TRACING").filter(
    (name) => isOn(env[name]),
  );
  if (legacy.length > 0)
    throw new ConfigError(
      `${legacy.join(", ")} would start LangChain's own tracer, which sends case data unredacted. Unset it; to trace through CancelCase's redacting tracer, set LANGSMITH_TRACING and LANGSMITH_API_KEY instead.`,
      "EXTERNAL_TRACING_ENABLED",
    );
  if (!isOn(env.LANGSMITH_TRACING)) return { enabled: false, project };
  if (!env.LANGSMITH_API_KEY?.trim())
    throw new ConfigError(
      "LANGSMITH_TRACING is on but LANGSMITH_API_KEY is not set. Set the key to trace through CancelCase's redacting tracer, or unset LANGSMITH_TRACING.",
      "EXTERNAL_TRACING_ENABLED",
    );
  return { enabled: true, project };
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // The process environment is read as it was at startup: its tracing switches are removed once
  // read (see EXTERNAL_TRACING_FLAGS).
  const tracing = readTracing(env === process.env ? startupTracingEnv() : env);
  const mode = readMode(env);
  const dataDir = path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    env.DATA_DIR?.trim() || "./data/local",
  );
  const appOrigin = (env.APP_ORIGIN?.trim() || "http://127.0.0.1:3000").replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(appOrigin);
  } catch {
    throw new ConfigError(`APP_ORIGIN is not a valid URL: ${appOrigin}`, "INVALID_ORIGIN");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new ConfigError(
      `APP_ORIGIN must be a loopback origin in P0 (got ${url.hostname}). No hosted deployment is supported.`,
      "NON_LOOPBACK_ORIGIN",
    );
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return {
    mode,
    dataDir,
    envDir: path.join(/* turbopackIgnore: true */ dataDir, mode),
    appOrigin,
    host: "127.0.0.1",
    port,
    recordingMode: (env.DEMO_RECORDING_MODE ?? "true").trim().toLowerCase() !== "false",
    e2e: env.CC_E2E === "1",
    tracing,
  };
}

/** Sandbox credentials: only read when the mode is sandbox. Fails closed on live or unknown origins. */
export function loadPayPalConfig(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  const paypalEnv = (env.PAYPAL_ENV ?? "").trim().toLowerCase();
  if (paypalEnv !== "sandbox") {
    throw new ConfigError(
      `PAYPAL_ENV must be "sandbox"; refusing to run against ${paypalEnv || "an unset environment"}.`,
      "NOT_SANDBOX",
    );
  }
  const baseUrl = (env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com")
    .trim()
    .replace(/\/$/, "");
  let origin: string;
  try {
    const u = new URL(baseUrl);
    origin = u.origin;
    if (u.pathname !== "/" && u.pathname !== "") throw new Error("path");
  } catch {
    throw new ConfigError(
      "PAYPAL_BASE_URL must be a bare https origin.",
      "INVALID_PAYPAL_BASE_URL",
    );
  }
  if (!(SANDBOX_ORIGINS as readonly string[]).includes(origin)) {
    throw new ConfigError(
      `PAYPAL_BASE_URL origin ${origin} is not a PayPal Sandbox origin. Allowed: ${SANDBOX_ORIGINS.join(", ")}.`,
      "ORIGIN_NOT_SANDBOX",
    );
  }
  const clientId = env.PAYPAL_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim() ?? "";
  const missing = [
    clientId ? null : "PAYPAL_CLIENT_ID",
    clientSecret ? null : "PAYPAL_CLIENT_SECRET",
  ].filter((v): v is string => v !== null);
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required Sandbox variables: ${missing.join(", ")} (set them in your local .env).`,
      "MISSING_CREDENTIALS",
    );
  }
  return {
    baseUrl: origin,
    origin,
    clientId,
    clientSecret,
    buyerDisputesEnabled:
      (env.PAYPAL_ENABLE_BUYER_DISPUTES ?? "false").trim().toLowerCase() === "true",
    buyerEmail: env.PAYPAL_BUYER_EMAIL?.trim() || null,
    importDisputeId: env.PAYPAL_IMPORT_DISPUTE_ID?.trim() || null,
  };
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const rawTokens = Number.parseInt(env.LLM_MAX_TOKENS?.trim() ?? "", 10);
  const effort = env.LLM_REASONING_EFFORT?.trim().toLowerCase() || null;
  return {
    enabled: (env.LLM_ENABLED ?? "false").trim().toLowerCase() === "true",
    provider: env.LLM_PROVIDER?.trim() || null,
    model: env.LLM_MODEL?.trim() || null,
    apiKeyPresent: Boolean(env.LLM_API_KEY?.trim()),
    baseUrl: env.LLM_BASE_URL?.trim().replace(/\/+$/, "") || null,
    reasoningEffort: effort,
    maxTokens: Number.isFinite(rawTokens) ? Math.min(16_384, Math.max(256, rawTokens)) : 1500,
  };
}

/** The API key is handed only to the provider adapter, never stored in config objects. */
export function readLlmApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.LLM_API_KEY?.trim() || null;
}

export function describeMode(mode: Environment): {
  label: string;
  description: string;
} {
  if (mode === "fixture") {
    return {
      label: "Fixture mode",
      description:
        "Offline demonstration with synthetic records. No PayPal or model call is made; provider steps are simulated and labelled.",
    };
  }
  return {
    label: "Sandbox mode",
    description:
      "Connected to PayPal Sandbox with your own merchant credentials. Every provider write still requires an explicit approval.",
  };
}
