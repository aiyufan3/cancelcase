import path from "node:path";
import fs from "node:fs";
import type { Db } from "./db/connection";
import { openDatabase, openMemoryDatabase } from "./db/connection";
import { loadAppConfig, type AppConfig } from "./config";
import type { ProviderAdapter } from "@/paypal/adapter";
import { FixtureAdapter } from "@/paypal/fixture-adapter";
import { systemClock, type Clock } from "@/domain/time";
import type { Drafter } from "@/llm/drafter";
import { FixtureDrafter } from "@/llm/fixture-drafter";
import { buildSandboxServices } from "./sandbox-context";
import { switchOffAutomaticTracing } from "./tracing";

/**
 * Everything a request or CLI step needs. Built once per process for the UI server, or
 * explicitly for scripts and tests. Fixture mode never constructs a connected adapter and
 * never reads provider or model credentials.
 */
export interface AppContext {
  config: AppConfig;
  db: Db;
  dbPath: string | null;
  evidenceDir: string;
  exportDir: string;
  graphDbPath: string | null;
  adapter: ProviderAdapter;
  drafter: Drafter;
  clock: Clock;
  /** Actor label used in approvals and audit entries for the local operator */
  actor: string;
}

export interface CreateContextOptions {
  config?: AppConfig;
  adapter?: ProviderAdapter;
  drafter?: Drafter;
  clock?: Clock;
  inMemory?: boolean;
}

export function createAppContext(options: CreateContextOptions = {}): AppContext {
  const config = options.config ?? loadAppConfig();
  // Before any LangChain code runs: its own tracer would send runs unredacted.
  switchOffAutomaticTracing();
  const clock = options.clock ?? systemClock;
  let db: Db;
  let dbPath: string | null = null;
  if (options.inMemory) {
    db = openMemoryDatabase(config.mode);
  } else {
    const opened = openDatabase(config.envDir, config.mode);
    db = opened.db;
    dbPath = opened.path;
  }
  const evidenceDir = path.join(config.envDir, "evidence");
  const exportDir = path.join(config.envDir, "exports");
  if (!options.inMemory) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.mkdirSync(exportDir, { recursive: true });
  }

  let adapter = options.adapter ?? null;
  let drafter = options.drafter ?? null;
  if (!adapter || !drafter) {
    if (config.mode === "fixture") {
      adapter ??= new FixtureAdapter(
        options.inMemory ? null : path.join(config.envDir, "provider-simulation.json"),
        clock,
      );
      drafter ??= new FixtureDrafter();
    } else {
      const services = buildSandboxServices(clock, config.envDir);
      adapter ??= services.adapter;
      drafter ??= services.drafter;
    }
  }

  return {
    config,
    db,
    dbPath,
    evidenceDir,
    exportDir,
    graphDbPath: options.inMemory ? null : path.join(config.envDir, "graph.sqlite"),
    adapter,
    drafter,
    clock,
    actor: "local-operator",
  };
}

let singleton: AppContext | null = null;

/** Process-wide context for the Next.js server. Scripts should call createAppContext directly. */
export function getAppContext(): AppContext {
  if (!singleton) singleton = createAppContext();
  return singleton;
}

/** Test helper: replace the singleton (e.g. with an in-memory context). */
export function setAppContextForTests(ctx: AppContext | null): void {
  singleton = ctx;
}
