#!/usr/bin/env tsx
/**
 * pnpm sandbox:setup — explicit, previewed Sandbox resource setup (operator-approved).
 *
 *   pnpm sandbox:setup --preview                 show what would be created; token only
 *   pnpm sandbox:setup --confirm                 record a fixed setup intent, then create product → plan →
 *                                                subscription (one recorded write each); re-running continues
 *                                                the same intent and never repeats a succeeded stage
 *   pnpm sandbox:setup --new-intent --interval DAY [--start-in <minutes>] [--confirm]
 *                                                after the current setup is complete, record a further intent
 *                                                (for example a daily plan) and create its product → plan →
 *                                                subscription; without --confirm it only shows the preview.
 *                                                --start-in delays the first billing by that many minutes after
 *                                                the subscription request, so the buyer can approve and a
 *                                                cancellation can be recorded before any payment exists
 *   pnpm sandbox:setup --replace-subscription    create a new subscription for the same plan after PayPal dropped
 *                                                an unapproved one (only when a fresh read says "not found")
 *   pnpm sandbox:setup --recover <stage> (--resource <ID> | --not-created) --note "<text>"
 *                                                settle a stage whose result is unknown after checking the
 *                                                Sandbox Developer Dashboard
 *   pnpm sandbox:setup --resume                  read the subscription back after you approved it in the browser;
 *                                                when ACTIVE, create the connected case from its transactions
 *   pnpm sandbox:setup --import-dispute <ID>     import a Sandbox case created manually (tier B) and read it back
 *   pnpm sandbox:setup --cancel --confirm        separately approved Sandbox test mutation: cancel the subscription
 *   pnpm sandbox:setup --require-evidence --case <caseId> [--confirm]
 *   pnpm sandbox:setup --adjudicate --case <caseId> --outcome BUYER_FAVOR|SELLER_FAVOR [--confirm]
 *                                                separately approved Sandbox test mutation: PayPal's own
 *                                                simulation of its decision on a case under review (only
 *                                                when a fresh read offers it; no live counterpart)
 *                                                separately approved Sandbox test mutation: PayPal's own
 *                                                simulation that moves a case under review back to waiting
 *                                                for the seller's evidence (only when a fresh read offers it)
 *   pnpm sandbox:setup --consent-url              print the Sandbox "Log in with PayPal" consent link for the buyer
 *                                                dispute scopes (no network call); open it as the Sandbox Personal
 *                                                account, then run pnpm sandbox:check
 *   pnpm sandbox:setup --buyer-transaction <ID> --case <caseId>
 *                                                record the buyer-side PayPal transaction ID (read from the Sandbox
 *                                                buyer account) as an operator attestation for the buyer case path
 *
 * Every provider write is a ledger operation with a CLI approval record. The operation ledger is
 * the source of truth; the private manifest (data/local/sandbox/setup-manifest.json) is a readable
 * checkpoint that is rebuilt from the ledger if it is missing.
 * The approval URL is printed for your own browser; it is never stored in a public file.
 */
import { banner, confirm, loadLocalEnv, parseArgs, writeLedger } from "./lib";
import { randomBytes } from "node:crypto";
import { loadAppConfig, loadPayPalConfig } from "@/server/config";
import { buildBuyerConsentUrl } from "@/paypal/rest-client";
import { createAppContext } from "@/server/context";
import {
  SETUP_STAGES,
  cancelSandboxSubscription,
  defaultPreview,
  importDispute,
  loadSetupState,
  parseStartDelayMinutes,
  prepareSetupIntent,
  recordBuyerTransactionReference,
  recoverSetupStage,
  replaceExpiredSubscription,
  requestAdjudicationSimulation,
  requestSellerEvidenceSimulation,
  resumeSubscriptionSetup,
  SUBSCRIPTION_NOT_FOUND,
  runSubscriptionSetup,
  startNewSetupIntent,
  type SetupManifest,
  type SetupStageName,
} from "@/server/services/setup-service";
import { maskId } from "@/paypal/redact";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  loadLocalEnv();
  process.env.APP_MODE = "sandbox";
  const config = loadAppConfig(process.env);
  const ctx = createAppContext({ config });
  banner("CancelCase — Sandbox setup");
  console.log(`mode: sandbox (${ctx.adapter.label}); data dir ${config.envDir}`);
  const buyerAlias = args.values.get("buyer-alias") ?? "Sandbox Buyer";
  const merchantAlias = args.values.get("merchant-alias") ?? "Sandbox Merchant";

  if (args.flags.has("consent-url")) {
    const paypal = loadPayPalConfig();
    const state = randomBytes(8).toString("hex");
    const returnUrl = `${config.appOrigin}/sandbox/consent`;
    console.log("Buyer consent (Log in with PayPal, Sandbox). Nothing was sent.");
    console.log(
      `1. In the Developer Dashboard, Sandbox app → Log in with PayPal → Return URL: ${returnUrl}`,
    );
    console.log("2. Open this link in your browser and sign in as the Sandbox Personal account:");
    console.log(buildBuyerConsentUrl(paypal.clientId, returnUrl, state));
    console.log(
      "3. Then run pnpm sandbox:check; only the buyer assertion probe shows whether consent took effect.",
    );
    return 0;
  }

  if (args.values.has("buyer-transaction")) {
    const caseId = args.values.get("case");
    if (!caseId) {
      console.error("--buyer-transaction requires --case <caseId>.");
      return 2;
    }
    const charge = recordBuyerTransactionReference(
      ctx,
      caseId,
      args.values.get("buyer-transaction")!,
    );
    console.log(
      `recorded buyer transaction reference for charge ${charge.id} (operator attestation; masked ${maskId(args.values.get("buyer-transaction")!.toUpperCase())}).`,
    );
    return 0;
  }

  if (args.values.has("import-dispute")) {
    const id = args.values.get("import-dispute")!;
    const result = await importDispute(ctx, id, {
      buyerAlias,
      merchantAlias,
      caseId: args.values.get("case") ?? null,
    });
    console.log(
      `imported case ${result.caseId} from dispute ${maskId(id)}: status ${result.status ?? "unknown"}, stage ${result.stage ?? "unknown"}, actions [${result.allowedActions.join(", ")}]`,
    );
    console.log(`open: ${config.appOrigin}/cases/${result.caseId} (pnpm demo:sandbox)`);
    writeLedger(config.dataDir, "sandbox-import", {
      caseId: result.caseId,
      status: result.status,
      stage: result.stage,
      allowedActions: result.allowedActions,
      at: new Date().toISOString(),
    });
    return 0;
  }

  if (args.flags.has("require-evidence")) {
    const caseId = args.values.get("case");
    if (!caseId) {
      console.error("--require-evidence needs --case <caseId>.");
      return 2;
    }
    console.log(
      `This is a labelled Sandbox TEST mutation: ask PayPal to move the provider case of ${caseId} from "under review" back to "waiting for the seller's response" (POST …/require-evidence, Sandbox simulation).`,
    );
    console.log(
      "It is sent only if a fresh read offers it. It changes nothing in the case's facts, drafts or evidence.",
    );
    if (
      !(await confirm(
        "Send the evidence-request simulation to PayPal Sandbox?",
        args.flags.has("confirm") || args.flags.has("yes"),
      ))
    )
      return 1;
    const sim = await requestSellerEvidenceSimulation(ctx, caseId);
    console.log(
      `operation ${sim.operation.id}: ${sim.operation.status}${sim.operation.errorCode ? ` (${sim.operation.errorCode}: ${sim.operation.errorMessage})` : ""}`,
    );
    console.log(
      `provider status before: ${sim.statusBefore ?? "unknown"}; after: ${sim.statusAfter ?? "not read"}; actions now [${sim.allowedAfter.join(", ")}]`,
    );
    writeLedger(config.dataDir, "sandbox-require-evidence", {
      caseId,
      operationStatus: sim.operation.status,
      statusBefore: sim.statusBefore,
      statusAfter: sim.statusAfter,
      allowedAfter: sim.allowedAfter,
      at: new Date().toISOString(),
    });
    return sim.operation.status === "SUCCEEDED" ? 0 : 1;
  }

  if (args.flags.has("adjudicate")) {
    const caseId = args.values.get("case");
    const outcome = (args.values.get("outcome") ?? "").toUpperCase();
    if (!caseId || (outcome !== "BUYER_FAVOR" && outcome !== "SELLER_FAVOR")) {
      console.error(
        "--adjudicate needs --case <caseId> and --outcome BUYER_FAVOR or SELLER_FAVOR.",
      );
      return 2;
    }
    const favour = outcome === "BUYER_FAVOR" ? "the buyer's" : "the seller's";
    console.log(
      `This is a labelled Sandbox TEST mutation: ask PayPal Sandbox to settle the provider case of ${caseId} in ${favour} favour (POST …/adjudicate, Sandbox simulation of PayPal's own decision).`,
    );
    console.log(
      "PayPal has no such call in the live environment. It is sent only if a fresh read offers it, and it changes nothing in the case's facts, drafts or evidence.",
    );
    if (
      !(await confirm(
        `Send the settlement simulation (${outcome}) to PayPal Sandbox?`,
        args.flags.has("confirm") || args.flags.has("yes"),
      ))
    )
      return 1;
    const sim = await requestAdjudicationSimulation(ctx, caseId, outcome);
    console.log(
      `operation ${sim.operation.id}: ${sim.operation.status}${sim.operation.errorCode ? ` (${sim.operation.errorCode}: ${sim.operation.errorMessage})` : ""}`,
    );
    console.log(
      `provider status before: ${sim.statusBefore ?? "unknown"}; after: ${sim.statusAfter ?? "not read"}; outcome: ${sim.outcomeAfter ?? "none read"}; actions now [${sim.allowedAfter.join(", ")}]`,
    );
    writeLedger(config.dataDir, "sandbox-adjudicate", {
      caseId,
      outcome,
      operationStatus: sim.operation.status,
      statusBefore: sim.statusBefore,
      statusAfter: sim.statusAfter,
      outcomeAfter: sim.outcomeAfter,
      allowedAfter: sim.allowedAfter,
      at: new Date().toISOString(),
    });
    return sim.operation.status === "SUCCEEDED" ? 0 : 1;
  }

  if (args.flags.has("cancel")) {
    const manifest = loadSetupState(ctx);
    if (!manifest?.subscriptionId) {
      console.error("no Sandbox subscription has been created.");
      return 2;
    }
    console.log(
      `This is a labelled Sandbox TEST mutation: cancel subscription ${maskId(manifest.subscriptionId)} at the provider.`,
    );
    console.log(
      "It records a provider observation; it does not change any user's cancellation attestation.",
    );
    if (
      !(await confirm(
        "Cancel the Sandbox subscription at PayPal?",
        args.flags.has("confirm") || args.flags.has("yes"),
      ))
    )
      return 1;
    const op = await cancelSandboxSubscription(
      ctx,
      args.values.get("reason") ?? "CancelCase Sandbox test: cancelled by operator",
    );
    console.log(
      `operation ${op.id}: ${op.status}${op.errorCode ? ` (${op.errorCode}: ${op.errorMessage})` : ""}`,
    );
    return op.status === "SUCCEEDED" ? 0 : 1;
  }

  if (args.flags.has("resume")) {
    const result = await resumeSubscriptionSetup(ctx, { buyerAlias, merchantAlias });
    console.log(
      `subscription ${maskId(result.manifest.subscriptionId)}: status ${result.status ?? "unknown"}; ${result.transactions.length} transaction(s) in the last 90 days`,
    );
    for (const t of result.transactions)
      console.log(
        `  ${t.time ?? "?"}  ${t.status ?? "?"}  ${t.amountValue ?? "?"} ${t.amountCurrency ?? ""}  ${maskId(t.id)}`,
      );
    if (result.error) console.log(`note: ${result.error}`);
    if (result.status === SUBSCRIPTION_NOT_FOUND) {
      console.log(
        "\nPayPal no longer returns this subscription. A subscription nobody approved is dropped after a few hours; the product and plan are still there.",
      );
      console.log(
        "Create a replacement for the same plan with: pnpm sandbox:setup --replace-subscription, then approve it in your browser right away.",
      );
    }
    if (result.status === "APPROVAL_PENDING") {
      console.log(
        "\nThe buyer has not approved yet. Log in with the Sandbox Personal account in your browser:",
      );
      console.log(
        result.manifest.approveUrl ??
          "(no approve URL returned; read the subscription in the Developer Dashboard)",
      );
    }
    if (result.nextBillingTime) console.log(`next billing (as read): ${result.nextBillingTime}`);
    for (const id of result.laterPaymentCaseIds)
      console.log(
        `later payment: new connected case ${id} (shares the subscription's cancellation facts)`,
      );
    if (result.caseId)
      console.log(
        `\nconnected case: ${result.caseId} → ${config.appOrigin}/cases/${result.caseId} (pnpm demo:sandbox)`,
      );
    writeLedger(config.dataDir, "sandbox-resume", {
      status: result.status,
      transactionCount: result.transactions.length,
      caseId: result.caseId,
      at: new Date().toISOString(),
    });
    return 0;
  }

  if (args.flags.has("replace-subscription")) {
    const state = loadSetupState(ctx);
    if (!state?.subscriptionId) {
      console.error("No Sandbox subscription has been created yet; run --confirm first.");
      return 2;
    }
    printStages(state);
    console.log(
      `\nThis creates one new Sandbox subscription for the existing plan ${maskId(state.planId) ?? "-"} (POST /v1/billing/subscriptions), only if PayPal reports the current subscription ${maskId(state.subscriptionId)} as not found. Product and plan are reused.`,
    );
    if (!(await confirm("Create the replacement Sandbox subscription now?", args.flags.has("yes"))))
      return 1;
    const result = await replaceExpiredSubscription(ctx);
    printStages(result.manifest);
    if (result.stoppedAt === null) {
      console.log(
        "\nNext (manual, now — PayPal drops unapproved subscriptions after a few hours), with the Sandbox Personal account:",
      );
      console.log(result.manifest.approveUrl ?? "(no approve URL returned)");
      console.log("\nThen run: pnpm sandbox:setup --resume");
    } else if (result.reason === "UNKNOWN") {
      console.log(
        `\nThe result is unknown. Check the Sandbox account, then record it with --recover subscription (--resource <ID> or --not-created) --note "<what you checked>".`,
      );
    } else {
      console.log(
        "\nThe replacement was not created. Re-run pnpm sandbox:setup --confirm to retry it.",
      );
    }
    writeLedger(config.dataDir, "sandbox-replace-subscription", {
      stoppedAt: result.stoppedAt,
      reason: result.reason,
      attempt: result.manifest.stages.subscription.attempt,
      at: new Date().toISOString(),
    });
    return result.stoppedAt === null ? 0 : 1;
  }

  if (args.values.has("recover")) {
    const stage = args.values.get("recover") as SetupStageName;
    if (!SETUP_STAGES.includes(stage)) {
      console.error(`--recover takes one of: ${SETUP_STAGES.join(", ")}.`);
      return 2;
    }
    const note = args.values.get("note") ?? "";
    const resource = args.values.get("resource");
    if (!resource && !args.flags.has("not-created")) {
      console.error("--recover needs --resource <ID> (it exists) or --not-created, plus --note.");
      return 2;
    }
    const manifest = recoverSetupStage(
      ctx,
      stage,
      resource ? { outcome: "succeeded", resourceId: resource } : { outcome: "failed" },
      note,
    );
    printStages(manifest);
    console.log("\nRecorded. Run pnpm sandbox:setup --confirm to continue the same setup.");
    return 0;
  }

  if (args.flags.has("new-intent") || args.values.has("interval")) {
    const interval = (args.values.get("interval") ?? "MONTH").toUpperCase();
    if (interval !== "DAY" && interval !== "MONTH") {
      console.error("--interval must be DAY or MONTH.");
      return 1;
    }
    const startDelay = args.values.has("start-in")
      ? parseStartDelayMinutes(args.values.get("start-in")!)
      : undefined;
    const preview = defaultPreview(config.appOrigin, undefined, interval, startDelay);
    if (!args.flags.has("confirm")) {
      console.log("\nPreview of a new setup intent (synthetic catalog metadata, Sandbox only):");
      console.log(JSON.stringify(preview, null, 2));
      const current = loadSetupState(ctx);
      if (current) printStages(current);
      console.log(
        "\nNothing was recorded or created. Re-run with --confirm to record the new intent and create its product → plan → subscription.",
      );
      return 0;
    }
    const recorded = startNewSetupIntent(ctx, preview);
    console.log(`\nNew setup intent recorded (${recorded.preview.plan.intervalUnit}).`);
  } else if (args.values.has("start-in")) {
    console.error(
      "--start-in belongs to a new intent: use it with --new-intent --interval DAY|MONTH.",
    );
    return 2;
  }

  const state = loadSetupState(ctx);
  if (state && SETUP_STAGES.every((stage) => state.stages[stage].status === "succeeded")) {
    printStages(state);
    console.log(
      `\nThe product, plan and subscription of this setup exist (last status ${state.lastStatus ?? "unknown"}). Use --resume.`,
    );
    return 0;
  }
  if (!args.flags.has("confirm")) {
    console.log("\nPreview (synthetic catalog metadata, Sandbox only):");
    console.log(JSON.stringify(state?.preview ?? defaultPreview(config.appOrigin), null, 2));
    if (state) printStages(state);
    console.log(
      "\nNothing was created. Re-run with --confirm to create the remaining Sandbox objects (product → plan → subscription).",
    );
    return 0;
  }
  // Record the intent first, so the preview you confirm is exactly what every stage sends.
  const intent = prepareSetupIntent(ctx, defaultPreview(config.appOrigin));
  console.log("\nSetup intent (fixed for every stage and retry):");
  console.log(JSON.stringify(intent.preview, null, 2));
  printStages(intent);
  const remaining = SETUP_STAGES.filter((stage) => intent.stages[stage].status !== "succeeded");
  if (
    !(await confirm(
      `Create the remaining Sandbox objects (${remaining.join(" → ")}) in PayPal Sandbox?`,
      args.flags.has("yes"),
    ))
  )
    return 1;
  const result = await runSubscriptionSetup(ctx);
  printStages(result.manifest);
  if (result.stoppedAt === null) {
    if (result.manifest.requestedStartTime)
      console.log(
        `\nFirst billing requested for ${result.manifest.requestedStartTime} (delayed start). PayPal decides when it actually bills; --resume shows the next billing time as read.`,
      );
    console.log("\nNext (manual, in your browser, with the Sandbox Personal account):");
    console.log(result.manifest.approveUrl ?? "(no approve URL returned)");
    console.log(
      "\nThe return page is not proof of approval. Then run: pnpm sandbox:setup --resume",
    );
  } else if (result.reason === "UNKNOWN") {
    console.log(
      `\nThe result of the ${result.stoppedAt} stage is unknown. Do not repeat it blindly. Check the Sandbox Developer Dashboard, then record what you found:`,
    );
    console.log(
      `  pnpm sandbox:setup --recover ${result.stoppedAt} --resource <ID> --note "<what you checked>"   (it exists)`,
    );
    console.log(
      `  pnpm sandbox:setup --recover ${result.stoppedAt} --not-created --note "<what you checked>"   (nothing was created)`,
    );
  } else if (result.reason === "FAILED") {
    console.log(
      `\nThe ${result.stoppedAt} stage was rejected; nothing was created for it. Earlier stages are kept. Re-run --confirm to retry this stage.`,
    );
  } else {
    console.log(`\nThe ${result.stoppedAt} stage is still being dispatched by another run.`);
  }
  writeLedger(config.dataDir, "sandbox-setup", {
    intent: "recorded",
    stages: Object.fromEntries(
      SETUP_STAGES.map((stage) => [stage, result.manifest.stages[stage].status]),
    ),
    stoppedAt: result.stoppedAt,
    reason: result.reason,
    at: new Date().toISOString(),
  });
  return result.stoppedAt === null ? 0 : 1;
}

function printStages(manifest: SetupManifest): void {
  console.log("\nSetup stages:");
  for (const stage of SETUP_STAGES) {
    const st = manifest.stages[stage];
    console.log(
      `  ${stage.padEnd(12)} ${st.status.padEnd(9)} attempt ${st.attempt}  ${maskId(st.resourceId) ?? "-"}${st.error ? `  (${st.error})` : ""}`,
    );
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`sandbox:setup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
