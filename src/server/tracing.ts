import os from "node:os";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { AppContext } from "./context";
import { EXTERNAL_TRACING_FLAGS, startupTracingEnv } from "./config";
import { redactText } from "@/paypal/redact";
import type { ActionKind, Role } from "@/domain/types";

/**
 * Optional LangSmith tracing of the case graph. Off by default.
 *
 * It is on only when LANGSMITH_TRACING=true and LANGSMITH_API_KEY are both set (see
 * readTracing in ./config); otherwise this module loads nothing and adds nothing to a run. When on,
 * each graph run carries LangChain's own LangChainTracer with an official langsmith client whose
 * hideInputs, hideOutputs, hideMetadata and anonymizer hooks all pass through redactForTrace, and
 * runtime details about this machine are omitted. Nothing leaves the process before redaction.
 *
 * LangChain's automatic tracer, which its environment switches would start, is switched off for
 * the whole process: it would send any LangChain run that does not carry this tracer (a toolkit
 * read, for example) without redaction.
 *
 * A trace carries run names (the graph nodes gather, draft, review, execute and readback),
 * timings, errors, tags and metadata (case ID, mode, role, action) and the thread state the nodes
 * read and write: IDs, versions, flags, statuses and short log lines. Drafts, evidence, PayPal
 * request and response bodies, prompts and credentials are not part of that state. An error is
 * sent as one redacted line, without its stack trace or any file path (see redactTraceError).
 */

/** Remove LangChain's tracing switches from this process's environment, after reading them once. */
export function switchOffAutomaticTracing(): void {
  startupTracingEnv();
  for (const name of EXTERNAL_TRACING_FLAGS) delete process.env[name];
}

const SECRET_KEY =
  /(api[_-]?key|secret|token|password|passphrase|authorization|cookie|credential|assertion|client[_-]?id)/i;
const PERSONAL_KEY =
  /^(e-?mail|email_address|payer_email|buyer_email|name|full_name|given_name|surname|buyer_name|payer_name|address|address_line_[12]|admin_area_[12]|postal_code|phone|phone_number|national_number)$/i;
const FREE_TEXT_KEY = /^(reason|note|notes|text|body|summary|comment|description|content)$/i;
/** A placeholder this function wrote. langsmith's batch path redacts a run twice; it stays as is. */
const REDACTION_MARKER =
  /^\[(?:redacted-[a-z]+(?:: \d+ characters)?|paypal-id|path|truncated|circular)\]$/;
/** PayPal case, subscription, plan, product, order and agreement IDs, and transaction IDs. */
const PAYPAL_ID =
  /\b(?:PP-[DR]-[A-Z0-9-]{4,}|(?:I|P|PROD|EC|BA|PAYID|PAY|CAPT|WH)-[A-Z0-9]{8,}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{17})\b/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact a value before it is traced. Secrets, tokens and credentials, personal fields (email,
 * name, address, phone), free text (a rejection reason, a note), email addresses, bearer and
 * basic credentials, long opaque strings, PayPal identifiers and the given names (the buyer's) are
 * replaced; IDs of this application, statuses, numbers and flags are kept.
 */
export function redactForTrace(value: unknown, knownNames: readonly string[] = []): unknown {
  const names = [...new Set(knownNames.map((n) => n.trim()).filter((n) => n.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  const nameRe = names.length > 0 ? new RegExp(names.map(escapeRegExp).join("|"), "gi") : null;
  const text = (s: string): string => {
    const out = redactText(s, 4000).replace(PAYPAL_ID, "[paypal-id]");
    return nameRe ? out.replace(nameRe, "[redacted-name]") : out;
  };
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return text(v);
    if (typeof v === "function" || typeof v === "symbol") return undefined;
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Date) return v.toISOString();
    if (depth > 12) return "[truncated]";
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(v)) {
      if (SECRET_KEY.test(key)) out[key] = "[redacted-secret]";
      else if (PERSONAL_KEY.test(key)) out[key] = "[redacted-personal]";
      else if (FREE_TEXT_KEY.test(key) && typeof item === "string")
        out[key] = REDACTION_MARKER.test(item)
          ? item
          : `[redacted-text: ${item.length} characters]`;
      else out[key] = walk(item, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/** Stack frames ("    at fn (file:line:col)") and absolute file paths, for redactTraceError. */
const STACK_FRAME = /^\s*at\s.*$/gm;
const FILE_PATH = /(?:\b[A-Za-z]:)?(?:[\\/][\w.@+-]+){2,}[\\/]?/g;

/**
 * LangChain reports an error as its message, a blank line and the stack trace, which holds this
 * machine's file paths; a pause for review arrives as an error too (LangGraph's interrupt). The
 * langsmith client has no hook for errors, so the tracer's client passes each one through here:
 * only the message is kept, on one line, without stack frames or file paths, then redacted like
 * everything else.
 */
export function redactTraceError(error: unknown, knownNames: readonly string[] = []): string {
  let message = String(error ?? "").split(/\n\s*\n/)[0] ?? "";
  for (const local of [process.cwd(), os.homedir()])
    if (local.length > 1) message = message.split(local).join("[path]");
  const line = message
    .replace(STACK_FRAME, "")
    .replace(FILE_PATH, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return redactForTrace(line, knownNames) as string;
}

/** How a context's tracer reaches LangSmith. Tests supply a fake transport; production uses the key. */
export interface TraceTransport {
  apiKey: string;
  apiUrl?: string;
  fetchImplementation?: typeof fetch;
  autoBatchTracing?: boolean;
}

interface TracerParts {
  client: { awaitPendingTraceBatches(): Promise<void> };
  makeTracer(projectName: string): NonNullable<RunnableConfig["callbacks"]>;
}

const transports = new WeakMap<AppContext, TraceTransport>();
const tracers = new WeakMap<AppContext, Promise<TracerParts>>();
/** Names to redact in every trace of this process (each traced case adds its buyer's name). */
const knownNames = new Set<string>();

/** Use this transport for the context's tracer (tests). */
export function setTraceTransport(ctx: AppContext, transport: TraceTransport): void {
  transports.set(ctx, transport);
  tracers.delete(ctx);
}

function tracerParts(ctx: AppContext): Promise<TracerParts> {
  let parts = tracers.get(ctx);
  if (!parts) {
    parts = (async () => {
      const [{ Client }, { LangChainTracer }] = await Promise.all([
        import("langsmith"),
        import("@langchain/core/tracers/tracer_langchain"),
      ]);
      const transport = transports.get(ctx) ?? {
        apiKey: process.env.LANGSMITH_API_KEY ?? startupTracingEnv().LANGSMITH_API_KEY ?? "",
      };
      const hide = (v: Record<string, unknown>) =>
        redactForTrace(v, [...knownNames]) as Record<string, unknown>;
      const client = new Client({
        apiKey: transport.apiKey,
        ...(transport.apiUrl ? { apiUrl: transport.apiUrl } : {}),
        ...(transport.fetchImplementation
          ? { fetchImplementation: transport.fetchImplementation }
          : {}),
        autoBatchTracing: transport.autoBatchTracing ?? true,
        blockOnRootRunFinalization: false,
        omitTracedRuntimeInfo: true,
        hideInputs: hide,
        hideOutputs: hide,
        hideMetadata: hide,
        anonymizer: hide,
      });
      // Every run reaches LangSmith through these two methods; an error passes redactTraceError.
      const withCleanError = <T extends { error?: unknown }>(run: T): T =>
        run.error ? { ...run, error: redactTraceError(run.error, [...knownNames]) } : run;
      const createRun = client.createRun.bind(client);
      client.createRun = (run, options) => createRun(withCleanError(run), options);
      const updateRun = client.updateRun.bind(client);
      client.updateRun = (runId, run, options) => updateRun(runId, withCleanError(run), options);
      return {
        client,
        makeTracer: (projectName: string) => [new LangChainTracer({ client, projectName })],
      };
    })();
    tracers.set(ctx, parts);
  }
  return parts;
}

/**
 * The run options that trace one graph run: nothing when tracing is off. When on, a tracer, a
 * readable run name and the case ID, mode, role and action as tags and metadata.
 */
export async function traceConfig(
  ctx: AppContext,
  run: {
    caseId: string;
    role: Role;
    action: ActionKind;
    name: string;
    knownNames: () => string[];
  },
): Promise<Partial<RunnableConfig>> {
  switchOffAutomaticTracing();
  if (!ctx.config.tracing.enabled) return {};
  for (const name of run.knownNames()) if (name.trim()) knownNames.add(name.trim());
  const parts = await tracerParts(ctx);
  return {
    callbacks: parts.makeTracer(ctx.config.tracing.project),
    runName: run.name,
    tags: [
      `case:${run.caseId}`,
      `mode:${ctx.config.mode}`,
      `role:${run.role}`,
      `action:${run.action}`,
    ],
    metadata: { case_id: run.caseId, mode: ctx.config.mode, role: run.role, action: run.action },
  };
}

/** Wait until every traced run of this context has been handed to LangSmith (tests, shutdown). */
export async function flushTraces(ctx: AppContext): Promise<void> {
  const parts = tracers.get(ctx);
  if (!ctx.config.tracing.enabled || !parts) return;
  const { awaitAllCallbacks } = await import("@langchain/core/callbacks/promises");
  await awaitAllCallbacks();
  await (await parts).client.awaitPendingTraceBatches();
}
