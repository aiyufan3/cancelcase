/**
 * SQLite schema. Business records and LangGraph checkpoints live in separate database files
 * (cancelcase.sqlite and graph.sqlite) under the per-environment data dir.
 *
 * Version history:
 *   1 — initial schema.
 *   2 — claim_reservations: at most one active or unresolved financial claim per charge,
 *       enforced by the primary key so concurrent attempts, restarts and other processes on
 *       the same file all hit the same constraint.
 */
export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  account_alias TEXT NOT NULL,
  owner_alias TEXT NOT NULL,
  merchant_alias TEXT NOT NULL,
  label TEXT NOT NULL,
  amount_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  provider_refs_json TEXT NOT NULL DEFAULT '[]',
  provider_status TEXT,
  provider_status_observed_at TEXT,
  cancellation_json TEXT NOT NULL,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  last_sync_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  account_alias TEXT NOT NULL,
  case_id TEXT,
  subscription_id TEXT,
  owner_role TEXT NOT NULL,
  visibility TEXT NOT NULL,
  provenance TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  storage_name TEXT,
  mime TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  captured_at TEXT,
  event_time TEXT,
  facts_json TEXT NOT NULL DEFAULT '[]',
  text_excerpt TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_case ON evidence(case_id);
CREATE INDEX IF NOT EXISTS idx_evidence_subscription ON evidence(subscription_id);

CREATE TABLE IF NOT EXISTS charges (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  account_alias TEXT NOT NULL,
  merchant_alias TEXT NOT NULL,
  subscription_id TEXT,
  match_method TEXT NOT NULL,
  provider_refs_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  event_time TEXT,
  posted_time TEXT,
  ingested_time TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_cents INTEGER,
  currency TEXT NOT NULL,
  refunded_cents INTEGER,
  refund_state_known INTEGER NOT NULL DEFAULT 0,
  service_period_start TEXT,
  service_period_end TEXT,
  arrears_indicator INTEGER,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_charges_dedupe ON charges(environment, account_alias, dedupe_key);

CREATE TABLE IF NOT EXISTS dispute_cases (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  account_alias TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  buyer_alias TEXT NOT NULL,
  merchant_alias TEXT NOT NULL,
  channel TEXT NOT NULL,
  claim_active INTEGER NOT NULL DEFAULT 0,
  claim_closed_reason TEXT,
  buyer_state TEXT NOT NULL,
  merchant_state TEXT NOT NULL,
  classification TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  claimable_cents INTEGER,
  requested_cents INTEGER,
  evidence_snapshot_version INTEGER NOT NULL DEFAULT 1,
  provider_observation_json TEXT,
  origin TEXT NOT NULL DEFAULT 'fixture_seed',
  origin_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cases_charge ON dispute_cases(charge_id);

CREATE TABLE IF NOT EXISTS contact_events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  at TEXT NOT NULL,
  direction TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  visible_to_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  case_id TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  rendered_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  origin TEXT NOT NULL,
  provider_label TEXT,
  model_label TEXT,
  validation_json TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_case_role ON drafts(case_id, role, action);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  case_id TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  draft_id TEXT,
  fingerprint TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  material_fingerprint TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT NOT NULL,
  approver TEXT,
  consumed_by_operation_id TEXT,
  revoked_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_case ON approvals(case_id, role, action);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL,
  case_id TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  attachment_hashes_json TEXT NOT NULL DEFAULT '[]',
  approval_id TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  provider_request_id TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  recovery_decision TEXT,
  recovery_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operations_case ON operations(case_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  environment TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT,
  action TEXT NOT NULL,
  case_id TEXT,
  operation_id TEXT,
  approval_id TEXT,
  reason_code TEXT,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_case ON audit_log(case_id);

CREATE TABLE IF NOT EXISTS claim_reservations (
  charge_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  case_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  state TEXT NOT NULL,
  operation_id TEXT,
  provider_ref TEXT,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_case ON claim_reservations(case_id);
`;
