#!/usr/bin/env tsx
/**
 * pnpm demo:sandbox — opt-in connected UI against PayPal Sandbox.
 *
 * Loads credentials server-side from .env, fails closed on a non-Sandbox origin or missing
 * variables, uses the separate sandbox data directory, and never auto-dispatches pending
 * writes on startup (expired dispatch leases become UNKNOWN for review). Every provider write
 * in the UI still requires an explicit approval.
 */
import { banner, loadLocalEnv, parseArgs, spawnNext } from "./lib";
import { ConfigError, loadAppConfig, loadPayPalConfig } from "@/server/config";
import { createAppContext } from "@/server/context";
import { sweepExpiredLeases } from "@/server/services/operation-service";
import { cases } from "@/server/db/repos";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  loadLocalEnv();
  const port = Number(args.values.get("port") ?? process.env.PORT ?? 3000);
  const env: Record<string, string> = {
    APP_MODE: "sandbox",
    APP_ORIGIN: `http://127.0.0.1:${port}`,
    DATA_DIR: args.values.get("data-dir") ?? process.env.DATA_DIR ?? "./data/local",
    DEMO_RECORDING_MODE: process.env.DEMO_RECORDING_MODE ?? "true",
  };
  Object.assign(process.env, env);
  banner("CancelCase — Sandbox demo (connected)");
  try {
    const paypal = loadPayPalConfig();
    console.log(`provider origin: ${paypal.origin} (Sandbox)`);
  } catch (err) {
    const e = err as ConfigError;
    console.error(`refusing to start: ${e.code}: ${e.message}`);
    return 2;
  }
  const config = loadAppConfig(process.env);
  const ctx = createAppContext({ config });
  const swept = sweepExpiredLeases(ctx);
  const count = cases.list(ctx.db).length;
  ctx.db.close();
  console.log(`data dir:   ${config.envDir}`);
  console.log(
    `cases:      ${count}${count === 0 ? " (create one with pnpm sandbox:setup --confirm / --resume or --import-dispute <ID>)" : ""}`,
  );
  if (swept.length > 0)
    console.log(
      `recovered:  ${swept.length} interrupted operation(s) marked UNKNOWN for review; nothing was resent`,
    );
  console.log(
    `recording:  ${config.recordingMode ? "aliases shown for provider ids" : "raw ids shown"}`,
  );
  console.log(`open:       http://127.0.0.1:${port}/`);
  const mode = process.env.CC_DEMO_PROD === "1" ? "start" : "dev";
  return spawnNext(mode, port, env);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`demo:sandbox failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
