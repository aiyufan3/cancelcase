#!/usr/bin/env tsx
/**
 * pnpm demo:reset — delete the local FIXTURE data directory only.
 *
 * Explicit confirmation required. Refuses to touch the Sandbox data directory, remote
 * resources or .env. Refuses while an operation is executing or unknown unless the operator
 * passes --acknowledge-unresolved after reviewing it.
 */
import fs from "node:fs";
import path from "node:path";
import { banner, confirm, parseArgs } from "./lib";
import { openDatabase } from "@/server/db/connection";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if ((process.env.APP_MODE ?? "fixture") === "sandbox" || args.values.get("env") === "sandbox") {
    console.error(
      "demo:reset only resets fixture data. Sandbox data is never reset by this command.",
    );
    return 2;
  }
  const dataDir = path.resolve(
    process.cwd(),
    args.values.get("data-dir") ?? process.env.DATA_DIR ?? "./data/local",
  );
  const fixtureDir = path.join(dataDir, "fixture");
  banner("CancelCase — fixture reset");
  if (!fs.existsSync(fixtureDir)) {
    console.log(`nothing to reset: ${fixtureDir} does not exist.`);
    return 0;
  }
  const dbFile = path.join(fixtureDir, "cancelcase.sqlite");
  if (fs.existsSync(dbFile)) {
    try {
      const { db } = openDatabase(fixtureDir, "fixture");
      const rows = db
        .prepare("SELECT id, status FROM operations WHERE status IN ('DISPATCHING','UNKNOWN')")
        .all() as { id: string; status: string }[];
      db.close();
      if (rows.length > 0 && !args.flags.has("acknowledge-unresolved")) {
        console.error(`refusing: ${rows.length} operation(s) are executing or unknown:`);
        for (const r of rows) console.error(`  ${r.id} ${r.status}`);
        console.error(
          "Resolve them in the UI, or re-run with --acknowledge-unresolved after reviewing them.",
        );
        return 3;
      }
    } catch (err) {
      console.warn(
        `could not inspect the fixture database (${err instanceof Error ? err.message : String(err)}); continuing with reset.`,
      );
    }
  }
  console.log(`target: ${fixtureDir}`);
  console.log(
    "This deletes the fixture database, evidence files, exports and workflow checkpoints. It never touches .env or Sandbox data.",
  );
  if (!(await confirm("Delete the fixture data directory?", args.flags.has("yes")))) {
    console.log("aborted.");
    return 1;
  }
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  console.log("fixture data removed. Run pnpm demo to seed again.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`reset failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
