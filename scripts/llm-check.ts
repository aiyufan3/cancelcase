#!/usr/bin/env tsx
/**
 * pnpm llm:check — explicit, opt-in connected-model drafting run on bundled synthetic facts.
 *
 *   pnpm llm:check --config-only   check local settings without any network call
 *   pnpm llm:check                 one live drafting run (requires LLM_ENABLED=true)
 *
 * Builds the fixture case in memory, sends the buyer's role-filtered snapshot to the configured
 * model, validates the structured claims server-side and writes a neutral ledger entry.
 * The configured service, endpoint and model identifier are private operator configuration:
 * they are never printed or written to the ledger. Precise call diagnostics (HTTP status,
 * finish reason, redacted upstream detail) go to the ignored local file
 * <DATA_DIR>/diagnostics/model-calls.jsonl. No PayPal call is made, no key is printed, and a
 * template fallback is never reported as a model run.
 */
import path from "node:path";
import {
  banner,
  llmConfigIssues,
  loadLocalEnv,
  parseArgs,
  presence,
  printTable,
  writeLedger,
} from "./lib";
import {
  LLM_REASONING_EFFORTS,
  loadAppConfig,
  loadLlmConfig,
  readLlmApiKey,
} from "@/server/config";
import { createAppContext } from "@/server/context";
import { FixtureAdapter } from "@/paypal/fixture-adapter";
import { seedFixture, readDemoHints } from "@/server/services/fixture-seed";
import { recordCancellation, requireBundle } from "@/server/services/case-service";
import {
  buildOutwardSnapshot,
  buildRoleSnapshot,
  disclosureScope,
  referenceScope,
} from "@/server/services/snapshot";
import { validateDraft } from "@/domain/claims";
import { LiveDrafter } from "@/llm/live-drafter";
import { fileDiagnostics, scrubConfigured } from "@/llm/diagnostics";
import { systemClock } from "@/domain/time";

function shapeChecks(llm: ReturnType<typeof loadLlmConfig>): { check: string; result: string }[] {
  const base = (() => {
    try {
      return llm.baseUrl ? new URL(llm.baseUrl) : null;
    } catch {
      return null;
    }
  })();
  const transport = (llm.provider ?? "").toLowerCase();
  return [
    {
      check: "transport selector",
      result:
        transport === "openai"
          ? "OpenAI-compatible Chat Completions"
          : transport === "anthropic"
            ? "Messages API"
            : llm.provider
              ? "unsupported value"
              : "missing",
    },
    { check: "model identifier", result: llm.model ? "set (value not shown)" : "missing" },
    {
      check: "base URL",
      result: !llm.baseUrl
        ? "missing"
        : !base
          ? "not a URL"
          : base.protocol !== "https:"
            ? "not https"
            : `https, ${base.pathname === "/" || base.pathname === "" ? "no path" : "with a path"} (value not shown)`,
    },
    {
      check: "request path appended",
      result:
        transport === "openai"
          ? "/chat/completions"
          : transport === "anthropic"
            ? "/v1/messages"
            : "n/a",
    },
    {
      check: "reasoning effort",
      result: !llm.reasoningEffort
        ? "not sent"
        : (LLM_REASONING_EFFORTS as readonly string[]).includes(llm.reasoningEffort)
          ? `sent as reasoning_effort=${llm.reasoningEffort}`
          : "invalid value",
    },
    { check: "max output tokens", result: String(llm.maxTokens) },
    { check: "enabled", result: llm.enabled ? "true" : "false (opt-in)" },
  ];
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  loadLocalEnv();
  banner("CancelCase — connected-model drafting check");
  printTable(
    [
      "LLM_ENABLED",
      "LLM_PROVIDER",
      "LLM_MODEL",
      "LLM_API_KEY",
      "LLM_BASE_URL",
      "LLM_REASONING_EFFORT",
      "LLM_MAX_TOKENS",
    ].map((v) => ({
      variable: v,
      presence: presence(v),
    })),
  );
  const llm = loadLlmConfig();
  console.log("");
  printTable(shapeChecks(llm));
  const dataDir = args.values.get("data-dir") ?? process.env.DATA_DIR ?? "./data/local";
  const configIssues = llmConfigIssues(llm);
  if (args.flags.has("config-only")) {
    // Presence and shape only. Nothing is called, so nothing is verified.
    if (configIssues.length > 0) {
      console.log(`\nconfig-only: ${configIssues.length} problem(s): ${configIssues.join("; ")}.`);
      console.log("RESULT config=INVALID call=NOT_MADE");
      return 2;
    }
    console.log(
      "\nconfig-only: the settings are present and well-formed. No call was made, so nothing is verified.",
    );
    console.log("RESULT config=PRESENT call=NOT_MADE");
    return 0;
  }
  if (!llm.enabled) {
    console.log(
      "\nLLM_ENABLED is not true. This check is opt-in; set LLM_ENABLED=true locally to run a live model call.",
    );
    return 2;
  }
  if (configIssues.length > 0) {
    console.log(
      `\n${configIssues.join("; ")}. Fix them in your local .env (values are never printed).`,
    );
    console.log("RESULT config=INVALID call=NOT_MADE");
    return 2;
  }

  // Synthetic facts only: in-memory fixture, buyer role, refund-request action.
  const config = loadAppConfig({
    APP_MODE: "fixture",
    DATA_DIR: dataDir,
    APP_ORIGIN: "http://127.0.0.1:3000",
  } as unknown as NodeJS.ProcessEnv);
  const ctx = createAppContext({
    config,
    inMemory: true,
    adapter: new FixtureAdapter(null, systemClock),
  });
  const seed = seedFixture(ctx);
  const hints = readDemoHints(ctx)!;
  recordCancellation(ctx, {
    caseId: seed.caseId,
    role: "buyer",
    event: {
      type: "RECORD_CONFIRMATION",
      receivedAt: hints.confirmation.receivedAt,
      effectiveAt: hints.confirmation.effectiveAt,
      basis: hints.confirmation.basis,
      evidenceIds: hints.confirmation.evidenceIds,
    },
  });
  const role = (args.values.get("role") === "merchant" ? "merchant" : "buyer") as
    "buyer" | "merchant";
  const action =
    role === "merchant"
      ? "merchant_provide_evidence"
      : args.values.get("action") === "buyer_create_dispute"
        ? "buyer_create_dispute"
        : "export_refund_request";
  const bundle = requireBundle(ctx, seed.caseId);
  // Same disclosure rule as the app: the model sees shared sources only (no private source is
  // selected for disclosure in this check), and validation rejects anything outside that scope.
  const roleSnapshot = buildRoleSnapshot(ctx, bundle, role);
  const snapshot = buildOutwardSnapshot(roleSnapshot, []);
  const scope = disclosureScope(roleSnapshot, snapshot);
  console.log(
    `\nsnapshot: ${snapshot.facts.length} facts, ${snapshot.sources.length} sources sent (${scope.undisclosedSourceIds.size} private source(s) withheld); role ${role}; action ${action}`,
  );
  console.log(
    "data: synthetic fixture facts in memory; no PayPal call; tracing is off in this check.",
  );

  const diagnosticsDir = path.resolve(dataDir, "diagnostics");
  const drafter = new LiveDrafter(llm, readLlmApiKey(), fetch, fileDiagnostics(diagnosticsDir));
  const started = Date.now();
  const result = await drafter.draft({ snapshot, action, role, attachmentEvidenceIds: [] });
  const elapsedMs = Date.now() - started;
  if (!result.ok) {
    console.log(
      `\nconnected-model drafting FAILED after ${result.calls} call(s): ${result.code} — ${result.message}`,
    );
    console.log(`private diagnostics (ignored, local only): ${diagnosticsDir}/model-calls.jsonl`);
    // The app would fall back to the labelled template here. This check does not, so that a
    // template is never reported as a model run.
    console.log(
      `RESULT origin=none model_call=FAILED(${result.code}) validation=NOT_RUN (the app would use the labelled template fallback)`,
    );
    writeLedger(dataDir, "llm-check", {
      ok: false,
      capability: "connected-model drafting",
      code: result.code,
      calls: result.calls,
      elapsedMs,
      at: new Date().toISOString(),
    });
    return 1;
  }
  // The same call as the app's persistDraft: disclosure scope and transaction-reference scope.
  const validation = validateDraft(result.content, snapshot, role, scope, referenceScope(bundle));
  console.log(
    `\nconnected model · ${result.calls} call(s) · ${elapsedMs} ms · origin ${result.origin}`,
  );
  console.log(`subject: ${result.content.subject}`);
  for (const c of result.content.claims)
    console.log(
      `  [${c.id}] (${c.kind}) ${c.text}\n       sources: ${c.sourceIds.join(", ") || "-"} facts: ${c.factIds.join(", ") || "-"}`,
    );
  console.log(`\nvalidation: ${validation.ok ? "PASSED" : "BLOCKED"}`);
  for (const i of validation.issues)
    console.log(
      `  ${i.blocking ? "✖" : "•"} ${i.code}${i.claimId ? ` (${i.claimId})` : ""}: ${i.message}`,
    );
  for (const n of result.notes) console.log(`note: ${n}`);
  const file = writeLedger(dataDir, "llm-check", {
    ok: true,
    capability: "connected-model drafting",
    origin: result.origin,
    calls: result.calls,
    elapsedMs,
    claimCount: result.content.claims.length,
    validationOk: validation.ok,
    issues: validation.issues.map((i) => ({
      code: i.code,
      claimId: i.claimId,
      blocking: i.blocking,
    })),
    at: new Date().toISOString(),
  });
  console.log(`ledger written: ${file}`);
  console.log(
    `RESULT origin=${result.origin} model_call=OK validation=${validation.ok ? "PASSED" : "BLOCKED"}`,
  );
  return validation.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(
      `llm:check failed: ${scrubConfigured(err instanceof Error ? err.message : String(err), [process.env.LLM_MODEL, process.env.LLM_BASE_URL, process.env.LLM_API_KEY])}`,
    );
    process.exit(1);
  });
