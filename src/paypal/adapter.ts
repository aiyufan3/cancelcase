import type { Environment, ProviderObservation, Provenance } from "@/domain/types";

/**
 * Provider adapter boundary. The fixture adapter simulates PayPal deterministically and
 * labels everything synthetic. The Sandbox adapter talks to PayPal Sandbox only.
 * Writes are only ever invoked by the deterministic operation dispatcher, never by a model.
 */

export interface SafeError {
  /** Sanitized provider/HTTP code, e.g. 403, VALIDATION_ERROR, NETWORK_TIMEOUT */
  code: string;
  /** Redacted human-readable message (no tokens, assertions or account identifiers) */
  message: string;
  /** PayPal-Debug-Id or equivalent correlation ID when present (safe to store) */
  correlationId: string | null;
  /** HTTP status when the error came from an HTTP response */
  httpStatus: number | null;
}

export type ReadResult<T> =
  | { ok: true; data: T; provenance: Provenance; observedAt: string; correlationId: string | null }
  | { ok: false; error: SafeError; retriable: boolean };

export type WriteOutcome<T = unknown> =
  | {
      kind: "succeeded";
      result: T;
      provenance: Provenance;
      correlationId: string | null;
      providerRequestId: string | null;
    }
  | { kind: "failed"; error: SafeError }
  /** The request may or may not have reached the provider; never resend automatically. */
  | { kind: "unknown"; error: SafeError };

export interface DisputeReadback {
  observation: ProviderObservation;
  /** Minimal normalized fields safe to persist and display */
  summary: {
    disputeId: string;
    status: string | null;
    stage: string | null;
    reason: string | null;
    amountValue: string | null;
    amountCurrency: string | null;
    createTime: string | null;
    updateTime: string | null;
    sellerResponseDueAt: string | null;
    requestedEvidenceTypes: string[];
    rejectedLinks: { rel: string; reason: string }[];
    messagesCount: number | null;
    evidenceCount: number | null;
    /**
     * The disputed payment as the provider describes it, when the read includes it. This is the
     * only source an imported case may use for the payment time/status; the case creation time
     * is never a payment time.
     */
    transaction: {
      sellerTransactionId: string | null;
      buyerTransactionId: string | null;
      createTime: string | null;
      status: string | null;
      grossValue: string | null;
      grossCurrency: string | null;
    } | null;
    /** Optional cross-check through the PayPal Agent Toolkit read tool (sandbox adapter only) */
    toolkitCrossCheck: {
      ok: boolean;
      status: string | null;
      agrees: boolean | null;
      note: string;
    } | null;
  };
}

export interface BuyerDisputePayload {
  /** Buyer-perspective transaction reference; synthetic aliases are rejected by the Sandbox adapter */
  buyerTransactionId: string;
  buyerTransactionProvenance: Provenance;
  reason: "CANCELED_RECURRING_BILLING";
  disputeAmountCents: number;
  currency: "USD";
  note: string;
  /** Honest contact history; never defaulted to true */
  merchantContacted: boolean;
  merchantContactedAt: string | null;
  /** Cancellation details required by the reason schema when known */
  cancellation: {
    cancelledAt: string;
    cancellationNumber: string | null;
    cancellationMode:
      "CANCELLED_PAYPAL_BILLING_AGREEMENT" | "CANCELLED_RECURRING_BILLING" | "OTHER" | null;
  };
}

export interface EvidenceAttachment {
  evidenceId: string;
  filename: string;
  mime: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface ProvideEvidencePayload {
  disputeId: string;
  disputeIdProvenance: Provenance;
  evidenceType: string;
  notes: string;
  /** Evidence IDs; bytes are resolved and re-hashed at dispatch time */
  attachmentEvidenceIds: string[];
}

export interface SubscriptionReadback {
  subscriptionId: string;
  status: string | null;
  planId: string | null;
  createTime: string | null;
  statusUpdateTime: string | null;
  nextBillingTime: string | null;
  lastPayment: {
    time: string | null;
    amountValue: string | null;
    amountCurrency: string | null;
  } | null;
  approveUrl: string | null;
}

export interface SubscriptionTransactionReadback {
  id: string;
  status: string | null;
  time: string | null;
  amountValue: string | null;
  amountCurrency: string | null;
}

export interface SetupPreview {
  product: { name: string; description: string; type: string; category: string };
  plan: {
    name: string;
    description: string;
    priceValue: string;
    currency: string;
    intervalUnit: string;
    intervalCount: number;
  };
  subscription: {
    customId: string;
    returnUrl: string;
    cancelUrl: string;
    /**
     * Delayed start: the first billing is requested this many minutes after the subscription
     * request is prepared, so the buyer can approve (and a cancellation can be recorded) before
     * any payment exists. Absent: PayPal bills when the buyer approves.
     */
    startDelayMinutes?: number;
  };
}

/** Per-request options of the subscription stage that are fixed when the request is prepared. */
export interface SubscriptionCreateOptions {
  /** First billing instant requested from the provider (UTC, second precision). */
  startTime?: string | null;
}

/** Result of the last setup stage (subscription creation). */
export interface SetupResult {
  subscriptionId: string;
  approveUrl: string | null;
  status: string | null;
}

export interface DisputeList {
  items: DisputeReadback["summary"][];
  /** The provider's count for the whole query; null when it reports none */
  total: number | null;
  /** True only when this page is known to hold every case of the query */
  complete: boolean;
}

export interface ProviderAdapter {
  readonly kind: Environment;
  readonly label: string;

  getDispute(disputeId: string): Promise<ReadResult<DisputeReadback>>;
  /**
   * One page of cases. `total` is the count the provider reports for the whole query, or null
   * when it reports none; it is never the length of this page. `complete` is true only when this
   * page is known to hold every case of the query.
   */
  listDisputes(params: {
    pageSize?: number;
    disputedTransactionId?: string;
  }): Promise<ReadResult<DisputeList>>;
  getSubscription(subscriptionId: string): Promise<ReadResult<SubscriptionReadback>>;
  listSubscriptionTransactions(
    subscriptionId: string,
    startTime: string,
    endTime: string,
  ): Promise<ReadResult<SubscriptionTransactionReadback[]>>;

  createBuyerDispute(
    payload: BuyerDisputePayload,
    ctx: WriteContext,
  ): Promise<WriteOutcome<{ disputeId: string; status: string | null }>>;
  provideEvidence(
    payload: ProvideEvidencePayload,
    attachments: EvidenceAttachment[],
    ctx: WriteContext,
  ): Promise<WriteOutcome<{ accepted: true; disputeId: string }>>;

  /**
   * Sandbox setup is three separately recorded writes so partial progress survives failures:
   * product, then plan, then subscription. Each call makes exactly one request.
   */
  createCatalogProduct(
    preview: SetupPreview,
    ctx: WriteContext,
  ): Promise<WriteOutcome<{ productId: string }>>;
  createBillingPlan(
    productId: string,
    preview: SetupPreview,
    ctx: WriteContext,
  ): Promise<WriteOutcome<{ planId: string }>>;
  createSubscription(
    planId: string,
    preview: SetupPreview,
    ctx: WriteContext,
    options?: SubscriptionCreateOptions,
  ): Promise<WriteOutcome<SetupResult>>;
  cancelSubscription(
    subscriptionId: string,
    reason: string,
    ctx: WriteContext,
  ): Promise<WriteOutcome<{ subscriptionId: string }>>;
  /**
   * Sandbox test endpoint only: ask the provider to move a case that is under review back to
   * waiting for one party's evidence. It simulates the provider's own decision; it is never a
   * product action and has no Live counterpart.
   */
  requireEvidence(
    disputeId: string,
    party: EvidenceParty,
    ctx: WriteContext,
  ): Promise<WriteOutcome<{ disputeId: string }>>;
  /**
   * Sandbox test endpoint only: ask the provider to settle a case that is under review in one
   * party's favour. It simulates the provider's own decision; it is never a product action and has
   * no Live counterpart.
   */
  adjudicate(
    disputeId: string,
    outcome: AdjudicationOutcome,
    ctx: WriteContext,
  ): Promise<WriteOutcome<{ disputeId: string }>>;
}

/** Whose evidence the Sandbox simulation asks for. */
export type EvidenceParty = "SELLER_EVIDENCE" | "BUYER_EVIDENCE";

/** The decision the Sandbox settlement simulation asks for. */
export type AdjudicationOutcome = "BUYER_FAVOR" | "SELLER_FAVOR";
export const ADJUDICATION_OUTCOMES: readonly AdjudicationOutcome[] = [
  "BUYER_FAVOR",
  "SELLER_FAVOR",
];

export interface WriteContext {
  operationId: string;
  /** Deterministic request id derived from the operation; only sent where the endpoint documents support */
  requestId: string;
  /** Fixture test controls, labelled in the UI as simulation switches */
  simulate?: "timeout" | "unsupported" | null;
}
