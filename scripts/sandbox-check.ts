#!/usr/bin/env tsx
/**
 * pnpm sandbox:check — read-only Sandbox capability diagnostic.
 *
 * Apart from issuing an OAuth token, nothing here writes anything anywhere: no product, plan,
 * subscription or dispute is created. Credentials are loaded server-side from .env and never
 * printed. The result is a redacted ledger (data/local/ledger/) with VERIFIED / BLOCKED /
 * NOT_TESTED per capability, plus the specific missing setting or step for each blocker.
 */
import {
  banner,
  classifyToolkitList,
  llmConfigIssues,
  loadLocalEnv,
  parseArgs,
  presence,
  printTable,
  writeLedger,
} from "./lib";
import { ConfigError, loadLlmConfig, loadPayPalConfig } from "@/server/config";
import { PayPalRestClient, SCOPES, buildBuyerAuthAssertion } from "@/paypal/rest-client";
import { SandboxAdapter } from "@/paypal/sandbox-adapter";
import { createReadOnlyToolkit, EXPECTED_READ_TOOL_NAMES } from "@/paypal/toolkit";
import { canProvideEvidence } from "@/domain/provider-state";
import { systemClock } from "@/domain/time";
import { maskId } from "@/paypal/redact";

type State = "VERIFIED" | "BLOCKED" | "NOT_TESTED";

interface Entry {
  capability: string;
  state: State;
  detail: string;
  correlationId?: string | null;
  httpStatus?: number | null;
  nextStep?: string;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const envFile = loadLocalEnv();
  const dataDir = args.values.get("data-dir") ?? process.env.DATA_DIR ?? "./data/local";
  banner("CancelCase — Sandbox capability check (read-only)");
  console.log(
    `.env: ${envFile.loaded ? "loaded (values never printed)" : "not found; relying on the process environment"}`,
  );
  const vars = [
    "PAYPAL_ENV",
    "PAYPAL_BASE_URL",
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "PAYPAL_ENABLE_BUYER_DISPUTES",
    "PAYPAL_BUYER_EMAIL",
    "PAYPAL_IMPORT_DISPUTE_ID",
    "LLM_ENABLED",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_API_KEY",
  ];
  printTable(vars.map((v) => ({ variable: v, presence: presence(v) })));

  const entries: Entry[] = [];
  const startedAt = new Date().toISOString();
  let paypal;
  try {
    paypal = loadPayPalConfig();
  } catch (err) {
    const e = err as ConfigError;
    entries.push({
      capability: "configuration",
      state: "BLOCKED",
      detail: `${e.code}: ${e.message}`,
      nextStep: "Fix the named variable in your local .env (Sandbox only).",
    });
    report(entries, dataDir, startedAt, null);
    return 1;
  }
  entries.push({
    capability: "configuration",
    state: "VERIFIED",
    detail: `Sandbox origin ${paypal.origin}; buyer path ${paypal.buyerDisputesEnabled ? "enabled flag set" : "disabled"}; buyer email ${paypal.buyerEmail ? "set" : "unset"}; import dispute id ${paypal.importDisputeId ? "set" : "unset"}`,
  });

  const client = new PayPalRestClient(
    { baseUrl: paypal.baseUrl, clientId: paypal.clientId, clientSecret: paypal.clientSecret },
    systemClock,
  );
  const token = await client.getToken();
  if (!token.ok) {
    entries.push({
      capability: "merchant auth (client_credentials token)",
      state: "BLOCKED",
      detail: `${token.error.code}: ${token.error.message}`,
      correlationId: token.error.correlationId,
      httpStatus: token.error.httpStatus,
      nextStep:
        token.error.httpStatus === 401
          ? "Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for the Sandbox REST app."
          : "Check network access to the Sandbox origin from this machine.",
    });
    report(entries, dataDir, startedAt, null);
    return 1;
  }
  const scopes = token.data.scopes;
  entries.push({
    capability: "merchant auth (client_credentials token)",
    state: "VERIFIED",
    detail: `token issued; ${scopes.length} scope(s); app id ${token.data.appId ? maskId(token.data.appId) : "n/a"}`,
  });
  const scopeRows = Object.entries(SCOPES).map(([k, uri]) => ({
    scope: k,
    uri,
    granted: scopes.includes(uri) ? "yes" : "no",
  }));
  printTable(scopeRows);

  // Toolkit through the application path (read-only allowlist).
  try {
    const toolkit = createReadOnlyToolkit({
      clientId: paypal.clientId,
      clientSecret: paypal.clientSecret,
    });
    const raw = await toolkit.invoke("list_disputes", { page_size: 5 });
    entries.push({
      capability: "toolkit read tool (list_disputes)",
      ...classifyToolkitList(raw, toolkit.toolNames),
    });
  } catch (err) {
    entries.push({
      capability: "toolkit read tool (list_disputes)",
      state: "BLOCKED",
      detail: redactError(err),
      nextStep: "Toolkit call failed; see the direct REST read below for the underlying status.",
    });
  }
  void EXPECTED_READ_TOOL_NAMES;

  // Direct REST reads.
  const adapter = new SandboxAdapter(client, systemClock, {
    clientId: paypal.clientId,
    buyerEmail: paypal.buyerEmail,
    buyerDisputesEnabled: paypal.buyerDisputesEnabled,
  });
  const disputes = await adapter.listDisputes({ pageSize: 5 });
  entries.push(
    disputes.ok
      ? {
          capability: "disputes read (seller)",
          state: "VERIFIED",
          detail: `GET /v1/customer/disputes ok; ${disputes.data.items.length} item(s) on page 1`,
          correlationId: disputes.correlationId,
        }
      : {
          capability: "disputes read (seller)",
          state: "BLOCKED",
          detail: `${disputes.error.code}: ${disputes.error.message}`,
          correlationId: disputes.error.correlationId,
          httpStatus: disputes.error.httpStatus,
          nextStep: "Enable Customer disputes under the REST app's Sandbox features.",
        },
  );
  for (const [label, pathName] of [
    ["subscriptions read (plans)", "/v1/billing/plans?page_size=5"],
    ["catalog read (products)", "/v1/catalogs/products?page_size=5"],
  ] as const) {
    const r = await client.read<Record<string, unknown>>(pathName);
    entries.push(
      r.ok
        ? {
            capability: label,
            state: "VERIFIED",
            detail: `GET ${pathName.split("?")[0]} ok`,
            correlationId: r.debugId,
          }
        : {
            capability: label,
            state: "BLOCKED",
            detail: `${r.error.code}: ${r.error.message}`,
            correlationId: r.error.correlationId,
            httpStatus: r.error.httpStatus,
          },
    );
  }
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
  const reporting = await client.read<Record<string, unknown>>(
    `/v1/reporting/transactions?start_date=${encodeURIComponent(start.toISOString())}&end_date=${encodeURIComponent(end.toISOString())}&page_size=5`,
  );
  entries.push(
    reporting.ok
      ? {
          capability: "transaction search (reporting, last 30 days)",
          state: "VERIFIED",
          detail: `GET /v1/reporting/transactions ok (results may lag up to three hours)`,
          correlationId: reporting.debugId,
        }
      : {
          capability: "transaction search (reporting, last 30 days)",
          state: "BLOCKED",
          detail: `${reporting.error.code}: ${reporting.error.message}`,
          correlationId: reporting.error.correlationId,
          httpStatus: reporting.error.httpStatus,
          nextStep:
            "Enable Transaction Search for the REST app if this path is needed; known-object read-back does not depend on it.",
        },
  );

  // Buyer path feasibility (read-only).
  const hasCreate = scopes.includes(SCOPES.disputesCreate);
  const hasUpdateBuyer = scopes.includes(SCOPES.disputesUpdateBuyer);
  if (!hasCreate) {
    entries.push({
      capability: "buyer dispute creation (scope)",
      state: "BLOCKED",
      detail: `token lacks ${SCOPES.disputesCreate}${hasUpdateBuyer ? "" : ` and ${SCOPES.disputesUpdateBuyer}`}`,
      nextStep:
        "Documented path: a PayPal account manager must add the create scope to the REST app, then the Sandbox Personal account grants consent through Log in with PayPal. Fallback: create the test case manually in the Sandbox Resolution Center and import it (pnpm sandbox:setup --import-dispute <ID>).",
    });
  } else {
    entries.push({
      capability: "buyer dispute creation (scope)",
      state: "VERIFIED",
      detail: "create scope present on the token (consent and assertion still required)",
    });
  }
  if (paypal.buyerDisputesEnabled && paypal.buyerEmail) {
    const assertion = buildBuyerAuthAssertion(paypal.clientId, paypal.buyerEmail);
    const probe = await client.request<Record<string, unknown>>(
      "GET",
      "/v1/customer/disputes?page_size=1",
      { kind: "read", authAssertion: assertion },
    );
    entries.push(
      probe.ok
        ? {
            capability: "buyer assertion accepted (read probe)",
            state: "VERIFIED",
            detail: "GET /v1/customer/disputes with PayPal-Auth-Assertion returned 2xx",
            correlationId: probe.debugId,
          }
        : {
            capability: "buyer assertion accepted (read probe)",
            state: "BLOCKED",
            detail: /target_client_id/i.test(probe.error.message)
              ? `buyer consent for this app is not on record (${probe.error.code}: ${probe.error.message})`
              : `${probe.error.code}: ${probe.error.message}`,
            correlationId: probe.error.correlationId,
            httpStatus: probe.error.httpStatus,
            nextStep:
              "Enable Log in with PayPal for the Sandbox app, then open the link from pnpm sandbox:setup --consent-url as the Sandbox Personal account (scopes: disputes create and read-buyer) and re-run. The assertion alone does not confer access.",
          },
    );
  } else {
    entries.push({
      capability: "buyer assertion accepted (read probe)",
      state: "NOT_TESTED",
      detail: "PAYPAL_ENABLE_BUYER_DISPUTES is not true or PAYPAL_BUYER_EMAIL is unset",
      nextStep: "Set both locally only after scope and consent exist; no password is ever needed.",
    });
  }

  // Merchant evidence feasibility on a privately configured case.
  if (paypal.importDisputeId) {
    const read = await adapter.getDispute(paypal.importDisputeId);
    if (!read.ok) {
      entries.push({
        capability: "merchant evidence capability (configured case)",
        state: "BLOCKED",
        detail: `${read.error.code}: ${read.error.message}`,
        correlationId: read.error.correlationId,
        httpStatus: read.error.httpStatus,
      });
    } else {
      const cap = canProvideEvidence(read.data.observation, "merchant", systemClock, {
        requireRealProvider: true,
      });
      entries.push({
        capability: "merchant evidence capability (configured case)",
        state: cap.allowed ? "VERIFIED" : "BLOCKED",
        detail: `case ${maskId(paypal.importDisputeId)} status ${read.data.observation.status ?? "unknown"} stage ${read.data.observation.stage ?? "unknown"}; actions [${read.data.observation.allowedActions.join(", ")}]; requested evidence [${read.data.observation.requestedEvidenceTypes.join(", ")}]; rejected links ${read.data.summary.rejectedLinks.length}`,
        correlationId: read.correlationId,
        nextStep: cap.allowed
          ? "Import it with pnpm sandbox:setup --import-dispute <ID> and draft the merchant response."
          : `Blocked by ${cap.codes.join(", ")}. A case accepts seller evidence only in WAITING_FOR_SELLER_RESPONSE with a provide-evidence link.`,
      });
    }
  } else {
    entries.push({
      capability: "merchant evidence capability (configured case)",
      state: "NOT_TESTED",
      detail: "PAYPAL_IMPORT_DISPUTE_ID is unset",
      nextStep: "After a Sandbox case exists, set PAYPAL_IMPORT_DISPUTE_ID locally and re-run.",
    });
  }

  const llm = loadLlmConfig();
  entries.push({
    capability: "LLM configuration",
    // Settings being present is not a test: only pnpm llm:check calls the model.
    state: "NOT_TESTED",
    // Neutral by design: the configured service, endpoint and model stay private.
    detail: `enabled=${llm.enabled} transport=${llm.provider ? "set" : "unset"} model=${llm.model ? "set" : "unset"} base=${llm.baseUrl ? "set" : "unset"} key=${llm.apiKeyPresent ? "set" : "unset"}; shape ${llmConfigIssues(llm).length === 0 ? "well-formed" : "has problems"}; no call made`,
    nextStep: "Run pnpm llm:check for a live drafting test (no PayPal writes).",
  });

  report(entries, dataDir, startedAt, { scopes, origin: paypal.origin });
  return entries.some((e) => e.capability.startsWith("merchant auth") && e.state === "BLOCKED")
    ? 1
    : 0;
}

function redactError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 300);
}

function report(
  entries: Entry[],
  dataDir: string,
  startedAt: string,
  extra: { scopes: string[]; origin: string } | null,
): void {
  console.log("");
  printTable(
    entries.map((e) => ({
      capability: e.capability,
      state: e.state,
      detail: e.detail.slice(0, 110),
    })),
  );
  console.log("");
  for (const e of entries)
    if (e.nextStep && e.state !== "VERIFIED") console.log(`• ${e.capability}: ${e.nextStep}`);
  const tier = recommendTier(entries);
  console.log(`\nHighest honest connected tier right now: ${tier}`);
  const file = writeLedger(dataDir, "sandbox-check", {
    schema: "cancelcase.ledger/1",
    kind: "sandbox-check",
    startedAt,
    finishedAt: new Date().toISOString(),
    tier,
    entries,
    extra,
  });
  console.log(`ledger written: ${file} (redacted; private runtime data)`);
}

function recommendTier(entries: Entry[]): string {
  const state = (name: string) => entries.find((e) => e.capability.startsWith(name))?.state;
  if (state("merchant auth") !== "VERIFIED") return "D — fixtures only (no Sandbox auth)";
  if (
    state("buyer assertion accepted") === "VERIFIED" &&
    state("buyer dispute creation") === "VERIFIED"
  )
    return "A — full Sandbox path may be possible (buyer create + merchant evidence still need live confirmation)";
  if (state("merchant evidence capability") === "VERIFIED")
    return "B — manual buyer case + connected merchant read/evidence";
  if (state("disputes read") === "VERIFIED")
    return "C — connected merchant read + export; writes pending a case";
  return "C/D — Sandbox auth works but reads are blocked; check app features";
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`sandbox:check failed: ${redactError(err)}`);
    process.exit(1);
  });
