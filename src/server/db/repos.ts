import type { Db } from "./connection";
import type { ProviderRef } from "@/domain/types";
import type {
  ApprovalRecord,
  AuditEntry,
  CaseRecord,
  ClaimReservationRecord,
  ChargeRecord,
  ContactEventRecord,
  DraftRecord,
  EvidenceRecord,
  OperationRecord,
  SubscriptionRecord,
} from "../records";

/* ----------------------------------------------------------------------------
 * Row mapping helpers. Every JSON column is parsed here and nowhere else.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

function j<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return JSON.parse(value) as T;
}
function s(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function n(value: unknown): number | null {
  return typeof value === "number"
    ? value
    : value === null || value === undefined
      ? null
      : Number(value);
}
function b(value: unknown): boolean {
  return value === 1 || value === true;
}
function bn(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return value === 1 || value === true;
}

const str = (value: unknown): string => {
  if (typeof value !== "string") throw new Error(`Expected string column, got ${typeof value}`);
  return value;
};

/* ---------------------------------- subscriptions ------------------------ */

function mapSubscription(r: Row): SubscriptionRecord {
  return {
    id: str(r.id),
    environment: str(r.environment) as SubscriptionRecord["environment"],
    accountAlias: str(r.account_alias),
    ownerAlias: str(r.owner_alias),
    merchantAlias: str(r.merchant_alias),
    label: str(r.label),
    amountCents: n(r.amount_cents),
    currency: str(r.currency),
    providerRefs: j(r.provider_refs_json, []),
    providerStatus: s(r.provider_status),
    providerStatusObservedAt: s(r.provider_status_observed_at),
    cancellation: j(r.cancellation_json, null as never),
    sourceIds: j(r.source_ids_json, []),
    lastSyncAt: s(r.last_sync_at),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export const subscriptions = {
  insert(db: Db, rec: SubscriptionRecord): void {
    db.prepare(
      `INSERT INTO subscriptions (id, environment, account_alias, owner_alias, merchant_alias, label, amount_cents, currency,
        provider_refs_json, provider_status, provider_status_observed_at, cancellation_json, source_ids_json, last_sync_at, created_at, updated_at)
       VALUES (@id, @environment, @accountAlias, @ownerAlias, @merchantAlias, @label, @amountCents, @currency,
        @providerRefs, @providerStatus, @providerStatusObservedAt, @cancellation, @sourceIds, @lastSyncAt, @createdAt, @updatedAt)`,
    ).run({
      ...rec,
      providerRefs: JSON.stringify(rec.providerRefs),
      cancellation: JSON.stringify(rec.cancellation),
      sourceIds: JSON.stringify(rec.sourceIds),
    });
  },
  update(db: Db, rec: SubscriptionRecord): void {
    db.prepare(
      `UPDATE subscriptions SET provider_refs_json=@providerRefs, provider_status=@providerStatus,
        provider_status_observed_at=@providerStatusObservedAt, cancellation_json=@cancellation,
        source_ids_json=@sourceIds, last_sync_at=@lastSyncAt, updated_at=@updatedAt, label=@label,
        amount_cents=@amountCents WHERE id=@id`,
    ).run({
      ...rec,
      providerRefs: JSON.stringify(rec.providerRefs),
      cancellation: JSON.stringify(rec.cancellation),
      sourceIds: JSON.stringify(rec.sourceIds),
    });
  },
  get(db: Db, id: string): SubscriptionRecord | null {
    const row = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id) as Row | undefined;
    return row ? mapSubscription(row) : null;
  },
  list(db: Db): SubscriptionRecord[] {
    return (db.prepare("SELECT * FROM subscriptions ORDER BY created_at").all() as Row[]).map(
      mapSubscription,
    );
  },
};

/* ---------------------------------- evidence ----------------------------- */

function mapEvidence(r: Row): EvidenceRecord {
  return {
    id: str(r.id),
    environment: str(r.environment) as EvidenceRecord["environment"],
    accountAlias: str(r.account_alias),
    caseId: s(r.case_id),
    subscriptionId: s(r.subscription_id),
    ownerRole: str(r.owner_role) as EvidenceRecord["ownerRole"],
    visibility: str(r.visibility) as EvidenceRecord["visibility"],
    provenance: str(r.provenance) as EvidenceRecord["provenance"],
    kind: str(r.kind) as EvidenceRecord["kind"],
    label: str(r.label),
    storageName: s(r.storage_name),
    mime: s(r.mime),
    sizeBytes: n(r.size_bytes),
    sha256: s(r.sha256),
    capturedAt: s(r.captured_at),
    eventTime: s(r.event_time),
    facts: j(r.facts_json, []),
    textExcerpt: s(r.text_excerpt),
    version: n(r.version) ?? 1,
    createdAt: str(r.created_at),
  };
}

export const evidence = {
  insert(db: Db, rec: EvidenceRecord): void {
    db.prepare(
      `INSERT INTO evidence (id, environment, account_alias, case_id, subscription_id, owner_role, visibility, provenance, kind, label,
        storage_name, mime, size_bytes, sha256, captured_at, event_time, facts_json, text_excerpt, version, created_at)
       VALUES (@id, @environment, @accountAlias, @caseId, @subscriptionId, @ownerRole, @visibility, @provenance, @kind, @label,
        @storageName, @mime, @sizeBytes, @sha256, @capturedAt, @eventTime, @facts, @textExcerpt, @version, @createdAt)`,
    ).run({ ...rec, facts: JSON.stringify(rec.facts) });
  },
  get(db: Db, id: string): EvidenceRecord | null {
    const row = db.prepare("SELECT * FROM evidence WHERE id = ?").get(id) as Row | undefined;
    return row ? mapEvidence(row) : null;
  },
  listForCase(db: Db, caseId: string, subscriptionId: string): EvidenceRecord[] {
    return (
      db
        .prepare(
          "SELECT * FROM evidence WHERE case_id = ? OR (case_id IS NULL AND subscription_id = ?) ORDER BY created_at",
        )
        .all(caseId, subscriptionId) as Row[]
    ).map(mapEvidence);
  },
  listForSubscription(db: Db, subscriptionId: string): EvidenceRecord[] {
    return (
      db
        .prepare("SELECT * FROM evidence WHERE subscription_id = ? ORDER BY created_at")
        .all(subscriptionId) as Row[]
    ).map(mapEvidence);
  },
  deleteForCase(db: Db, caseId: string): EvidenceRecord[] {
    const rows = (db.prepare("SELECT * FROM evidence WHERE case_id = ?").all(caseId) as Row[]).map(
      mapEvidence,
    );
    db.prepare("DELETE FROM evidence WHERE case_id = ?").run(caseId);
    return rows;
  },
};

/* ---------------------------------- charges ------------------------------ */

/** Seller transaction IDs and subscription sale IDs name the same PayPal payment. */
export function paymentReferenceKeys(refs: readonly ProviderRef[]): string[] {
  return Array.from(
    new Set(
      refs.flatMap((ref) => {
        if (!ref.value) return [];
        if (
          ref.kind === "subscription_sale_id" ||
          ref.kind === "seller_transaction_id" ||
          ref.kind === "capture_id"
        )
          return [`paypal:merchant_transaction:${ref.value}`];
        if (ref.kind === "buyer_transaction_id") return [`paypal:buyer_transaction:${ref.value}`];
        return [];
      }),
    ),
  );
}

function mapCharge(r: Row): ChargeRecord {
  return {
    id: str(r.id),
    environment: str(r.environment) as ChargeRecord["environment"],
    accountAlias: str(r.account_alias),
    merchantAlias: str(r.merchant_alias),
    subscriptionId: s(r.subscription_id),
    matchMethod: str(r.match_method) as ChargeRecord["matchMethod"],
    providerRefs: j(r.provider_refs_json, []),
    description: s(r.description),
    eventTime: s(r.event_time),
    postedTime: s(r.posted_time),
    ingestedTime: str(r.ingested_time),
    status: str(r.status) as ChargeRecord["status"],
    amountCents: n(r.amount_cents),
    currency: str(r.currency),
    refundedCents: n(r.refunded_cents),
    refundStateKnown: b(r.refund_state_known),
    servicePeriodStart: s(r.service_period_start),
    servicePeriodEnd: s(r.service_period_end),
    arrearsIndicator: bn(r.arrears_indicator),
    sourceIds: j(r.source_ids_json, []),
    dedupeKey: s(r.dedupe_key),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export const charges = {
  insert(db: Db, rec: ChargeRecord): void {
    db.prepare(
      `INSERT INTO charges (id, environment, account_alias, merchant_alias, subscription_id, match_method, provider_refs_json, description,
        event_time, posted_time, ingested_time, status, amount_cents, currency, refunded_cents, refund_state_known,
        service_period_start, service_period_end, arrears_indicator, source_ids_json, dedupe_key, created_at, updated_at)
       VALUES (@id, @environment, @accountAlias, @merchantAlias, @subscriptionId, @matchMethod, @providerRefs, @description,
        @eventTime, @postedTime, @ingestedTime, @status, @amountCents, @currency, @refundedCents, @refundStateKnown,
        @servicePeriodStart, @servicePeriodEnd, @arrearsIndicator, @sourceIds, @dedupeKey, @createdAt, @updatedAt)`,
    ).run({
      ...rec,
      providerRefs: JSON.stringify(rec.providerRefs),
      sourceIds: JSON.stringify(rec.sourceIds),
      refundStateKnown: rec.refundStateKnown ? 1 : 0,
      arrearsIndicator: rec.arrearsIndicator === null ? null : rec.arrearsIndicator ? 1 : 0,
    });
  },
  update(db: Db, rec: ChargeRecord): void {
    db.prepare(
      `UPDATE charges SET status=@status, amount_cents=@amountCents, refunded_cents=@refundedCents, refund_state_known=@refundStateKnown,
        provider_refs_json=@providerRefs, source_ids_json=@sourceIds, event_time=@eventTime, posted_time=@postedTime,
        service_period_start=@servicePeriodStart, service_period_end=@servicePeriodEnd, arrears_indicator=@arrearsIndicator,
        subscription_id=@subscriptionId, match_method=@matchMethod, description=@description, dedupe_key=@dedupeKey,
        updated_at=@updatedAt WHERE id=@id`,
    ).run({
      ...rec,
      providerRefs: JSON.stringify(rec.providerRefs),
      sourceIds: JSON.stringify(rec.sourceIds),
      refundStateKnown: rec.refundStateKnown ? 1 : 0,
      arrearsIndicator: rec.arrearsIndicator === null ? null : rec.arrearsIndicator ? 1 : 0,
    });
  },
  get(db: Db, id: string): ChargeRecord | null {
    const row = db.prepare("SELECT * FROM charges WHERE id = ?").get(id) as Row | undefined;
    return row ? mapCharge(row) : null;
  },
  getByDedupeKey(
    db: Db,
    environment: string,
    accountAlias: string,
    dedupeKey: string,
  ): ChargeRecord | null {
    const row = db
      .prepare(
        "SELECT * FROM charges WHERE environment = ? AND account_alias = ? AND dedupe_key = ?",
      )
      .get(environment, accountAlias, dedupeKey) as Row | undefined;
    return row ? mapCharge(row) : null;
  },
  list(db: Db): ChargeRecord[] {
    return (db.prepare("SELECT * FROM charges ORDER BY event_time").all() as Row[]).map(mapCharge);
  },
  /**
   * Resolve all known aliases, including legacy imported/connected duplicate records. A buyer
   * reference can bridge two seller references only when a provider record explicitly links
   * them. Subscription/order IDs never identify a single payment. Account and mode scope every
   * comparison; matching merchant names or amounts alone never links records.
   */
  findByPaymentRefs(
    db: Db,
    environment: string,
    accountAlias: string,
    refs: readonly ProviderRef[],
  ): ChargeRecord[] {
    const keys = new Set(paymentReferenceKeys(refs));
    if (keys.size === 0) return [];
    const candidates = (
      db
        .prepare("SELECT * FROM charges WHERE environment = ? AND account_alias = ? ORDER BY id")
        .all(environment, accountAlias) as Row[]
    ).map(mapCharge);
    const matched = new Map<string, ChargeRecord>();
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const charge of candidates) {
        if (matched.has(charge.id)) continue;
        const aliases = paymentReferenceKeys(charge.providerRefs);
        if (!aliases.some((key) => keys.has(key))) continue;
        matched.set(charge.id, charge);
        for (const key of aliases) keys.add(key);
        expanded = true;
      }
    }
    return Array.from(matched.values());
  },
  listForPayment(db: Db, chargeId: string): ChargeRecord[] {
    const charge = charges.get(db, chargeId);
    if (!charge) return [];
    const related = charges.findByPaymentRefs(
      db,
      charge.environment,
      charge.accountAlias,
      charge.providerRefs,
    );
    return [charge, ...related.filter((rec) => rec.id !== charge.id)];
  },
};

/* ---------------------------------- cases -------------------------------- */

function mapCase(r: Row): CaseRecord {
  return {
    id: str(r.id),
    environment: str(r.environment) as CaseRecord["environment"],
    accountAlias: str(r.account_alias),
    chargeId: str(r.charge_id),
    subscriptionId: str(r.subscription_id),
    buyerAlias: str(r.buyer_alias),
    merchantAlias: str(r.merchant_alias),
    channel: str(r.channel) as CaseRecord["channel"],
    claimActive: b(r.claim_active),
    claimClosedReason: s(r.claim_closed_reason),
    buyerState: str(r.buyer_state) as CaseRecord["buyerState"],
    merchantState: str(r.merchant_state) as CaseRecord["merchantState"],
    classification: str(r.classification) as CaseRecord["classification"],
    reasonCodes: j(r.reason_codes_json, []),
    claimableCents: n(r.claimable_cents),
    requestedCents: n(r.requested_cents),
    evidenceSnapshotVersion: n(r.evidence_snapshot_version) ?? 1,
    providerObservation: j(r.provider_observation_json, null),
    origin: (s(r.origin) ?? "fixture_seed") as CaseRecord["origin"],
    originNote: s(r.origin_note),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export const cases = {
  insert(db: Db, rec: CaseRecord): void {
    db.prepare(
      `INSERT INTO dispute_cases (id, environment, account_alias, charge_id, subscription_id, buyer_alias, merchant_alias, channel,
        claim_active, claim_closed_reason, buyer_state, merchant_state, classification, reason_codes_json, claimable_cents, requested_cents,
        evidence_snapshot_version, provider_observation_json, origin, origin_note, created_at, updated_at)
       VALUES (@id, @environment, @accountAlias, @chargeId, @subscriptionId, @buyerAlias, @merchantAlias, @channel,
        @claimActive, @claimClosedReason, @buyerState, @merchantState, @classification, @reasonCodes, @claimableCents, @requestedCents,
        @evidenceSnapshotVersion, @providerObservation, @origin, @originNote, @createdAt, @updatedAt)`,
    ).run({
      ...rec,
      claimActive: rec.claimActive ? 1 : 0,
      reasonCodes: JSON.stringify(rec.reasonCodes),
      providerObservation: rec.providerObservation ? JSON.stringify(rec.providerObservation) : null,
    });
  },
  update(db: Db, rec: CaseRecord): void {
    db.prepare(
      `UPDATE dispute_cases SET channel=@channel, claim_active=@claimActive, claim_closed_reason=@claimClosedReason,
        buyer_state=@buyerState, merchant_state=@merchantState, classification=@classification, reason_codes_json=@reasonCodes,
        claimable_cents=@claimableCents, requested_cents=@requestedCents, evidence_snapshot_version=@evidenceSnapshotVersion,
        provider_observation_json=@providerObservation, origin=@origin, origin_note=@originNote,
        updated_at=@updatedAt WHERE id=@id`,
    ).run({
      ...rec,
      claimActive: rec.claimActive ? 1 : 0,
      reasonCodes: JSON.stringify(rec.reasonCodes),
      providerObservation: rec.providerObservation ? JSON.stringify(rec.providerObservation) : null,
    });
  },
  get(db: Db, id: string): CaseRecord | null {
    const row = db.prepare("SELECT * FROM dispute_cases WHERE id = ?").get(id) as Row | undefined;
    return row ? mapCase(row) : null;
  },
  list(db: Db): CaseRecord[] {
    return (db.prepare("SELECT * FROM dispute_cases ORDER BY created_at").all() as Row[]).map(
      mapCase,
    );
  },
  listForCharge(db: Db, chargeId: string): CaseRecord[] {
    return (
      db.prepare("SELECT * FROM dispute_cases WHERE charge_id = ?").all(chargeId) as Row[]
    ).map(mapCase);
  },
  delete(db: Db, id: string): void {
    db.prepare("DELETE FROM dispute_cases WHERE id = ?").run(id);
  },
};

/* ---------------------------------- contact events ----------------------- */

function mapContact(r: Row): ContactEventRecord {
  return {
    id: str(r.id),
    caseId: str(r.case_id),
    at: str(r.at),
    direction: str(r.direction) as ContactEventRecord["direction"],
    summary: str(r.summary),
    sourceIds: j(r.source_ids_json, []),
    visibleTo: j(r.visible_to_json, []),
    createdAt: str(r.created_at),
  };
}

export const contacts = {
  insert(db: Db, rec: ContactEventRecord): void {
    db.prepare(
      `INSERT INTO contact_events (id, case_id, at, direction, summary, source_ids_json, visible_to_json, created_at)
       VALUES (@id, @caseId, @at, @direction, @summary, @sourceIds, @visibleTo, @createdAt)`,
    ).run({
      ...rec,
      sourceIds: JSON.stringify(rec.sourceIds),
      visibleTo: JSON.stringify(rec.visibleTo),
    });
  },
  listForCase(db: Db, caseId: string): ContactEventRecord[] {
    return (
      db.prepare("SELECT * FROM contact_events WHERE case_id = ? ORDER BY at").all(caseId) as Row[]
    ).map(mapContact);
  },
  deleteForCase(db: Db, caseId: string): void {
    db.prepare("DELETE FROM contact_events WHERE case_id = ?").run(caseId);
  },
};

/* ---------------------------------- drafts ------------------------------- */

function mapDraft(r: Row): DraftRecord {
  return {
    id: str(r.id),
    environment: str(r.environment) as DraftRecord["environment"],
    caseId: str(r.case_id),
    role: str(r.role) as DraftRecord["role"],
    action: str(r.action) as DraftRecord["action"],
    version: n(r.version) ?? 1,
    content: j(r.content_json, null as never),
    renderedText: str(r.rendered_text),
    contentHash: str(r.content_hash),
    origin: str(r.origin) as DraftRecord["origin"],
    providerLabel: s(r.provider_label),
    modelLabel: s(r.model_label),
    validation: j(r.validation_json, { ok: false, issues: [] }),
    snapshotVersion: n(r.snapshot_version) ?? 1,
    createdAt: str(r.created_at),
  };
}

export const drafts = {
  insert(db: Db, rec: DraftRecord): void {
    db.prepare(
      `INSERT INTO drafts (id, environment, case_id, role, action, version, content_json, rendered_text, content_hash, origin,
        provider_label, model_label, validation_json, snapshot_version, created_at)
       VALUES (@id, @environment, @caseId, @role, @action, @version, @content, @renderedText, @contentHash, @origin,
        @providerLabel, @modelLabel, @validation, @snapshotVersion, @createdAt)`,
    ).run({
      ...rec,
      content: JSON.stringify(rec.content),
      validation: JSON.stringify(rec.validation),
    });
  },
  get(db: Db, id: string): DraftRecord | null {
    const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as Row | undefined;
    return row ? mapDraft(row) : null;
  },
  latest(db: Db, caseId: string, role: string, action: string): DraftRecord | null {
    const row = db
      .prepare(
        "SELECT * FROM drafts WHERE case_id = ? AND role = ? AND action = ? ORDER BY version DESC LIMIT 1",
      )
      .get(caseId, role, action) as Row | undefined;
    return row ? mapDraft(row) : null;
  },
  listForCase(db: Db, caseId: string): DraftRecord[] {
    return (
      db.prepare("SELECT * FROM drafts WHERE case_id = ? ORDER BY created_at").all(caseId) as Row[]
    ).map(mapDraft);
  },
  deleteForCase(db: Db, caseId: string): void {
    db.prepare("DELETE FROM drafts WHERE case_id = ?").run(caseId);
  },
};

/* ---------------------------------- approvals ---------------------------- */

function mapApproval(r: Row): ApprovalRecord {
  return {
    id: str(r.id),
    environment: str(r.environment) as ApprovalRecord["environment"],
    caseId: str(r.case_id),
    role: str(r.role) as ApprovalRecord["role"],
    action: str(r.action) as ApprovalRecord["action"],
    draftId: s(r.draft_id),
    fingerprint: str(r.fingerprint),
    binding: j(r.binding_json, null as never),
    materialFingerprint: str(r.material_fingerprint),
    decision: str(r.decision) as ApprovalRecord["decision"],
    decidedAt: s(r.decided_at),
    expiresAt: str(r.expires_at),
    approver: s(r.approver),
    consumedByOperationId: s(r.consumed_by_operation_id),
    revokedReason: s(r.revoked_reason),
    createdAt: str(r.created_at),
  };
}

export const approvals = {
  insert(db: Db, rec: ApprovalRecord): void {
    db.prepare(
      `INSERT INTO approvals (id, environment, case_id, role, action, draft_id, fingerprint, binding_json, material_fingerprint,
        decision, decided_at, expires_at, approver, consumed_by_operation_id, revoked_reason, created_at)
       VALUES (@id, @environment, @caseId, @role, @action, @draftId, @fingerprint, @binding, @materialFingerprint,
        @decision, @decidedAt, @expiresAt, @approver, @consumedByOperationId, @revokedReason, @createdAt)`,
    ).run({ ...rec, binding: JSON.stringify(rec.binding) });
  },
  update(db: Db, rec: ApprovalRecord): void {
    db.prepare(
      `UPDATE approvals SET decision=@decision, decided_at=@decidedAt, expires_at=@expiresAt, approver=@approver,
        consumed_by_operation_id=@consumedByOperationId, revoked_reason=@revokedReason WHERE id=@id`,
    ).run(rec);
  },
  get(db: Db, id: string): ApprovalRecord | null {
    const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? mapApproval(row) : null;
  },
  latestForDraft(db: Db, draftId: string): ApprovalRecord | null {
    const row = db
      // Same-millisecond decisions are ordered by insertion (rowid), never arbitrarily.
      .prepare(
        "SELECT * FROM approvals WHERE draft_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(draftId) as Row | undefined;
    return row ? mapApproval(row) : null;
  },
  listForCase(db: Db, caseId: string): ApprovalRecord[] {
    return (
      db
        .prepare("SELECT * FROM approvals WHERE case_id = ? ORDER BY created_at")
        .all(caseId) as Row[]
    ).map(mapApproval);
  },
  /** Atomically consume a valid approval for one operation. Returns true when this call consumed it. */
  consume(db: Db, approvalId: string, operationId: string, nowIso: string): boolean {
    const info = db
      .prepare(
        `UPDATE approvals SET consumed_by_operation_id = ?
         WHERE id = ? AND decision = 'approved' AND consumed_by_operation_id IS NULL AND revoked_reason IS NULL AND expires_at > ?`,
      )
      .run(operationId, approvalId, nowIso);
    return info.changes === 1;
  },
  revokeOpenForCase(db: Db, caseId: string, role: string, action: string, reason: string): number {
    const info = db
      .prepare(
        `UPDATE approvals SET revoked_reason = ? WHERE case_id = ? AND role = ? AND action = ? AND consumed_by_operation_id IS NULL AND revoked_reason IS NULL AND decision != 'rejected'`,
      )
      .run(reason, caseId, role, action);
    return info.changes;
  },
  deleteForCase(db: Db, caseId: string): void {
    db.prepare("DELETE FROM approvals WHERE case_id = ?").run(caseId);
  },
};

/* ---------------------------------- operations --------------------------- */

function mapOperation(r: Row): OperationRecord {
  return {
    id: str(r.id),
    logicalKey: str(r.logical_key),
    environment: str(r.environment) as OperationRecord["environment"],
    caseId: str(r.case_id),
    role: str(r.role) as OperationRecord["role"],
    action: str(r.action) as OperationRecord["action"],
    resourceId: str(r.resource_id),
    payload: j(r.payload_json, null),
    payloadHash: str(r.payload_hash),
    payloadVersion: n(r.payload_version) ?? 1,
    attachmentHashes: j(r.attachment_hashes_json, []),
    approvalId: s(r.approval_id),
    status: str(r.status) as OperationRecord["status"],
    attempts: n(r.attempts) ?? 0,
    leaseUntil: s(r.lease_until),
    providerRequestId: s(r.provider_request_id),
    result: j(r.result_json, null),
    errorCode: s(r.error_code),
    errorMessage: s(r.error_message),
    recoveryDecision: s(r.recovery_decision) as OperationRecord["recoveryDecision"],
    recoveryNote: s(r.recovery_note),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export const operations = {
  insert(db: Db, rec: OperationRecord): void {
    db.prepare(
      `INSERT INTO operations (id, logical_key, environment, case_id, role, action, resource_id, payload_json, payload_hash, payload_version,
        attachment_hashes_json, approval_id, status, attempts, lease_until, provider_request_id, result_json, error_code, error_message,
        recovery_decision, recovery_note, created_at, updated_at)
       VALUES (@id, @logicalKey, @environment, @caseId, @role, @action, @resourceId, @payload, @payloadHash, @payloadVersion,
        @attachmentHashes, @approvalId, @status, @attempts, @leaseUntil, @providerRequestId, @result, @errorCode, @errorMessage,
        @recoveryDecision, @recoveryNote, @createdAt, @updatedAt)`,
    ).run({
      ...rec,
      payload: JSON.stringify(rec.payload),
      attachmentHashes: JSON.stringify(rec.attachmentHashes),
      result: rec.result === null || rec.result === undefined ? null : JSON.stringify(rec.result),
    });
  },
  update(db: Db, rec: OperationRecord): void {
    db.prepare(
      `UPDATE operations SET status=@status, attempts=@attempts, lease_until=@leaseUntil, provider_request_id=@providerRequestId,
        result_json=@result, error_code=@errorCode, error_message=@errorMessage, recovery_decision=@recoveryDecision,
        recovery_note=@recoveryNote, updated_at=@updatedAt WHERE id=@id`,
    ).run({
      ...rec,
      result: rec.result === null || rec.result === undefined ? null : JSON.stringify(rec.result),
    });
  },
  get(db: Db, id: string): OperationRecord | null {
    const row = db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as Row | undefined;
    return row ? mapOperation(row) : null;
  },
  getByLogicalKey(db: Db, logicalKey: string): OperationRecord | null {
    const row = db.prepare("SELECT * FROM operations WHERE logical_key = ?").get(logicalKey) as
      Row | undefined;
    return row ? mapOperation(row) : null;
  },
  listForCase(db: Db, caseId: string): OperationRecord[] {
    return (
      db
        .prepare("SELECT * FROM operations WHERE case_id = ? ORDER BY created_at")
        .all(caseId) as Row[]
    ).map(mapOperation);
  },
  listByStatus(db: Db, status: string): OperationRecord[] {
    return (
      db
        .prepare("SELECT * FROM operations WHERE status = ? ORDER BY created_at")
        .all(status) as Row[]
    ).map(mapOperation);
  },
  /** Acquire the single dispatch reservation. Returns true when this caller now owns the dispatch. */
  acquireDispatch(db: Db, id: string, leaseUntilIso: string, nowIso: string): boolean {
    const info = db
      .prepare(
        `UPDATE operations SET status = 'DISPATCHING', attempts = attempts + 1, lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'PREPARED'`,
      )
      .run(leaseUntilIso, nowIso, id);
    return info.changes === 1;
  },
  deleteForCase(db: Db, caseId: string): void {
    db.prepare("DELETE FROM operations WHERE case_id = ?").run(caseId);
  },
};

/* ---------------------------------- claim reservations ------------------- */

function mapClaim(r: Row): ClaimReservationRecord {
  return {
    chargeId: str(r.charge_id),
    environment: str(r.environment) as ClaimReservationRecord["environment"],
    caseId: str(r.case_id),
    channel: str(r.channel) as ClaimReservationRecord["channel"],
    state: str(r.state) as ClaimReservationRecord["state"],
    operationId: s(r.operation_id),
    providerRef: s(r.provider_ref),
    openedAt: str(r.opened_at),
    updatedAt: str(r.updated_at),
  };
}

export const claims = {
  get(db: Db, chargeId: string): ClaimReservationRecord | null {
    const row = db.prepare("SELECT * FROM claim_reservations WHERE charge_id = ?").get(chargeId) as
      Row | undefined;
    return row ? mapClaim(row) : null;
  },
  listForPayment(db: Db, chargeId: string): ClaimReservationRecord[] {
    const ids = new Set([chargeId, ...charges.listForPayment(db, chargeId).map((rec) => rec.id)]);
    return Array.from(ids).flatMap((id) => {
      const claim = claims.get(db, id);
      return claim ? [claim] : [];
    });
  },
  getForPayment(db: Db, chargeId: string): ClaimReservationRecord | null {
    return claims.listForPayment(db, chargeId)[0] ?? null;
  },
  /**
   * Reserve the single claim slot for a charge. The primary key makes this atomic across
   * concurrent requests, restarts and other processes using the same database file.
   * Returns false (and changes nothing) when another reservation already holds the slot.
   */
  reserve(db: Db, rec: ClaimReservationRecord): boolean {
    // BEGIN IMMEDIATE makes the alias check and insert atomic across processes, including two
    // different local charge IDs for one payment. Nested calls use the caller's transaction.
    return db
      .transaction(() => {
        if (claims.getForPayment(db, rec.chargeId)) return false;
        const info = db
          .prepare(
            `INSERT OR IGNORE INTO claim_reservations (charge_id, environment, case_id, channel, state, operation_id, provider_ref, opened_at, updated_at)
           VALUES (@chargeId, @environment, @caseId, @channel, @state, @operationId, @providerRef, @openedAt, @updatedAt)`,
          )
          .run(rec);
        return info.changes === 1;
      })
      .immediate();
  },
  markOpen(
    db: Db,
    chargeId: string,
    operationId: string | null,
    providerRef: string | null,
    nowIso: string,
  ): boolean {
    const info = db
      .prepare(
        `UPDATE claim_reservations SET state = 'OPEN', provider_ref = COALESCE(?, provider_ref), updated_at = ?
         WHERE charge_id = ? AND (? IS NULL OR operation_id = ?)`,
      )
      .run(providerRef, nowIso, chargeId, operationId, operationId);
    return info.changes === 1;
  },
  /** Release only the reservation held by this operation (or, with null, any reservation for the charge). */
  release(db: Db, chargeId: string, operationId: string | null): boolean {
    const info =
      operationId === null
        ? db.prepare("DELETE FROM claim_reservations WHERE charge_id = ?").run(chargeId)
        : db
            .prepare("DELETE FROM claim_reservations WHERE charge_id = ? AND operation_id = ?")
            .run(chargeId, operationId);
    return info.changes === 1;
  },
  /** Release exactly the observed claim, never a replacement that later took its charge slot. */
  releaseObserved(db: Db, claim: ClaimReservationRecord): boolean {
    return (
      db
        .prepare(
          `DELETE FROM claim_reservations WHERE charge_id=@chargeId AND environment=@environment
       AND case_id=@caseId AND channel=@channel AND state=@state AND operation_id IS @operationId
       AND provider_ref IS @providerRef AND opened_at=@openedAt AND updated_at=@updatedAt`,
        )
        .run(claim).changes === 1
    );
  },
  listForCase(db: Db, caseId: string): ClaimReservationRecord[] {
    return (
      db.prepare("SELECT * FROM claim_reservations WHERE case_id = ?").all(caseId) as Row[]
    ).map(mapClaim);
  },
  deleteForCase(db: Db, caseId: string): void {
    db.prepare("DELETE FROM claim_reservations WHERE case_id = ?").run(caseId);
  },
};

/* ---------------------------------- audit -------------------------------- */

export const audit = {
  append(db: Db, entry: Omit<AuditEntry, "id">): void {
    db.prepare(
      `INSERT INTO audit_log (at, environment, actor, role, action, case_id, operation_id, approval_id, reason_code, details_json)
       VALUES (@at, @environment, @actor, @role, @action, @caseId, @operationId, @approvalId, @reasonCode, @details)`,
    ).run({
      ...entry,
      details:
        entry.details === null || entry.details === undefined
          ? null
          : JSON.stringify(entry.details),
    });
  },
  listForCase(db: Db, caseId: string, limit = 200): AuditEntry[] {
    return (
      db
        .prepare("SELECT * FROM audit_log WHERE case_id = ? ORDER BY id DESC LIMIT ?")
        .all(caseId, limit) as Row[]
    ).map((r) => ({
      id: n(r.id) ?? 0,
      at: str(r.at),
      environment: str(r.environment) as AuditEntry["environment"],
      actor: str(r.actor),
      role: s(r.role) as AuditEntry["role"],
      action: str(r.action),
      caseId: s(r.case_id),
      operationId: s(r.operation_id),
      approvalId: s(r.approval_id),
      reasonCode: s(r.reason_code),
      details: j(r.details_json, null),
    }));
  },
  /** Deletion keeps a minimal, non-personal marker and removes payload details for the case. */
  scrubForCase(db: Db, caseId: string, markerIso: string, environment: string): void {
    db.prepare("DELETE FROM audit_log WHERE case_id = ?").run(caseId);
    db.prepare(
      `INSERT INTO audit_log (at, environment, actor, role, action, case_id, operation_id, approval_id, reason_code, details_json)
       VALUES (?, ?, 'system', NULL, 'case.deleted', ?, NULL, NULL, 'DELETED', NULL)`,
    ).run(markerIso, environment, caseId);
  },
};
