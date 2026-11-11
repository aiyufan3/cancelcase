import fs from "node:fs";
import path from "node:path";
import type {
  BuyerDisputePayload,
  DisputeReadback,
  EvidenceAttachment,
  ProvideEvidencePayload,
  ProviderAdapter,
  ReadResult,
  SetupPreview,
  SetupResult,
  SubscriptionReadback,
  SubscriptionTransactionReadback,
  WriteContext,
  WriteOutcome,
} from "./adapter";
import type { ProviderObservation } from "@/domain/types";
import { sha256Hex } from "@/domain/canonical";
import type { Clock } from "@/domain/time";

/**
 * Fixture adapter: a deterministic, local simulation of the provider used in offline demos
 * and tests. Everything it returns is labelled `synthetic`. It never performs network I/O.
 *
 * Simulated state lives in a small JSON file under the fixture data directory so that a
 * "write" whose response was lost can still be discovered by read-back, exactly as the
 * recovery flow expects.
 */

interface SimulatedDispute {
  disputeId: string;
  status: string;
  stage: string;
  reason: string;
  amountValue: string;
  currency: string;
  createTime: string;
  updateTime: string;
  sellerResponseDueAt: string;
  requestedEvidenceTypes: string[];
  evidenceSubmissions: {
    operationId: string;
    evidenceType: string;
    attachmentHashes: string[];
    at: string;
  }[];
  createdByOperationId: string;
}

interface SimulatedState {
  version: 1;
  disputes: Record<string, SimulatedDispute>;
  subscriptions: Record<string, { status: string; planId: string; updatedAt: string }>;
}

const EMPTY_STATE: SimulatedState = { version: 1, disputes: {}, subscriptions: {} };

export class FixtureAdapter implements ProviderAdapter {
  readonly kind = "fixture" as const;
  readonly label = "Fixture simulation (synthetic, no provider call)";

  constructor(
    private readonly stateFile: string | null,
    private readonly clock: Clock,
  ) {}

  private load(): SimulatedState {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return structuredClone(EMPTY_STATE);
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as SimulatedState;
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  private save(state: SimulatedState): void {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }

  /** Test-only: wipe simulated provider state (used by demo:reset and tests). */
  reset(): void {
    if (this.stateFile && fs.existsSync(this.stateFile)) fs.rmSync(this.stateFile);
  }

  private lastObservedMs = 0;

  /** Observation times are strictly increasing per adapter instance, like a real wall clock. */
  private now(): string {
    const ms = Math.max(this.clock.now().getTime(), this.lastObservedMs + 1);
    this.lastObservedMs = ms;
    return new Date(ms).toISOString();
  }

  private toReadback(d: SimulatedDispute, observedAt: string): DisputeReadback {
    const observation: ProviderObservation = {
      disputeId: d.disputeId,
      provenance: "synthetic",
      status: d.status,
      stage: d.stage,
      outcome: null,
      reason: d.reason,
      sellerResponseDueAt: d.sellerResponseDueAt,
      requestedEvidenceTypes: d.requestedEvidenceTypes,
      allowedActions:
        d.status === "WAITING_FOR_SELLER_RESPONSE"
          ? ["provide_evidence", "send_message"]
          : ["send_message"],
      observedVersion: 1,
      observedAt,
      enumsUnderstood: true,
      stale: false,
    };
    return {
      observation,
      summary: {
        disputeId: d.disputeId,
        status: d.status,
        stage: d.stage,
        reason: d.reason,
        amountValue: d.amountValue,
        amountCurrency: d.currency,
        createTime: d.createTime,
        updateTime: d.updateTime,
        sellerResponseDueAt: d.sellerResponseDueAt,
        requestedEvidenceTypes: d.requestedEvidenceTypes,
        rejectedLinks: [],
        messagesCount: 0,
        evidenceCount: d.evidenceSubmissions.length,
        // The simulation does not model the disputed payment record.
        transaction: null,
        toolkitCrossCheck: null,
      },
    };
  }

  async getDispute(disputeId: string): Promise<ReadResult<DisputeReadback>> {
    const state = this.load();
    const d = state.disputes[disputeId];
    if (!d) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `No simulated dispute ${disputeId}.`,
          correlationId: null,
          httpStatus: 404,
        },
        retriable: false,
      };
    }
    const observedAt = this.now();
    return {
      ok: true,
      data: this.toReadback(d, observedAt),
      provenance: "synthetic",
      observedAt,
      correlationId: null,
    };
  }

  async listDisputes(params: { pageSize?: number; disputedTransactionId?: string }) {
    const state = this.load();
    const all = Object.values(state.disputes);
    const items = all
      .slice(0, params.pageSize ?? 10)
      .map((d) => this.toReadback(d, this.now()).summary);
    return {
      ok: true as const,
      data: { items, total: all.length, complete: all.length <= items.length },
      provenance: "synthetic" as const,
      observedAt: this.now(),
      correlationId: null,
    };
  }

  async getSubscription(subscriptionId: string): Promise<ReadResult<SubscriptionReadback>> {
    const state = this.load();
    const sub = state.subscriptions[subscriptionId];
    return {
      ok: true,
      data: {
        subscriptionId,
        status: sub?.status ?? "ACTIVE",
        planId: sub?.planId ?? "FX-PLAN-SYNTHETIC",
        createTime: "2026-10-08T12:00:00Z",
        statusUpdateTime: sub?.updatedAt ?? "2026-10-08T12:00:00Z",
        nextBillingTime: "2026-12-08T12:00:00Z",
        lastPayment: { time: "2026-11-08T12:00:00Z", amountValue: "19.99", amountCurrency: "USD" },
        approveUrl: null,
      },
      provenance: "synthetic",
      observedAt: this.now(),
      correlationId: null,
    };
  }

  async listSubscriptionTransactions(): Promise<ReadResult<SubscriptionTransactionReadback[]>> {
    return {
      ok: true,
      data: [
        {
          id: "FX-SALE-SYNTHETIC-1",
          status: "COMPLETED",
          time: "2026-10-08T12:00:00Z",
          amountValue: "19.99",
          amountCurrency: "USD",
        },
        {
          id: "FX-SALE-SYNTHETIC-2",
          status: "COMPLETED",
          time: "2026-11-08T12:00:00Z",
          amountValue: "19.99",
          amountCurrency: "USD",
        },
      ],
      provenance: "synthetic",
      observedAt: this.now(),
      correlationId: null,
    };
  }

  async createBuyerDispute(
    payload: BuyerDisputePayload,
    ctx: WriteContext,
  ): Promise<WriteOutcome<{ disputeId: string; status: string | null }>> {
    if (ctx.simulate === "unsupported") {
      return {
        kind: "failed",
        error: {
          code: "CAPABILITY_UNAVAILABLE",
          message:
            "Simulated: the buyer dispute-creation capability is not available for this account.",
          correlationId: "fixture-sim-unsupported",
          httpStatus: 403,
        },
      };
    }
    const state = this.load();
    // Idempotent on operation id: the same operation never creates a second simulated dispute.
    const existing = Object.values(state.disputes).find(
      (d) => d.createdByOperationId === ctx.operationId,
    );
    const dispute: SimulatedDispute = existing ?? {
      disputeId: `FX-DISPUTE-${sha256Hex(ctx.operationId).slice(0, 10).toUpperCase()}`,
      status: "WAITING_FOR_SELLER_RESPONSE",
      stage: "INQUIRY",
      reason: payload.reason,
      amountValue: (payload.disputeAmountCents / 100).toFixed(2),
      currency: payload.currency,
      createTime: this.now(),
      updateTime: this.now(),
      sellerResponseDueAt: new Date(
        this.clock.now().getTime() + 10 * 24 * 3600 * 1000,
      ).toISOString(),
      requestedEvidenceTypes: ["CANCELLATION_DETAILS", "PROOF_OF_REFUND"],
      evidenceSubmissions: [],
      createdByOperationId: ctx.operationId,
    };
    state.disputes[dispute.disputeId] = dispute;
    this.save(state);
    if (ctx.simulate === "timeout") {
      // The write "happened" but the response is lost: the caller must treat this as UNKNOWN.
      return {
        kind: "unknown",
        error: {
          code: "NETWORK_TIMEOUT",
          message: "Simulated: the request timed out after the provider may have accepted it.",
          correlationId: "fixture-sim-timeout",
          httpStatus: null,
        },
      };
    }
    return {
      kind: "succeeded",
      result: { disputeId: dispute.disputeId, status: dispute.status },
      provenance: "synthetic",
      correlationId: "fixture-sim-ok",
      providerRequestId: null,
    };
  }

  async provideEvidence(
    payload: ProvideEvidencePayload,
    attachments: EvidenceAttachment[],
    ctx: WriteContext,
  ): Promise<WriteOutcome<{ accepted: true; disputeId: string }>> {
    if (ctx.simulate === "unsupported") {
      return {
        kind: "failed",
        error: {
          code: "ACTION_NOT_ALLOWED",
          message: "Simulated: the case does not currently accept evidence from the seller.",
          correlationId: "fixture-sim-unsupported",
          httpStatus: 422,
        },
      };
    }
    const state = this.load();
    const d = state.disputes[payload.disputeId];
    if (!d) {
      return {
        kind: "failed",
        error: {
          code: "NOT_FOUND",
          message: "Simulated dispute not found.",
          correlationId: null,
          httpStatus: 404,
        },
      };
    }
    if (!d.evidenceSubmissions.some((e) => e.operationId === ctx.operationId)) {
      d.evidenceSubmissions.push({
        operationId: ctx.operationId,
        evidenceType: payload.evidenceType,
        attachmentHashes: attachments.map((a) => a.sha256),
        at: this.now(),
      });
      d.status = "UNDER_REVIEW";
      d.updateTime = this.now();
      this.save(state);
    }
    if (ctx.simulate === "timeout") {
      return {
        kind: "unknown",
        error: {
          code: "NETWORK_TIMEOUT",
          message: "Simulated: the evidence upload timed out; acceptance is unknown.",
          correlationId: "fixture-sim-timeout",
          httpStatus: null,
        },
      };
    }
    return {
      kind: "succeeded",
      result: { accepted: true, disputeId: payload.disputeId },
      provenance: "synthetic",
      correlationId: "fixture-sim-ok",
      providerRequestId: null,
    };
  }

  async createCatalogProduct(
    _preview: SetupPreview,
    ctx: WriteContext,
  ): Promise<WriteOutcome<{ productId: string }>> {
    return {
      kind: "succeeded",
      result: { productId: `FX-PRODUCT-${sha256Hex(ctx.operationId).slice(0, 8).toUpperCase()}` },
      provenance: "synthetic",
      correlationId: null,
      providerRequestId: null,
    };
  }

  async createBillingPlan(
    _productId: string,
    _preview: SetupPreview,
    ctx: WriteContext,
  ): Promise<WriteOutcome<{ planId: string }>> {
    return {
      kind: "succeeded",
      result: { planId: `FX-PLAN-${sha256Hex(ctx.operationId).slice(0, 8).toUpperCase()}` },
      provenance: "synthetic",
      correlationId: null,
      providerRequestId: null,
    };
  }

  async createSubscription(
    planId: string,
    _preview: SetupPreview,
    ctx: WriteContext,
  ): Promise<WriteOutcome<SetupResult>> {
    const state = this.load();
    const id = `FX-SUB-${sha256Hex(ctx.operationId).slice(0, 8).toUpperCase()}`;
    state.subscriptions[id] = { status: "APPROVAL_PENDING", planId, updatedAt: this.now() };
    this.save(state);
    return {
      kind: "succeeded",
      result: { subscriptionId: id, approveUrl: null, status: "APPROVAL_PENDING" },
      provenance: "synthetic",
      correlationId: null,
      providerRequestId: null,
    };
  }

  async cancelSubscription(
    subscriptionId: string,
  ): Promise<WriteOutcome<{ subscriptionId: string }>> {
    const state = this.load();
    const sub = state.subscriptions[subscriptionId] ?? {
      status: "ACTIVE",
      planId: "FX-PLAN",
      updatedAt: this.now(),
    };
    sub.status = "CANCELLED";
    sub.updatedAt = this.now();
    state.subscriptions[subscriptionId] = sub;
    this.save(state);
    return {
      kind: "succeeded",
      result: { subscriptionId },
      provenance: "synthetic",
      correlationId: null,
      providerRequestId: null,
    };
  }

  async requireEvidence(): Promise<WriteOutcome<{ disputeId: string }>> {
    return {
      kind: "failed",
      error: {
        code: "NOT_AVAILABLE_IN_FIXTURE",
        message: "The provider's evidence-request simulation exists in Sandbox mode only.",
        correlationId: null,
        httpStatus: null,
      },
    };
  }

  async adjudicate(): Promise<WriteOutcome<{ disputeId: string }>> {
    return {
      kind: "failed",
      error: {
        code: "NOT_AVAILABLE_IN_FIXTURE",
        message: "The provider's settlement simulation exists in Sandbox mode only.",
        correlationId: null,
        httpStatus: null,
      },
    };
  }
}
