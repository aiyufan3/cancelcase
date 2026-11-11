#!/usr/bin/env tsx
/**
 * pnpm demo — fixture mode on loopback.
 *
 * Requires no .env, no credentials and no network. Seeds the synthetic fixture case into the
 * fixture database (idempotent), sweeps any expired dispatch lease into UNKNOWN (never resends),
 * and starts the UI bound to 127.0.0.1. Provider calls are simulated and labelled.
 */
import path from "node:path";
import { banner, parseArgs, spawnNext } from "./lib";
import { createAppContext } from "@/server/context";
import { loadAppConfig } from "@/server/config";
import { seedFixture } from "@/server/services/fixture-seed";
import { sweepExpiredLeases } from "@/server/services/operation-service";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.values.get("port") ?? process.env.PORT ?? 3000);
  const dataDir = args.values.get("data-dir") ?? process.env.DATA_DIR ?? "./data/local";
  const env: Record<string, string> = {
    APP_MODE: "fixture",
    APP_ORIGIN: `http://127.0.0.1:${port}`,
    DATA_DIR: dataDir,
    DEMO_RECORDING_MODE: process.env.DEMO_RECORDING_MODE ?? "true",
  };
  Object.assign(process.env, env);
  const config = loadAppConfig(process.env);
  const ctx = createAppContext({ config });
  const seed = seedFixture(ctx);
  const swept = sweepExpiredLeases(ctx);
  ctx.db.close();

  banner("CancelCase — fixture demo");
  console.log(`mode:       fixture (synthetic data; no PayPal or model calls)`);
  // Relative to the checkout, so a screenshot or recording never shows a home folder.
  console.log(`data dir:   ${path.relative(process.cwd(), path.resolve(config.envDir)) || "."}`);
  console.log(`case:       ${seed.caseId} ${seed.seeded ? "(seeded now)" : "(already present)"}`);
  if (swept.length > 0)
    console.log(`recovered:  ${swept.length} interrupted operation(s) marked UNKNOWN for review`);
  console.log(`open:       http://127.0.0.1:${port}/cases/${seed.caseId}`);
  console.log(`reset:      pnpm demo:reset --yes --acknowledge-unresolved   (then pnpm demo)`);
  if (args.flags.has("seed-only")) return 0;
  const mode = process.env.CC_DEMO_PROD === "1" ? "start" : "dev";
  return spawnNext(mode, port, env);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`demo failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
