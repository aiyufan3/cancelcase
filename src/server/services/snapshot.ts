import type { AppContext } from "../context";
import { cases, charges, contacts, evidence as evidenceRepo, subscriptions } from "../db/repos";
import type { CaseRecord, ChargeRecord, EvidenceRecord, SubscriptionRecord } from "../records";
import type {
  ContactEvent,
  DraftContent,
  NormalizedFact,
  Role,
  RoleSnapshot,
  SourceMeta,
} from "@/domain/types";
import type { ReferenceScope } from "@/domain/claims";
import { formatCents } from "@/domain/money";

/**
 * Build the immutable, role-filtered snapshot that drafting, export and action payloads
 * work from. Role-private evidence is removed here, before any model context, export or
 * payload is constructed. Facts carried by invisible sources are dropped; system facts
 * (charge, subscription, provider observation) are shared knowledge and keep only the
 * source references the role may see.
 */
const BASIS_TEXT: Record<string, string> = {
  user_attestation: "user attestation without a document",
  merchant_confirmation_document: "merchant confirmation document kept by the buyer",
  provider_api_observation: "provider API observation",
};

export interface CaseBundle {
  caseRecord: CaseRecord;
  charge: ChargeRecord;
  subscription: SubscriptionRecord;
  allEvidence: EvidenceRecord[];
}

export function loadCaseBundle(ctx: AppContext, caseId: string): CaseBundle | null {
  const caseRecord = cases.get(ctx.db, caseId);
  if (!caseRecord) return null;
  const charge = charges.get(ctx.db, caseRecord.chargeId);
  const subscription = subscriptions.get(ctx.db, caseRecord.subscriptionId);
  if (!charge || !subscription) return null;
  const allEvidence = evidenceRepo.listForCase(ctx.db, caseId, subscription.id);
  return { caseRecord, charge, subscription, allEvidence };
}

export function isEvidenceVisible(record: EvidenceRecord, role: Role): boolean {
  return record.ownerRole === role || record.visibility === "shared";
}

export function visibleEvidence(bundle: CaseBundle, role: Role): EvidenceRecord[] {
  return bundle.allEvidence.filter((e) => isEvidenceVisible(e, role));
}

export function toSourceMeta(e: EvidenceRecord): SourceMeta {
  return {
    id: e.id,
    kind: e.kind,
    label: e.label,
    provenance: e.provenance,
    ownerRole: e.ownerRole,
    visibility: e.visibility,
    sha256: e.sha256,
    capturedAt: e.capturedAt,
    eventTime: e.eventTime,
  };
}

/**
 * Typed, traceable origins for case-level facts that do not come from an uploaded document:
 * the stored provider (or simulated) records behind the charge, the subscription and the
 * provider case. Each is derived from a persisted record and carries that record's provenance
 * and observation time; nothing is invented when no such record exists, so a fact without any
 * document or observation stays untraceable and cannot be cited.
 */
export function observationSources(bundle: CaseBundle): SourceMeta[] {
  const { caseRecord, charge, subscription } = bundle;
  const out: SourceMeta[] = [];
  const observed = (refs: { provenance: string }[]): "sandbox_api" | "synthetic" | null =>
    refs.some((r) => r.provenance === "sandbox_api")
      ? "sandbox_api"
      : refs.some((r) => r.provenance === "synthetic")
        ? "synthetic"
        : null;
  const chargeProv = observed(charge.providerRefs);
  if (chargeProv)
    out.push({
      id: `obs_charge_${charge.id}`,
      kind: "provider_observation",
      label:
        chargeProv === "sandbox_api"
          ? "Payment record read from PayPal Sandbox"
          : "Simulated payment record (fixture)",
      provenance: chargeProv,
      ownerRole: "system",
      visibility: "shared",
      sha256: null,
      capturedAt: charge.updatedAt,
      eventTime: charge.eventTime,
    });
  const subProv = observed(subscription.providerRefs.filter((r) => r.kind === "subscription_id"));
  if (subProv)
    out.push({
      id: `obs_subscription_${subscription.id}`,
      kind: "provider_observation",
      label:
        subProv === "sandbox_api"
          ? "Subscription record read from PayPal Sandbox"
          : "Simulated subscription record (fixture)",
      provenance: subProv,
      ownerRole: "system",
      visibility: "shared",
      sha256: null,
      capturedAt: subscription.providerStatusObservedAt ?? subscription.updatedAt,
      eventTime: null,
    });
  const obs = caseRecord.providerObservation;
  if (obs?.disputeId && (obs.provenance === "sandbox_api" || obs.provenance === "synthetic"))
    out.push({
      id: `obs_case_${caseRecord.id}`,
      kind: "provider_observation",
      label:
        obs.provenance === "sandbox_api"
          ? "Provider case read-back (PayPal Sandbox)"
          : "Simulated provider case read-back (fixture)",
      provenance: obs.provenance,
      ownerRole: "system",
      visibility: "shared",
      sha256: null,
      capturedAt: obs.observedAt,
      eventTime: null,
    });
  return out;
}

export function buildRoleSnapshot(ctx: AppContext, bundle: CaseBundle, role: Role): RoleSnapshot {
  const { caseRecord, charge, subscription } = bundle;
  const visible = visibleEvidence(bundle, role);
  const visibleIds = new Set(visible.map((e) => e.id));
  const onlyVisible = (ids: string[]): string[] => ids.filter((id) => visibleIds.has(id));
  const observations = observationSources(bundle);
  const obsId = (prefix: string) => observations.find((o) => o.id.startsWith(prefix))?.id;
  const withObs = (ids: string[], prefix: string): string[] => {
    const o = obsId(prefix);
    return o ? [...ids, o] : ids;
  };
  const facts: NormalizedFact[] = [];

  facts.push({
    id: "fact_subscription",
    system: true,
    kind: "subscription",
    label: "Subscription",
    at: null,
    cents: subscription.amountCents,
    currency: subscription.currency,
    text: `${subscription.label} with ${subscription.merchantAlias}`,
    sourceIds: withObs(onlyVisible(subscription.sourceIds), "obs_subscription_"),
    visibleTo: ["buyer", "merchant"],
  });

  const c = subscription.cancellation;
  if (c.requestedAt) {
    facts.push({
      id: "fact_cancel_request",
      system: true,
      kind: "cancellation_request",
      label: "Cancellation requested",
      at: c.requestedAt,
      cents: null,
      currency: null,
      text: "Cancellation request recorded",
      sourceIds: onlyVisible(c.evidenceIds),
      visibleTo: ["buyer", "merchant"],
    });
  }
  if (c.state === "CANCEL_CONFIRMED" && c.effectiveAt) {
    facts.push({
      id: "fact_cancel_effective",
      system: true,
      kind: "cancellation_effective",
      label: "Cancellation effective",
      at: c.effectiveAt,
      cents: null,
      currency: null,
      text: BASIS_TEXT[c.basis ?? ""] ?? "basis not recorded",
      sourceIds: onlyVisible(c.evidenceIds),
      visibleTo: ["buyer", "merchant"],
    });
  }

  facts.push({
    id: "fact_charge",
    system: true,
    kind: "charge",
    label: "Charge",
    at: charge.eventTime,
    cents: charge.amountCents,
    currency: charge.currency,
    text: `${charge.status} ${charge.currency} ${charge.amountCents !== null ? formatCents(charge.amountCents).replace(" USD", "") : "(amount unknown)"} charge by ${charge.merchantAlias}${charge.description ? ` — ${charge.description}` : ""}`,
    sourceIds: withObs(onlyVisible(charge.sourceIds), "obs_charge_"),
    visibleTo: ["buyer", "merchant"],
  });
  if (charge.refundedCents !== null && charge.refundedCents > 0) {
    facts.push({
      id: "fact_refund",
      system: true,
      kind: "refund",
      label: "Refund recorded",
      at: null,
      cents: charge.refundedCents,
      currency: charge.currency,
      text: `Confirmed refund of ${formatCents(charge.refundedCents)}`,
      sourceIds: withObs(onlyVisible(charge.sourceIds), "obs_charge_"),
      visibleTo: ["buyer", "merchant"],
    });
  }
  if (charge.servicePeriodStart && charge.servicePeriodEnd) {
    facts.push({
      id: "fact_service_period",
      system: true,
      kind: "service_period",
      label: "Service period on receipt",
      at: charge.servicePeriodStart,
      until: charge.servicePeriodEnd,
      cents: null,
      currency: null,
      text: `Service period ${charge.servicePeriodStart.slice(0, 10)} to ${charge.servicePeriodEnd.slice(0, 10)}`,
      sourceIds: onlyVisible(charge.sourceIds),
      visibleTo: ["buyer", "merchant"],
    });
  }
  const obs = caseRecord.providerObservation;
  if (obs?.disputeId) {
    facts.push({
      id: "fact_provider_case",
      system: true,
      kind: "provider_case",
      label: "Provider case",
      at: obs.observedAt,
      cents: null,
      currency: null,
      // No identifier in prose: the payload carries the case reference separately, and text
      // shown on screen or sent onward should not need masking.
      text: `${obs.provenance === "synthetic" ? "simulated" : "observed"} provider case, status ${obs.status ?? "unknown"}`,
      sourceIds: withObs([], "obs_case_"),
      visibleTo: ["buyer", "merchant"],
    });
  }

  // Facts carried by evidence the role can see.
  for (const e of visible) {
    for (const f of e.facts) {
      if (!f.visibleTo.includes(role)) continue;
      facts.push({ ...f, sourceIds: onlyVisible(f.sourceIds.length > 0 ? f.sourceIds : [e.id]) });
    }
  }

  const contactHistory: ContactEvent[] = contacts
    .listForCase(ctx.db, caseRecord.id)
    .filter((ev) => ev.visibleTo.includes(role))
    .map((ev) => ({
      id: ev.id,
      at: ev.at,
      direction: ev.direction,
      summary: ev.summary,
      sourceIds: onlyVisible(ev.sourceIds),
      visibleTo: ev.visibleTo,
    }));

  const gaps: string[] = [];
  if (contactHistory.length === 0) gaps.push("No contact with the other party has been recorded.");
  if (!charge.refundStateKnown) gaps.push("Refund state has not been verified.");
  if (!obs) gaps.push("No provider case has been observed for this charge.");
  if (c.state !== "CANCEL_CONFIRMED")
    gaps.push("Cancellation is not confirmed with an effective time.");

  return {
    version: caseRecord.evidenceSnapshotVersion,
    role,
    environment: ctx.config.mode,
    caseId: caseRecord.id,
    facts,
    sources: [...visible.map(toSourceMeta), ...observations],
    claimableCents: caseRecord.claimableCents,
    requestedCents: caseRecord.requestedCents,
    currency: "USD",
    channel: caseRecord.channel,
    contactHistory,
    gaps,
  };
}

/**
 * The subset of a role snapshot that may be disclosed to a recipient (the other party or a
 * provider reviewer). A role can read its own private sources, but reading is not consent to
 * send: only shared sources, plus private sources the author explicitly included, survive.
 * Facts carried only by undisclosed sources are dropped; case-level facts keep only their
 * disclosed source references; private contact notes stay out.
 */
export function buildOutwardSnapshot(
  snapshot: RoleSnapshot,
  includedPrivateSourceIds: readonly string[] = [],
): RoleSnapshot {
  const included = new Set(includedPrivateSourceIds);
  const sources = snapshot.sources.filter(
    (s) => s.visibility === "shared" || (s.ownerRole === snapshot.role && included.has(s.id)),
  );
  const disclosed = new Set(sources.map((s) => s.id));
  const facts = snapshot.facts
    .filter((f) => f.system || f.sourceIds.some((id) => disclosed.has(id)))
    .map((f) => ({ ...f, sourceIds: f.sourceIds.filter((id) => disclosed.has(id)) }));
  const contactHistory = snapshot.contactHistory
    .filter((c) => c.visibleTo.includes("buyer") && c.visibleTo.includes("merchant"))
    .map((c) => ({ ...c, sourceIds: c.sourceIds.filter((id) => disclosed.has(id)) }));
  return { ...snapshot, sources, facts, contactHistory };
}

/** Transaction ID kinds in the order a letter names them: the merchant's own ID first. */
const TRANSACTION_REF_ORDER = [
  "seller_transaction_id",
  "subscription_sale_id",
  "capture_id",
  "buyer_transaction_id",
] as const;

/**
 * Transaction IDs carried by the stored PayPal (or simulated) payment record behind the charge.
 * A value an operator typed in is not part of that record and is not offered.
 */
export function recordTransactionIds(bundle: CaseBundle): string[] {
  return TRANSACTION_REF_ORDER.flatMap((kind) =>
    bundle.charge.providerRefs
      .filter(
        (r) => r.kind === kind && (r.provenance === "sandbox_api" || r.provenance === "synthetic"),
      )
      .map((r) => r.value),
  );
}

/** The transaction IDs the draft validator accepts in a claim, by the fact whose record has them. */
export function referenceScope(bundle: CaseBundle): ReferenceScope {
  return { transactionIdsByFact: new Map([["fact_charge", recordTransactionIds(bundle)]]) };
}

/**
 * The reference a buyer's letter ends with: the payment record's transaction ID, only when a claim
 * cites that record. Null otherwise, and always null for the merchant's response.
 */
export function transactionReference(
  bundle: CaseBundle,
  content: DraftContent,
): { transactionId: string } | null {
  if (content.action === "merchant_provide_evidence") return null;
  const record = observationSources(bundle).find((o) => o.id.startsWith("obs_charge_"));
  if (!record || !content.claims.some((c) => c.sourceIds.includes(record.id))) return null;
  const transactionId = recordTransactionIds(bundle)[0];
  return transactionId ? { transactionId } : null;
}

/** What the role can see but has not chosen to disclose, in the shape the draft validator uses. */
export function disclosureScope(
  roleSnapshot: RoleSnapshot,
  outward: RoleSnapshot,
): { undisclosedSourceIds: Set<string>; undisclosedFactIds: Set<string> } {
  const outwardFacts = new Set(outward.facts.map((f) => f.id));
  return {
    undisclosedSourceIds: undisclosedSourceIds(roleSnapshot, outward),
    undisclosedFactIds: new Set(
      roleSnapshot.facts.filter((f) => !outwardFacts.has(f.id)).map((f) => f.id),
    ),
  };
}

/** IDs the role can see but has not chosen to disclose. */
export function undisclosedSourceIds(
  roleSnapshot: RoleSnapshot,
  outward: RoleSnapshot,
): Set<string> {
  const disclosed = new Set(outward.sources.map((s) => s.id));
  return new Set(roleSnapshot.sources.filter((s) => !disclosed.has(s.id)).map((s) => s.id));
}
