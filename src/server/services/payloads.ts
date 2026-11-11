import type { CaseBundle } from "./snapshot";
import type { DraftRecord } from "../records";
import type { ActionKind, ProviderRef, Role } from "@/domain/types";
import type { BuyerDisputePayload, ProvideEvidencePayload } from "@/paypal/adapter";
import { contacts } from "../db/repos";
import type { AppContext } from "../context";
import { hashCanonical } from "@/domain/canonical";
import { materialFingerprint, providerMaterial, type MaterialFacts } from "@/domain/approval";

/**
 * Deterministic action payloads. The approval fingerprint is computed over the canonical
 * payload produced here, so any change in the facts, the draft or the attachments yields a
 * different hash. Payloads never contain credentials, tokens or local file paths.
 */

export interface ExportRefundRequestPayload {
  kind: "export_refund_request";
  caseId: string;
  role: Role;
  draftId: string;
  draftVersion: number;
  draftHash: string;
  subject: string;
  renderedText: string;
  attachmentEvidenceIds: string[];
  requestedCents: number | null;
}

export type ActionPayload =
  | ExportRefundRequestPayload
  | ({
      kind: "buyer_create_dispute";
      caseId: string;
      draftId: string;
      draftVersion: number;
      draftHash: string;
    } & BuyerDisputePayload)
  | ({
      kind: "merchant_provide_evidence";
      caseId: string;
      draftId: string;
      draftVersion: number;
      draftHash: string;
    } & ProvideEvidencePayload);

export function findRef(refs: ProviderRef[], kind: ProviderRef["kind"]): ProviderRef | null {
  return refs.find((r) => r.kind === kind) ?? null;
}

/**
 * File types PayPal accepts as dispute evidence documents (it also accepts GIF, which the
 * evidence store never stores). Text files can be cited and exported, never sent as documents.
 */
export const PROVIDER_EVIDENCE_MIMES: readonly string[] = [
  "application/pdf",
  "image/png",
  "image/jpeg",
];

export function isProviderEvidenceMime(mime: string | null | undefined): boolean {
  return mime != null && PROVIDER_EVIDENCE_MIMES.includes(mime);
}

/** A refund counts only when a provider read stated its amount. */
export function refundVerified(charge: {
  refundStateKnown: boolean;
  refundedCents: number | null;
}): boolean {
  return charge.refundStateKnown && (charge.refundedCents ?? 0) > 0;
}

/**
 * The evidence type labels what the response proves. Requested types such as proof of refund,
 * delivery or tracking each assert a specific proof; sending one this response does not carry
 * would be a false statement to the reviewer. OTHER takes notes and documents and claims nothing
 * more, so it is the default whatever the provider listed first.
 *
 * PROOF_OF_REFUND is never chosen in this version, even when a provider read showed a refund:
 * that type is expected to name the refund it proves, and this application neither records
 * refund references nor sends them. A verified refund is stated in the notes under OTHER.
 */
export function pickEvidenceType(
  requested: string[],
  _hasVerifiedRefund: boolean,
  hasCancellationDetails = false,
): string {
  if (hasCancellationDetails && requested.includes("CANCELLATION_DETAILS"))
    return "CANCELLATION_DETAILS";
  return "OTHER";
}

/** A requested type is not proof: the response must cite disclosed cancellation records. */
export function cancellationDetailsIncluded(
  bundle: CaseBundle,
  draft: DraftRecord | null,
): boolean {
  const cancellation = bundle.subscription.cancellation;
  if (!draft || cancellation.state !== "CANCEL_CONFIRMED" || !cancellation.effectiveAt)
    return false;
  const included = new Set(draft.content.privateSourceIdsIncluded ?? []);
  const proof = new Set(
    bundle.allEvidence
      .filter(
        (e) =>
          cancellation.evidenceIds.includes(e.id) &&
          (e.visibility === "shared" || (e.ownerRole === draft.role && included.has(e.id))),
      )
      .map((e) => e.id),
  );
  return draft.content.claims.some(
    (c) => c.factIds.includes("fact_cancel_effective") && c.sourceIds.some((id) => proof.has(id)),
  );
}

export const PROVIDER_NOTE_MAX_LENGTH = 2000;
export const PROVIDER_NOTE_LENGTH_MESSAGE =
  "The complete provider message exceeds 2,000 characters. Shorten the draft before approving; nothing is truncated or sent.";

export function providerNoteExceedsLimit(payload: ActionPayload): boolean {
  const note =
    payload.kind === "buyer_create_dispute"
      ? payload.note
      : payload.kind === "merchant_provide_evidence"
        ? payload.notes
        : "";
  return note.length > PROVIDER_NOTE_MAX_LENGTH;
}

export function buildActionPayload(
  ctx: AppContext,
  bundle: CaseBundle,
  draft: DraftRecord,
  role: Role,
  action: ActionKind,
): ActionPayload {
  const { caseRecord, charge, subscription } = bundle;
  const base = {
    caseId: caseRecord.id,
    draftId: draft.id,
    draftVersion: draft.version,
    draftHash: draft.contentHash,
  };
  switch (action) {
    case "export_refund_request":
      return {
        kind: "export_refund_request",
        ...base,
        role,
        subject: draft.content.subject,
        renderedText: draft.renderedText,
        attachmentEvidenceIds: [...draft.content.attachmentEvidenceIds].sort(),
        requestedCents: caseRecord.requestedCents,
      };
    case "buyer_create_dispute": {
      const buyerRef =
        findRef(charge.providerRefs, "buyer_transaction_id") ??
        findRef(charge.providerRefs, "seller_transaction_id");
      const contactEvents = contacts
        .listForCase(ctx.db, caseRecord.id)
        .filter((c) => c.direction === "buyer_to_merchant");
      const requested = caseRecord.requestedCents ?? caseRecord.claimableCents ?? 0;
      return {
        kind: "buyer_create_dispute",
        ...base,
        buyerTransactionId: buyerRef?.value ?? "",
        buyerTransactionProvenance: buyerRef?.provenance ?? "synthetic",
        reason: "CANCELED_RECURRING_BILLING",
        disputeAmountCents: requested,
        currency: "USD",
        note: draft.renderedText,
        merchantContacted: contactEvents.length > 0,
        merchantContactedAt: contactEvents[0]?.at ?? null,
        cancellation: {
          cancelledAt: subscription.cancellation.effectiveAt ?? "",
          cancellationNumber: null,
          cancellationMode:
            subscription.cancellation.basis === "provider_api_observation"
              ? "CANCELLED_PAYPAL_BILLING_AGREEMENT"
              : null,
        },
      };
    }
    case "merchant_provide_evidence": {
      const obs = caseRecord.providerObservation;
      return {
        kind: "merchant_provide_evidence",
        ...base,
        disputeId: obs?.disputeId ?? "",
        disputeIdProvenance: obs?.provenance ?? "synthetic",
        evidenceType: pickEvidenceType(
          obs?.requestedEvidenceTypes ?? [],
          refundVerified(charge),
          cancellationDetailsIncluded(bundle, draft),
        ),
        notes: draft.renderedText,
        attachmentEvidenceIds: [...draft.content.attachmentEvidenceIds].sort(),
      };
    }
    default:
      throw new Error(`No payload builder for action ${action}`);
  }
}

export function payloadHash(payload: ActionPayload): string {
  return hashCanonical(payload);
}

export function currentMaterialFacts(bundle: CaseBundle): MaterialFacts {
  const { caseRecord, charge, subscription } = bundle;
  const c = subscription.cancellation;
  return {
    environment: caseRecord.environment,
    evidenceSnapshotVersion: caseRecord.evidenceSnapshotVersion,
    channel: caseRecord.channel,
    claimableCents: caseRecord.claimableCents,
    requestedCents: caseRecord.requestedCents,
    charge: {
      status: charge.status,
      amountCents: charge.amountCents,
      refundedCents: charge.refundedCents,
      refundStateKnown: charge.refundStateKnown,
      eventTime: charge.eventTime,
    },
    cancellation: {
      state: c.state,
      effectiveAt: c.effectiveAt,
      basis: c.basis,
      evidenceIds: [...c.evidenceIds],
    },
    provider: providerMaterial(caseRecord.providerObservation),
  };
}

export function currentMaterialFingerprint(bundle: CaseBundle): string {
  return materialFingerprint(currentMaterialFacts(bundle));
}
