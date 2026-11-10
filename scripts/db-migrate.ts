#!/usr/bin/env tsx
/** pnpm db:migrate — create or verify the schema for the configured mode. */
import { loadLocalEnv, parseArgs } from "./lib";
import { loadAppConfig } from "@/server/config";
import { openDatabase } from "@/server/db/connection";
import { SCHEMA_VERSION } from "@/server/db/schema";

const args = parseArgs(process.argv.slice(2));
if ((process.env.APP_MODE ?? args.values.get("mode")) === "sandbox") loadLocalEnv();
if (args.values.get("mode")) process.env.APP_MODE = args.values.get("mode");
const config = loadAppConfig(process.env);
const { db, path, created } = openDatabase(config.envDir, config.mode);
db.close();
console.log(
  `${config.mode} database ${created ? "created" : "verified"} at ${path} (schema v${SCHEMA_VERSION}).`,
);
