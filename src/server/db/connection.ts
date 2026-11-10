import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";
import type { Environment } from "@/domain/types";

export type Db = Database.Database;

export interface OpenedDb {
  db: Db;
  path: string;
  created: boolean;
}

/**
 * Open (and migrate) the business database for one environment directory.
 * WAL mode gives durable writes with a single process; busy_timeout handles the rare
 * overlap between the UI server and a CLI command on the same file.
 */
export function openDatabase(envDir: string, environment: Environment): OpenedDb {
  fs.mkdirSync(envDir, { recursive: true });
  const file = path.join(envDir, "cancelcase.sqlite");
  const created = !fs.existsSync(file);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  const meta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const existingVersion = meta.get("schema_version") as { value: string } | undefined;
  if (!existingVersion) {
    const put = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
    put.run("schema_version", String(SCHEMA_VERSION));
    put.run("environment", environment);
    put.run("created_at", new Date().toISOString());
  } else if (Number(existingVersion.value) < SCHEMA_VERSION) {
    migrate(db, Number(existingVersion.value));
  } else if (Number(existingVersion.value) !== SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${existingVersion.value} is newer than application version ${SCHEMA_VERSION}. Update the application or use a fresh data directory.`,
    );
  }
  const storedEnv = meta.get("environment") as { value: string } | undefined;
  if (storedEnv && storedEnv.value !== environment) {
    throw new Error(
      `Database at ${file} belongs to the ${storedEnv.value} environment; refusing to open it as ${environment}.`,
    );
  }
  return { db, path: file, created };
}

/**
 * Forward-only, additive migrations. New tables are created by SCHEMA_SQL (IF NOT EXISTS);
 * this step backfills them from existing rows and records the new version in one transaction.
 */
export function migrate(db: Db, from: number): void {
  const run = db.transaction(() => {
    if (from < 2) {
      const now = new Date().toISOString();
      // Open provider claims recorded before version 2.
      db.prepare(
        `INSERT OR IGNORE INTO claim_reservations (charge_id, environment, case_id, channel, state, operation_id, provider_ref, opened_at, updated_at)
         SELECT charge_id, environment, id, channel, 'OPEN', NULL, NULL, updated_at, ? FROM dispute_cases WHERE claim_active = 1`,
      ).run(now);
      // Claim-opening operations whose outcome is not settled keep their reservation.
      db.prepare(
        `INSERT OR IGNORE INTO claim_reservations (charge_id, environment, case_id, channel, state, operation_id, provider_ref, opened_at, updated_at)
         SELECT c.charge_id, o.environment, o.case_id, 'paypal', 'RESERVED', o.id, NULL, o.created_at, ?
         FROM operations o JOIN dispute_cases c ON c.id = o.case_id
         WHERE o.action = 'buyer_create_dispute' AND o.status IN ('PREPARED', 'DISPATCHING', 'UNKNOWN')`,
      ).run(now);
    }
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
  });
  run();
}

export function openMemoryDatabase(environment: Environment): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  const put = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
  put.run("schema_version", String(SCHEMA_VERSION));
  put.run("environment", environment);
  put.run("created_at", new Date().toISOString());
  return db;
}
