/**
 * Framework-independent domain types for CancelCase.
 *
 * Three facts are deliberately kept apart everywhere in this module:
 *  - the cancellation record (what the user/merchant/provider said about cancelling),
 *  - the local case workflow (what this application has done so far),
 *  - the provider dispute observation (what PayPal reported when we last read it back).
 * None of them implies another.
 */

export type Environment = "fixture" | "sandbox";
export type Role = "buyer" | "merchant";

/** Where a record came from. A `synthetic` record never counts as a provider result. */
export type Provenance = "synthetic" | "sandbox_api" | "user_attestation";

export type Currency = "USD";

export interface Money {
  /** Integer minor units (cents). Never a float. */
  cents: number;
  currency: Currency;
}

export type Channel = "merchant_refund" | "app_store" | "paypal" | "chargeback";

export const CHANNELS: readonly Channel[] = [
  "merchant_refund",
  "app_store",
  "paypal",
  "chargeback",
];

/** Only the PayPal channel has a connected adapter in P0. */
export const CONNECTED_CHANNELS: readonly Channel[] = ["paypal"];

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export type CancellationState =
  "TRACKING" | "CANCEL_REQUESTED" | "CANCEL_CONFIRMED" | "NEEDS_REVIEW";

export type CancellationBasis =
  "user_attestation" | "merchant_confirmation_document" | "provider_api_observation";

export interface CancellationRecord {
  state: CancellationState;
  /** When the user says they asked for cancellation (ISO instant) */
  requestedAt: string | null;
  /** When confirmation arrived (ISO instant) */
  confirmationReceivedAt: string | null;
  /** When the cancellation takes effect (ISO instant). Required for CANCEL_CONFIRMED. */
  effectiveAt: string | null;
  basis: CancellationBasis | null;
  evidenceIds: string[];
  reviewReasons: CancellationReviewReason[];
  /**
   * Separate provider observation of the payment mandate (e.g. PayPal subscription status).
   * A cancelled mandate and a cancelled service contract are not the same fact.
   */
  providerMandateStatus: string | null;
  providerMandateObservedAt: string | null;
  /** Where the mandate observation came from (simulated in fixture mode); absent on older records */
  providerMandateProvenance?: Provenance | null;
  /**
   * When the provider plans to bill the mandate next, as stated by the same observation. It is
   * the provider's plan, not a payment; absent on older records and when the read did not say.
   */
  providerMandateNextBillingAt?: string | null;
}

export type CancellationReviewReason =
  | "MISSING_EVIDENCE"
  | "MISSING_EFFECTIVE_TIME"
  | "MISSING_BASIS"
  | "INVALID_TIMESTAMP"
  | "CONFLICTING_EFFECTIVE_TIME"
  | "CONFIRMATION_BEFORE_REQUEST";

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

export type ChargeStatus =
  | "COMPLETED"
  | "PENDING"
  | "FAILED"
  | "DENIED"
  | "REVERSED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"
  | "UNKNOWN";

export type ProviderRefKind =
  | "order_id"
  | "subscription_sale_id"
  | "capture_id"
  | "seller_transaction_id"
  | "buyer_transaction_id"
  | "reporting_row_id"
  | "subscription_id"
  | "plan_id"
  | "product_id"
  | "dispute_id";

export interface ProviderRef {
  kind: ProviderRefKind;
  value: string;
  provenance: Provenance;
}

export type MatchMethod =
  | "explicit_reviewed_association"
  | "provider_subscription_transaction"
  | "merchant_name_only"
  | "none";

export interface ChargeFacts {
  id: string;
  environment: Environment;
  accountAlias: string;
  merchantAlias: string;
  subscriptionId: string | null;
  matchMethod: MatchMethod;
  /** When the payment was initiated/created at the provider (ISO instant) */
  eventTime: string | null;
  /** When it posted/settled (ISO instant) */
  postedTime: string | null;
  /** When this application ingested it (ISO instant) */
  ingestedTime: string;
  status: ChargeStatus;
  amount: Money | null;
  /** Confirmed refunded amount in cents; null when unknown */
  refundedCents: number | null;
  /** True when refund state has been read back and is settled */
  refundStateKnown: boolean;
  currency: string;
  /** Service period covered by the charge when known from a receipt/provider */
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  /** Explicit arrears/outstanding-balance indicator when known; null when unknown */
  arrearsIndicator: boolean | null;
  sourceIds: string[];
}

export interface SubscriptionFacts {
  id: string;
  environment: Environment;
  accountAlias: string;
  merchantAlias: string;
  cancellation: CancellationRecord;
  sourceIds: string[];
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type Classification = "CANDIDATE_AFTER_CANCEL" | "NEEDS_REVIEW" | "NO_ANOMALY";

export type ReasonCode =
  | "ENVIRONMENT_MISMATCH"
  | "ACCOUNT_MISMATCH"
  | "DIFFERENT_SUBSCRIPTION"
  | "ASSOCIATION_UNRELIABLE"
  | "NO_ASSOCIATION"
  | "SUBSCRIPTION_ACTIVE_NO_CANCELLATION"
  | "CANCELLATION_NOT_CONFIRMED"
  | "CANCELLATION_NEEDS_REVIEW"
  | "UNSUPPORTED_CURRENCY"
  | "AMOUNT_UNKNOWN"
  | "ZERO_AMOUNT"
  | "CHARGE_PENDING"
  | "CHARGE_NOT_COMPLETED"
  | "CHARGE_REVERSED"
  | "FULLY_REFUNDED"
  | "PARTIAL_REFUND_REDUCES_CLAIM"
  | "REFUND_STATE_UNKNOWN"
  | "MISSING_EVENT_TIME"
  | "INVALID_TIMESTAMP"
  | "CHARGE_BEFORE_CANCELLATION"
  | "POSTED_AFTER_BUT_INITIATED_BEFORE"
  | "BOUNDARY_EQUALITY"
  | "CHARGE_AFTER_EFFECTIVE_CANCELLATION"
  | "POSSIBLE_ARREARS"
  | "SERVICE_PERIOD_BEFORE_CANCELLATION"
  | "SERVICE_PERIOD_UNKNOWN"
  | "CHARGE_STATUS_UNKNOWN";

export interface ReconcileResult {
  classification: Classification;
  reasonCodes: ReasonCode[];
  /** Every source that contributed to the decision */
  sourceIds: string[];
  /** Maximum amount that could be requested, in cents; null when not computable */
  claimableCents: number | null;
  /** Facts carried through unchanged (never invented) */
  facts: {
    effectiveAt: string | null;
    eventTime: string | null;
    postedTime: string | null;
    servicePeriodStart: string | null;
    servicePeriodEnd: string | null;
  };
}

// ---------------------------------------------------------------------------
// Case workflow and provider observation
// ---------------------------------------------------------------------------

export type WorkflowState =
  | "FLAGGED"
  | "DRAFTING"
  | "READY_FOR_REVIEW"
  | "AWAITING_APPROVAL"
  | "EXECUTING"
  | "SYNCED"
  | "REJECTED"
  | "BLOCKED"
  | "UNKNOWN";

export type WorkflowEvent =
  | { type: "START_DRAFT" }
  | { type: "DRAFT_READY" }
  | { type: "DRAFT_INVALID"; reason: string }
  | { type: "REQUEST_APPROVAL" }
  | { type: "APPROVE" }
  | { type: "REJECT"; reason: string }
  | { type: "EDIT" }
  | { type: "INVALIDATE"; reason: string }
  | { type: "DISPATCH_STARTED" }
  | { type: "DISPATCH_SUCCEEDED" }
  | { type: "DISPATCH_FAILED"; reason: string }
  | { type: "DISPATCH_UNKNOWN" }
  | { type: "RECOVERY_CONFIRMED_SUCCESS" }
  | { type: "RECOVERY_CONFIRMED_FAILURE"; reason: string }
  | { type: "REOPEN" };

export type ActionKind =
  | "export_refund_request"
  | "buyer_create_dispute"
  | "merchant_provide_evidence"
  | "sandbox_setup_product"
  | "sandbox_setup_plan"
  | "sandbox_setup_subscription"
  | "sandbox_cancel_subscription"
  | "sandbox_require_evidence"
  | "sandbox_adjudicate";

/** Actions that mutate something at the provider. Exports are not provider writes. */
export const PROVIDER_WRITE_ACTIONS: readonly ActionKind[] = [
  "buyer_create_dispute",
  "merchant_provide_evidence",
  "sandbox_setup_product",
  "sandbox_setup_plan",
  "sandbox_setup_subscription",
  "sandbox_cancel_subscription",
  "sandbox_require_evidence",
  "sandbox_adjudicate",
];

export const KNOWN_DISPUTE_STATUSES = [
  "OPEN",
  "WAITING_FOR_BUYER_RESPONSE",
  "WAITING_FOR_SELLER_RESPONSE",
  "UNDER_REVIEW",
  "RESOLVED",
  "OTHER",
] as const;
export type KnownDisputeStatus = (typeof KNOWN_DISPUTE_STATUSES)[number];

export const KNOWN_LIFECYCLE_STAGES = [
  "INQUIRY",
  "CHARGEBACK",
  "PRE_ARBITRATION",
  "ARBITRATION",
] as const;
export type KnownLifecycleStage = (typeof KNOWN_LIFECYCLE_STAGES)[number];

export type ProviderAllowedAction =
  | "provide_evidence"
  | "send_message"
  | "accept_claim"
  | "escalate"
  | "appeal"
  | "require_evidence"
  | "adjudicate"
  | "unknown";

export interface ProviderObservation {
  disputeId: string | null;
  provenance: Provenance;
  /** Raw status string as observed; may be outside the known enum */
  status: string | null;
  stage: string | null;
  outcome: string | null;
  reason: string | null;
  sellerResponseDueAt: string | null;
  requestedEvidenceTypes: string[];
  /** Actions derived from validated HATEOAS links */
  allowedActions: ProviderAllowedAction[];
  /**
   * Monotonic version assigned by this application. 0 marks the local reference saved from a
   * successful create response before any provider read; it is always stale.
   */
  observedVersion: number;
  observedAt: string;
  /** True when every enum value is understood by this application */
  enumsUnderstood: boolean;
  /** True when the last refresh attempt failed and this is a retained older snapshot */
  stale: boolean;
}

// ---------------------------------------------------------------------------
// Drafts and claims
// ---------------------------------------------------------------------------

export type ClaimKind = "fact" | "request" | "context" | "unknown";

export interface Claim {
  id: string;
  kind: ClaimKind;
  text: string;
  sourceIds: string[];
  factIds: string[];
}

export type DraftOrigin = "fixture_template" | "live_model" | "human_edit" | "repaired_model";

export interface DraftContent {
  action: ActionKind;
  role: Role;
  subject: string;
  claims: Claim[];
  /** Attachments selected by evidence id (not filename) */
  attachmentEvidenceIds: string[];
  /**
   * Role-private sources the author explicitly chose to disclose to the recipient. Seeing a
   * private source does not authorize sending it: by default only shared sources are used.
   * Absent on drafts created before this field existed (treated as none).
   */
  privateSourceIdsIncluded?: string[];
}

export interface NormalizedFact {
  id: string;
  kind:
    | "party"
    | "subscription"
    | "cancellation_request"
    | "cancellation_effective"
    | "charge"
    | "refund"
    | "contact"
    | "policy"
    | "service_period"
    | "provider_case"
    | "remedy";
  label: string;
  /** ISO instant when the fact has a time dimension */
  at: string | null;
  /** End of the range for facts that span a period (a service period); null otherwise */
  until?: string | null;
  /** Cents when the fact has an amount */
  cents: number | null;
  currency: string | null;
  text: string;
  sourceIds: string[];
  /** Roles that may see and cite this fact */
  visibleTo: Role[];
  /** Case-level fact assembled by the application (charge, cancellation, provider case…) */
  system?: boolean;
}

export interface SourceMeta {
  id: string;
  kind: string;
  label: string;
  provenance: Provenance;
  /** "system" for observations the application recorded from a provider read or simulation */
  ownerRole: Role | "system";
  visibility: "private" | "shared";
  sha256: string | null;
  capturedAt: string | null;
  eventTime: string | null;
}

/** Immutable, role-filtered material the model may draft from. */
export interface RoleSnapshot {
  version: number;
  role: Role;
  environment: Environment;
  caseId: string;
  facts: NormalizedFact[];
  sources: SourceMeta[];
  claimableCents: number | null;
  requestedCents: number | null;
  currency: Currency;
  channel: Channel;
  contactHistory: ContactEvent[];
  gaps: string[];
}

export interface ContactEvent {
  id: string;
  at: string;
  direction: "buyer_to_merchant" | "merchant_to_buyer" | "note";
  summary: string;
  sourceIds: string[];
  visibleTo: Role[];
}

export type DraftIssueCode =
  | "SCHEMA_INVALID"
  | "UNKNOWN_SOURCE"
  | "UNKNOWN_FACT"
  | "UNSOURCED_FACT"
  | "REQUIRED_FACT_MISSING"
  | "AMOUNT_MISMATCH"
  | "DATE_MISMATCH"
  | "UNSUPPORTED_CERTAINTY"
  | "OUTCOME_PROMISE"
  | "CONTRADICTION"
  | "ROLE_SCOPE_VIOLATION"
  | "EMPTY_DRAFT"
  | "ATTACHMENT_NOT_ALLOWED"
  | "UNDISCLOSED_SOURCE"
  | "UNTRACEABLE_FACT"
  | "CITATION_MISMATCH"
  | "REFERENCE_MISMATCH"
  | "NOTE";

export interface DraftIssue {
  code: DraftIssueCode;
  claimId: string | null;
  message: string;
  blocking: boolean;
}

export interface DraftValidation {
  ok: boolean;
  issues: DraftIssue[];
}
