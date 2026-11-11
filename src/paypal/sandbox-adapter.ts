import {
  ADJUDICATION_OUTCOMES,
  type AdjudicationOutcome,
  type BuyerDisputePayload,
  type DisputeList,
  type DisputeReadback,
  type EvidenceAttachment,
  type EvidenceParty,
  type ProvideEvidencePayload,
  type ProviderAdapter,
  type ReadResult,
  type SafeError,
  type SetupPreview,
  type SetupResult,
  type SubscriptionCreateOptions,
  type SubscriptionReadback,
  type SubscriptionTransactionReadback,
  type WriteContext,
  type WriteOutcome,
} from "./adapter";
import { buildBuyerAuthAssertion, type PayPalRestClient, type RestResult } from "./rest-client";
import type { ProviderObservation } from "@/domain/types";
import {
  allowedActionsFromLinks,
  enumsUnderstood,
  type HateoasLink,
} from "@/domain/provider-state";
import { centsToDecimalString } from "@/domain/money";
import type { Clock } from "@/domain/time";
import type { ToolkitHandle } from "./toolkit";

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};

function failed<T>(
  r: Extract<RestResult<unknown>, { ok: false }>,
): Extract<ReadResult<T>, { ok: false }> {
  return { ok: false, error: r.error, retriable: r.retriable };
}

function writeFailure<T>(r: Extract<RestResult<unknown>, { ok: false }>): WriteOutcome<T> {
  return r.ambiguous ? { kind: "unknown", error: r.error } : { kind: "failed", error: r.error };
}

/**
 * Sandbox adapter: direct REST against the configured PayPal Sandbox origin.
 * Every read result carries provenance `sandbox_api`; every write happens at most once per
 * call, with ambiguity reported rather than retried.
 */
export class SandboxAdapter implements ProviderAdapter {
  readonly kind = "sandbox" as const;
  readonly label: string;

  constructor(
    private readonly client: PayPalRestClient,
    private readonly clock: Clock,
    private readonly options: {
      clientId: string;
      buyerEmail: string | null;
      buyerDisputesEnabled: boolean;
    },
    /** Read-only toolkit handle used to cross-check dispute reads; never used for writes. */
    private readonly toolkit: ToolkitHandle | null = null,
  ) {
    this.label = `PayPal Sandbox (${client.origin})`;
  }

  /** Cross-check a dispute read through the Agent Toolkit's get_dispute read tool. */
  private async toolkitCrossCheck(disputeId: string, restStatus: string | null) {
    if (!this.toolkit) return null;
    try {
      const raw = await this.toolkit.invoke("get_dispute", { dispute_id: disputeId });
      let status: string | null = null;
      try {
        const parsed = JSON.parse(raw) as { status?: unknown };
        status = typeof parsed.status === "string" ? parsed.status : null;
      } catch {
        status = null;
      }
      return {
        ok: true,
        status,
        agrees: status === null ? null : status === restStatus,
        note:
          status === null
            ? "toolkit returned no parseable status"
            : status === restStatus
              ? "toolkit and REST agree"
              : "toolkit and REST differ; refresh before acting",
      };
    } catch {
      return {
        ok: false,
        status: null,
        agrees: null,
        note: "Toolkit cross-check failed; the direct REST observation is retained.",
      };
    }
  }

  get origin(): string {
    return this.client.origin;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  mapDispute(raw: Json, observedAt: string): DisputeReadback {
    const disputeId = str(raw.dispute_id) ?? "";
    const links = arr(raw.links)
      .map(obj)
      .map((l): HateoasLink => ({
        rel: str(l.rel) ?? "",
        href: str(l.href) ?? "",
        method: str(l.method) ?? undefined,
      }));
    const { actions, rejected } = allowedActionsFromLinks(links, [this.client.origin], disputeId);
    const evidences = arr(raw.evidences).map(obj);
    const requested = evidences
      .filter((e) => str(e.source) === "REQUESTED_FROM_SELLER")
      .map((e) => str(e.evidence_type))
      .filter((v): v is string => v !== null);
    const status = str(raw.status);
    const stage = str(raw.dispute_life_cycle_stage);
    const amount = obj(raw.dispute_amount);
    const outcome = obj(raw.dispute_outcome);
    const txRaw = arr(raw.disputed_transactions).map(obj)[0] ?? null;
    const gross = txRaw ? obj(txRaw.gross_amount) : {};
    const observation: ProviderObservation = {
      disputeId,
      provenance: "sandbox_api",
      status,
      stage,
      outcome: str(outcome.outcome_code),
      reason: str(raw.reason),
      sellerResponseDueAt: str(raw.seller_response_due_date),
      requestedEvidenceTypes: requested,
      allowedActions: actions,
      observedVersion: 1,
      observedAt,
      enumsUnderstood: enumsUnderstood(status, stage),
      stale: false,
    };
    return {
      observation,
      summary: {
        disputeId,
        status,
        stage,
        reason: str(raw.reason),
        amountValue: str(amount.value),
        amountCurrency: str(amount.currency_code),
        createTime: str(raw.create_time),
        updateTime: str(raw.update_time),
        sellerResponseDueAt: str(raw.seller_response_due_date),
        requestedEvidenceTypes: requested,
        rejectedLinks: rejected,
        messagesCount: arr(raw.messages).length,
        evidenceCount: evidences.length,
        transaction: txRaw
          ? {
              sellerTransactionId: str(txRaw.seller_transaction_id),
              buyerTransactionId: str(txRaw.buyer_transaction_id),
              createTime: str(txRaw.create_time),
              status: str(txRaw.transaction_status),
              grossValue: str(gross.value),
              grossCurrency: str(gross.currency_code),
            }
          : null,
        toolkitCrossCheck: null,
      },
    };
  }

  async getDispute(disputeId: string): Promise<ReadResult<DisputeReadback>> {
    if (!/^[A-Za-z0-9-]+$/.test(disputeId)) {
      return {
        ok: false,
        error: {
          code: "INVALID_ID",
          message: "Dispute ID has an unexpected shape.",
          correlationId: null,
          httpStatus: null,
        },
        retriable: false,
      };
    }
    const r = await this.client.read<Json>(
      `/v1/customer/disputes/${encodeURIComponent(disputeId)}`,
    );
    if (!r.ok) return failed(r);
    const observedAt = this.now();
    const data = this.mapDispute(r.data, observedAt);
    data.summary.toolkitCrossCheck = await this.toolkitCrossCheck(
      disputeId,
      data.observation.status,
    );
    return { ok: true, data, provenance: "sandbox_api", observedAt, correlationId: r.debugId };
  }

  async listDisputes(params: { pageSize?: number; disputedTransactionId?: string }) {
    const search = new URLSearchParams();
    search.set("page_size", String(Math.min(50, Math.max(1, params.pageSize ?? 10))));
    if (params.disputedTransactionId)
      search.set("disputed_transaction_id", params.disputedTransactionId);
    const r = await this.client.read<Json>(`/v1/customer/disputes?${search.toString()}`);
    if (!r.ok) return failed<DisputeList>(r);
    const observedAt = this.now();
    const items = arr(r.data.items)
      .map(obj)
      .map((raw) => this.mapDispute(raw, observedAt).summary);
    // The page is not the query: PayPal reports the whole count as total_items and links a next
    // page when there is one. Without either signal, completeness is not known.
    const total =
      typeof r.data.total_items === "number" && Number.isInteger(r.data.total_items)
        ? r.data.total_items
        : null;
    const hasNext = arr(r.data.links)
      .map(obj)
      .some((l) => str(l.rel) === "next");
    return {
      ok: true as const,
      data: { items, total, complete: !hasNext && total !== null && total <= items.length },
      provenance: "sandbox_api" as const,
      observedAt,
      correlationId: r.debugId,
    };
  }

  async getSubscription(subscriptionId: string): Promise<ReadResult<SubscriptionReadback>> {
    const r = await this.client.read<Json>(
      `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
    if (!r.ok) return failed(r);
    const billing = obj(r.data.billing_info);
    const last = obj(billing.last_payment);
    const lastAmount = obj(last.amount);
    const approve = arr(r.data.links)
      .map(obj)
      .find((l) => str(l.rel) === "approve");
    return {
      ok: true,
      data: {
        subscriptionId: str(r.data.id) ?? subscriptionId,
        status: str(r.data.status),
        planId: str(r.data.plan_id),
        createTime: str(r.data.create_time),
        statusUpdateTime: str(r.data.status_update_time),
        nextBillingTime: str(billing.next_billing_time),
        lastPayment: last.time
          ? {
              time: str(last.time),
              amountValue: str(lastAmount.value),
              amountCurrency: str(lastAmount.currency_code),
            }
          : null,
        approveUrl: approve ? str(approve.href) : null,
      },
      provenance: "sandbox_api",
      observedAt: this.now(),
      correlationId: r.debugId,
    };
  }

  async listSubscriptionTransactions(
    subscriptionId: string,
    startTime: string,
    endTime: string,
  ): Promise<ReadResult<SubscriptionTransactionReadback[]>> {
    const search = new URLSearchParams({ start_time: startTime, end_time: endTime });
    const r = await this.client.read<Json>(
      `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/transactions?${search}`,
    );
    if (!r.ok) return failed(r);
    const items = arr(r.data.transactions)
      .map(obj)
      .map((t) => {
        const gross = obj(obj(t.amount_with_breakdown).gross_amount);
        return {
          id: str(t.id) ?? "",
          status: str(t.status),
          time: str(t.time),
          amountValue: str(gross.value),
          amountCurrency: str(gross.currency_code),
        };
      });
    return {
      ok: true,
      data: items,
      provenance: "sandbox_api",
      observedAt: this.now(),
      correlationId: r.debugId,
    };
  }

  /** Builds the documented create-dispute body for CANCELED_RECURRING_BILLING. */
  buildBuyerDisputeInput(payload: BuyerDisputePayload): Json {
    const amount = {
      currency_code: payload.currency,
      value: centsToDecimalString(payload.disputeAmountCents),
    };
    const extensions: Json = {
      merchant_contacted: payload.merchantContacted,
      billing_dispute_properties: {
        canceled_recurring_billing: {
          expected_refund: amount,
          cancellation_details: {
            cancellation_date: providerDateTime(payload.cancellation.cancelledAt),
            ...(payload.cancellation.cancellationNumber
              ? { cancellation_number: payload.cancellation.cancellationNumber }
              : {}),
            cancelled: true,
            ...(payload.cancellation.cancellationMode
              ? { cancellation_mode: payload.cancellation.cancellationMode }
              : {}),
          },
        },
      },
    };
    if (payload.merchantContacted && payload.merchantContactedAt)
      extensions.merchant_contacted_time = payload.merchantContactedAt;
    return {
      disputed_transactions: [{ buyer_transaction_id: payload.buyerTransactionId }],
      reason: payload.reason,
      dispute_amount: amount,
      extensions,
      ...(payload.note ? { evidences: [{ evidence_type: "OTHER", notes: payload.note }] } : {}),
    };
  }

  async createBuyerDispute(
    payload: BuyerDisputePayload,
    _ctx: WriteContext,
  ): Promise<WriteOutcome<{ disputeId: string; status: string | null }>> {
    if (
      !isAcceptableBuyerReference(payload.buyerTransactionId, payload.buyerTransactionProvenance)
    ) {
      return {
        kind: "failed",
        error: {
          code: "SYNTHETIC_REFERENCE_REJECTED",
          message:
            "The buyer transaction reference must be a provider observation or an operator-recorded PayPal transaction ID; synthetic aliases are never sent.",
          correlationId: null,
          httpStatus: null,
        },
      };
    }
    if (!this.options.buyerDisputesEnabled || !this.options.buyerEmail) {
      return {
        kind: "failed",
        error: {
          code: "BUYER_PATH_NOT_CONFIGURED",
          message:
            "Buyer dispute creation is disabled: PAYPAL_ENABLE_BUYER_DISPUTES must be true and PAYPAL_BUYER_EMAIL set locally after scope and consent are in place.",
          correlationId: null,
          httpStatus: null,
        },
      };
    }
    const form = new FormData();
    form.append(
      "input",
      new Blob([JSON.stringify(this.buildBuyerDisputeInput(payload))], {
        type: "application/json",
      }),
      "input.json",
    );
    const assertion = buildBuyerAuthAssertion(this.options.clientId, this.options.buyerEmail);
    const r = await this.client.write<Json>("POST", "/v1/customer/disputes", {
      form,
      authAssertion: assertion,
    });
    if (!r.ok) return writeFailure(r);
    const self = arr(r.data.links)
      .map(obj)
      .find((l) => str(l.rel) === "self");
    const href = self ? str(self.href) : null;
    const disputeId = str(r.data.dispute_id) ?? (href ? (href.split("/").pop() ?? null) : null);
    if (!disputeId) {
      return {
        kind: "unknown",
        error: {
          code: "NO_DISPUTE_ID",
          message:
            "The provider accepted the request but returned no dispute reference; verify by read-back.",
          correlationId: r.debugId,
          httpStatus: r.status,
        },
      };
    }
    return {
      kind: "succeeded",
      result: { disputeId, status: str(r.data.status) },
      provenance: "sandbox_api",
      correlationId: r.debugId,
      providerRequestId: null,
    };
  }

  async provideEvidence(
    payload: ProvideEvidencePayload,
    attachments: EvidenceAttachment[],
    _ctx: WriteContext,
  ): Promise<WriteOutcome<{ accepted: true; disputeId: string }>> {
    if (payload.disputeIdProvenance !== "sandbox_api") {
      return {
        kind: "failed",
        error: {
          code: "SYNTHETIC_REFERENCE_REJECTED",
          message: "A synthetic dispute reference cannot be sent to the provider.",
          correlationId: null,
          httpStatus: null,
        },
      };
    }
    // The operation service owns the authoritative provider preflight and exact-content check.
    // Do not add an asynchronous read here after that final approval verification.
    const form = new FormData();
    const input = {
      evidences: [
        {
          evidence_type: payload.evidenceType,
          notes: payload.notes,
          ...(attachments.length > 0
            ? { documents: attachments.map((a) => ({ name: a.filename })) }
            : {}),
        },
      ],
    };
    form.append(
      "input",
      new Blob([JSON.stringify(input)], { type: "application/json" }),
      "input.json",
    );
    attachments.forEach((a, i) => {
      form.append(`file${i + 1}`, new Blob([a.bytes as BlobPart], { type: a.mime }), a.filename);
    });
    const r = await this.client.write<Json>(
      "POST",
      `/v1/customer/disputes/${encodeURIComponent(payload.disputeId)}/provide-evidence`,
      { form },
    );
    if (!r.ok) return writeFailure(r);
    return {
      kind: "succeeded",
      result: { accepted: true, disputeId: payload.disputeId },
      provenance: "sandbox_api",
      correlationId: r.debugId,
      providerRequestId: null,
    };
  }

  async createCatalogProduct(
    preview: SetupPreview,
    ctx: WriteContext,
  ): Promise<WriteOutcome<{ productId: string }>> {
    const product = await this.client.write<Json>("POST", "/v1/catalogs/products", {
      json: {
        name: preview.product.name,
        description: preview.product.description,
        type: preview.product.type,
        category: preview.product.category,
      },
      requestId: ctx.requestId,
    });
    if (!product.ok) return writeFailure(product);
    const productId = str(product.data.id);
    if (!productId)
      return {
        kind: "unknown",
        error: {
          code: "NO_PRODUCT_ID",
          message: "Product creation returned no id.",
          correlationId: product.debugId,
          httpStatus: product.status,
        },
      };
    return {
      kind: "succeeded",
      result: { productId },
      provenance: "sandbox_api",
      correlationId: product.debugId,
      providerRequestId: ctx.requestId,
    };
  }

  async createBillingPlan(
    productId: string,
    preview: SetupPreview,
    ctx: WriteContext,
  ): Promise<WriteOutcome<{ planId: string }>> {
    const plan = await this.client.write<Json>("POST", "/v1/billing/plans", {
      json: {
        product_id: productId,
        name: preview.plan.name,
        description: preview.plan.description,
        status: "ACTIVE",
        billing_cycles: [
          {
            frequency: {
              interval_unit: preview.plan.intervalUnit,
              interval_count: preview.plan.intervalCount,
            },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: { value: preview.plan.priceValue, currency_code: preview.plan.currency },
            },
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          setup_fee_failure_action: "CONTINUE",
          payment_failure_threshold: 1,
        },
      },
      requestId: ctx.requestId,
    });
    if (!plan.ok) return writeFailure(plan);
    const planId = str(plan.data.id);
    if (!planId)
      return {
        kind: "unknown",
        error: {
          code: "NO_PLAN_ID",
          message: "Plan creation returned no id.",
          correlationId: plan.debugId,
          httpStatus: plan.status,
        },
      };
    return {
      kind: "succeeded",
      result: { planId },
      provenance: "sandbox_api",
      correlationId: plan.debugId,
      providerRequestId: ctx.requestId,
    };
  }

  async createSubscription(
    planId: string,
    preview: SetupPreview,
    ctx: WriteContext,
    options?: SubscriptionCreateOptions,
  ): Promise<WriteOutcome<SetupResult>> {
    const sub = await this.client.write<Json>("POST", "/v1/billing/subscriptions", {
      json: {
        plan_id: planId,
        custom_id: preview.subscription.customId,
        // Only a delayed-start intent sends a start time; otherwise PayPal bills at approval.
        ...(options?.startTime ? { start_time: options.startTime } : {}),
        application_context: {
          brand_name: preview.product.name,
          user_action: "SUBSCRIBE_NOW",
          return_url: preview.subscription.returnUrl,
          cancel_url: preview.subscription.cancelUrl,
        },
      },
      requestId: ctx.requestId,
    });
    if (!sub.ok) return writeFailure(sub);
    const subscriptionId = str(sub.data.id);
    if (!subscriptionId)
      return {
        kind: "unknown",
        error: {
          code: "NO_SUBSCRIPTION_ID",
          message: "Subscription creation returned no id.",
          correlationId: sub.debugId,
          httpStatus: sub.status,
        },
      };
    const approve = arr(sub.data.links)
      .map(obj)
      .find((l) => str(l.rel) === "approve");
    return {
      kind: "succeeded",
      result: {
        subscriptionId,
        approveUrl: approve ? str(approve.href) : null,
        status: str(sub.data.status),
      },
      provenance: "sandbox_api",
      correlationId: sub.debugId,
      providerRequestId: ctx.requestId,
    };
  }

  async cancelSubscription(
    subscriptionId: string,
    reason: string,
    _ctx: WriteContext,
  ): Promise<WriteOutcome<{ subscriptionId: string }>> {
    const r = await this.client.write<Json>(
      "POST",
      `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      { json: { reason } },
    );
    if (!r.ok) return writeFailure(r);
    return {
      kind: "succeeded",
      result: { subscriptionId },
      provenance: "sandbox_api",
      correlationId: r.debugId,
      providerRequestId: null,
    };
  }

  async requireEvidence(
    disputeId: string,
    party: EvidenceParty,
    _ctx: WriteContext,
  ): Promise<WriteOutcome<{ disputeId: string }>> {
    if (!isProviderDisputeId(disputeId)) {
      return {
        kind: "failed",
        error: {
          code: "SYNTHETIC_REFERENCE_REJECTED",
          message: "A synthetic dispute reference cannot be sent to the provider.",
          correlationId: null,
          httpStatus: null,
        },
      };
    }
    const r = await this.client.write<Json>(
      "POST",
      `/v1/customer/disputes/${encodeURIComponent(disputeId)}/require-evidence`,
      { json: { action: party } },
    );
    if (!r.ok) return writeFailure(r);
    return {
      kind: "succeeded",
      result: { disputeId },
      provenance: "sandbox_api",
      correlationId: r.debugId,
      providerRequestId: null,
    };
  }

  async adjudicate(
    disputeId: string,
    outcome: AdjudicationOutcome,
    _ctx: WriteContext,
  ): Promise<WriteOutcome<{ disputeId: string }>> {
    if (!isProviderDisputeId(disputeId)) {
      return {
        kind: "failed",
        error: {
          code: "SYNTHETIC_REFERENCE_REJECTED",
          message: "A synthetic dispute reference cannot be sent to the provider.",
          correlationId: null,
          httpStatus: null,
        },
      };
    }
    if (!ADJUDICATION_OUTCOMES.includes(outcome)) {
      return {
        kind: "failed",
        error: {
          code: "INVALID_OUTCOME",
          message: "The settlement simulation takes BUYER_FAVOR or SELLER_FAVOR.",
          correlationId: null,
          httpStatus: null,
        },
      };
    }
    const r = await this.client.write<Json>(
      "POST",
      `/v1/customer/disputes/${encodeURIComponent(disputeId)}/adjudicate`,
      { json: { adjudication_outcome: outcome } },
    );
    if (!r.ok) return writeFailure(r);
    return {
      kind: "succeeded",
      result: { disputeId },
      provenance: "sandbox_api",
      correlationId: r.debugId,
      providerRequestId: null,
    };
  }
}

/** A real provider case reference: never a fixture alias, and only characters PayPal uses. */
/**
 * A recorded instant in the form the provider itself returns: UTC with milliseconds. The same
 * moment, written one way whatever offset or precision it was recorded with. A value that is not
 * a readable time is passed on unchanged, so the provider's own validation reports it.
 */
export function providerDateTime(value: string): string {
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : value;
}

function isProviderDisputeId(value: string): boolean {
  return /^[A-Za-z0-9-]{6,64}$/.test(value) && !value.startsWith("FX-");
}

/**
 * A buyer transaction reference may be sent when it was observed through the API, or when the
 * operator recorded a real PayPal transaction ID (17 upper-case alphanumerics) from the Sandbox
 * buyer account. Synthetic aliases and other attestations are refused.
 */
export function isAcceptableBuyerReference(value: string, provenance: string): boolean {
  if (!value || value.startsWith("FX-")) return false;
  if (provenance === "sandbox_api") return true;
  return provenance === "user_attestation" && /^[A-Z0-9]{17}$/.test(value);
}

export type { SafeError };
