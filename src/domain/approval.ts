import type { ActionKind, Environment, Role } from "./types";
import { hashCanonical } from "./canonical";
import { addMinutes, isExpired, type Clock } from "./time";

/**
 * Approval binding. An approval is valid only for the exact action, role, environment,
 * account, resource, payload version, evidence snapshot and attachment bytes it was
 * granted for, and only until it expires. Any material edit produces a different
 * fingerprint and therefore invalidates the approval.
 */

export const APPROVAL_LIFETIME_MINUTES = 15;

export interface ApprovalBinding {
  actor: string;
  role: Role;
  environment: Environment;
  accountAlias: string;
  resourceId: string;
  action: ActionKind;
  payloadHash: string;
  payloadVersion: number;
  evidenceSnapshotVersion: number;
  /** sha256 of each attachment's bytes, sorted */
  attachmentHashes: string[];
}

export function normalizeBinding(binding: ApprovalBinding): ApprovalBinding {
  return { ...binding, attachmentHashes: [...binding.attachmentHashes].sort() };
}

export function bindingFingerprint(binding: ApprovalBinding): string {
  return hashCanonical(normalizeBinding(binding));
}

export interface ApprovalRecordLike {
  decision: "approved" | "rejected" | "pending";
  fingerprint: string;
  expiresAt: string;
  consumedByOperationId: string | null;
  revokedReason: string | null;
}

export type ApprovalCheckCode =
  "NOT_APPROVED" | "REJECTED" | "EXPIRED" | "BINDING_MISMATCH" | "ALREADY_CONSUMED" | "REVOKED";

export interface ApprovalCheck {
  valid: boolean;
  codes: ApprovalCheckCode[];
}

export function checkApproval(
  approval: ApprovalRecordLike,
  currentBinding: ApprovalBinding,
  clock: Clock,
): ApprovalCheck {
  const codes: ApprovalCheckCode[] = [];
  if (approval.decision === "rejected") codes.push("REJECTED");
  else if (approval.decision !== "approved") codes.push("NOT_APPROVED");
  if (approval.revokedReason) codes.push("REVOKED");
  if (isExpired(approval.expiresAt, clock)) codes.push("EXPIRED");
  if (approval.fingerprint !== bindingFingerprint(currentBinding)) codes.push("BINDING_MISMATCH");
  if (approval.consumedByOperationId) codes.push("ALREADY_CONSUMED");
  return { valid: codes.length === 0, codes };
}

export function approvalExpiry(decidedAtIso: string): string {
  return addMinutes(decidedAtIso, APPROVAL_LIFETIME_MINUTES);
}

/**
 * Semantic fingerprint of the facts an approval was granted against: everything that decides
 * the payload or the eligibility of the action — amounts, charge and refund facts, the
 * cancellation basis and its evidence, the channel, and the provider's status, capabilities,
 * requested evidence and deadline. Observation timestamps and refresh bookkeeping are
 * deliberately excluded, so a refresh that reports the same facts keeps the approval valid.
 */
export interface MaterialFacts {
  environment: Environment;
  evidenceSnapshotVersion: number;
  channel: string;
  claimableCents: number | null;
  requestedCents: number | null;
  charge: {
    status: string;
    amountCents: number | null;
    refundedCents: number | null;
    refundStateKnown: boolean;
    eventTime: string | null;
  };
  cancellation: {
    state: string;
    effectiveAt: string | null;
    basis: string | null;
    evidenceIds: string[];
  };
  provider: {
    disputeId: string | null;
    status: string | null;
    stage: string | null;
    outcome: string | null;
    allowedActions: string[];
    requestedEvidenceTypes: string[];
    sellerResponseDueAt: string | null;
    enumsUnderstood: boolean;
  } | null;
}

export function materialFingerprint(facts: MaterialFacts): string {
  return hashCanonical({
    ...facts,
    cancellation: {
      ...facts.cancellation,
      evidenceIds: [...facts.cancellation.evidenceIds].sort(),
    },
    provider: facts.provider
      ? {
          ...facts.provider,
          allowedActions: [...facts.provider.allowedActions].sort(),
          requestedEvidenceTypes: [...facts.provider.requestedEvidenceTypes].sort(),
        }
      : null,
  });
}

/** The material part of a provider observation (no timestamps, versions or stale flags). */
export function providerMaterial(
  o: {
    disputeId: string | null;
    status: string | null;
    stage: string | null;
    outcome: string | null;
    allowedActions: string[];
    requestedEvidenceTypes: string[];
    sellerResponseDueAt: string | null;
    enumsUnderstood: boolean;
  } | null,
): MaterialFacts["provider"] {
  if (!o) return null;
  return {
    disputeId: o.disputeId,
    status: o.status,
    stage: o.stage,
    outcome: o.outcome,
    allowedActions: [...o.allowedActions].sort(),
    requestedEvidenceTypes: [...o.requestedEvidenceTypes].sort(),
    sellerResponseDueAt: o.sellerResponseDueAt,
    enumsUnderstood: o.enumsUnderstood,
  };
}
