import type {
  ActionKind,
  CancellationRecord,
  Channel,
  ChargeStatus,
  Classification,
  DraftContent,
  DraftOrigin,
  DraftValidation,
  Environment,
  MatchMethod,
  NormalizedFact,
  ProviderObservation,
  ProviderRef,
  Provenance,
  ReasonCode,
  Role,
  WorkflowState,
} from "@/domain/types";
import type { ApprovalBinding } from "@/domain/approval";

export interface SubscriptionRecord {
  id: string;
  environment: Environment;
  accountAlias: string;
  ownerAlias: string;
  merchantAlias: string;
  label: string;
  amountCents: number | null;
  currency: string;
  providerRefs: ProviderRef[];
  providerStatus: string | null;
  providerStatusObservedAt: string | null;
  cancellation: CancellationRecord;
  sourceIds: string[];
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EvidenceKind =
  | "receipt"
  | "cancellation_confirmation"
  | "charge_record"
  | "screenshot"
  | "communication"
  | "merchant_record"
  | "note"
  | "provider_observation"
  | "other";

export interface EvidenceRecord {
  id: string;
  environment: Environment;
  accountAlias: string;
  caseId: string | null;
  subscriptionId: string | null;
  ownerRole: Role;
  visibility: "private" | "shared";
  provenance: Provenance;
  kind: EvidenceKind;
  label: string;
  storageName: string | null;
  mime: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  capturedAt: string | null;
  eventTime: string | null;
  facts: NormalizedFact[];
  textExcerpt: string | null;
  version: number;
  createdAt: string;
}

export interface ChargeRecord {
  id: string;
  environment: Environment;
  accountAlias: string;
  merchantAlias: string;
  subscriptionId: string | null;
  matchMethod: MatchMethod;
  providerRefs: ProviderRef[];
  description: string | null;
  eventTime: string | null;
  postedTime: string | null;
  ingestedTime: string;
  status: ChargeStatus;
  amountCents: number | null;
  currency: string;
  refundedCents: number | null;
  refundStateKnown: boolean;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  arrearsIndicator: boolean | null;
  sourceIds: string[];
  dedupeKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaseRecord {
  id: string;
  environment: Environment;
  accountAlias: string;
  chargeId: string;
  subscriptionId: string;
  buyerAlias: string;
  merchantAlias: string;
  channel: Channel;
  claimActive: boolean;
  claimClosedReason: string | null;
  buyerState: WorkflowState;
  merchantState: WorkflowState;
  classification: Classification;
  reasonCodes: ReasonCode[];
  claimableCents: number | null;
  requestedCents: number | null;
  evidenceSnapshotVersion: number;
  providerObservation: ProviderObservation | null;
  /** How the case came to exist; shown in the UI so manual steps are never hidden */
  origin: "fixture_seed" | "sandbox_setup" | "sandbox_import";
  originNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactEventRecord {
  id: string;
  caseId: string;
  at: string;
  direction: "buyer_to_merchant" | "merchant_to_buyer" | "note";
  summary: string;
  sourceIds: string[];
  visibleTo: Role[];
  createdAt: string;
}

export interface DraftRecord {
  id: string;
  environment: Environment;
  caseId: string;
  role: Role;
  action: ActionKind;
  version: number;
  content: DraftContent;
  renderedText: string;
  contentHash: string;
  origin: DraftOrigin;
  providerLabel: string | null;
  modelLabel: string | null;
  validation: DraftValidation;
  snapshotVersion: number;
  createdAt: string;
}

export type ApprovalDecision = "pending" | "approved" | "rejected";

export interface ApprovalRecord {
  id: string;
  environment: Environment;
  caseId: string;
  role: Role;
  action: ActionKind;
  draftId: string | null;
  fingerprint: string;
  binding: ApprovalBinding;
  materialFingerprint: string;
  decision: ApprovalDecision;
  decidedAt: string | null;
  expiresAt: string;
  approver: string | null;
  consumedByOperationId: string | null;
  revokedReason: string | null;
  createdAt: string;
}

export type OperationStatus = "PREPARED" | "DISPATCHING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
export type RecoveryDecision = "confirmed_succeeded" | "confirmed_failed" | "needs_manual_review";

export interface OperationRecord {
  id: string;
  logicalKey: string;
  environment: Environment;
  caseId: string;
  role: Role;
  action: ActionKind;
  resourceId: string;
  payload: unknown;
  payloadHash: string;
  payloadVersion: number;
  attachmentHashes: string[];
  approvalId: string | null;
  status: OperationStatus;
  attempts: number;
  leaseUntil: string | null;
  providerRequestId: string | null;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  recoveryDecision: RecoveryDecision | null;
  recoveryNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  environment: Environment;
  actor: string;
  role: Role | null;
  action: string;
  caseId: string | null;
  operationId: string | null;
  approvalId: string | null;
  reasonCode: string | null;
  details: unknown;
}

/**
 * One active or unresolved financial claim per charge. RESERVED: an operation that would open
 * a claim is prepared, dispatching or has an unknown outcome. OPEN: the provider confirmed a
 * claim (created, imported or recovered with evidence).
 */
export type ClaimReservationState = "RESERVED" | "OPEN";

export interface ClaimReservationRecord {
  chargeId: string;
  environment: Environment;
  caseId: string;
  channel: Channel;
  state: ClaimReservationState;
  operationId: string | null;
  providerRef: string | null;
  openedAt: string;
  updatedAt: string;
}
