import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppContext, type AppContext } from "@/server/context";
import { loadAppConfig } from "@/server/config";
import { FixtureDrafter } from "@/llm/fixture-drafter";
import type {
  AdjudicationOutcome,
  BuyerDisputePayload,
  DisputeReadback,
  ProviderAdapter,
  ReadResult,
  SetupPreview,
  SetupResult,
  SubscriptionCreateOptions,
  SubscriptionReadback,
  SubscriptionTransactionReadback,
  WriteContext,
  WriteOutcome,
} from "@/paypal/adapter";
import type { ProviderObservation } from "@/domain/types";
import { mutableClock, type TestHarness } from "./context";

/**
 * A scripted stand-in for the connected (Sandbox-mode) adapter. Every identifier and amount is
 * fictional; nothing here talks to a network. Tests script outcomes per write and count calls,
 * so "no duplicate resource" is asserted on the number of create requests actually made.
 */
export type Scripted = "ok" | "fail" | "unknown" | "throw" | "hang";

export class ScriptedProvider implements ProviderAdapter {
  readonly kind = "sandbox" as const;
  readonly label = "Scripted connected provider (test double)";
  calls = { product: 0, plan: 0, subscription: 0, dispute: 0 };
  script: { product: Scripted[]; plan: Scripted[]; subscription: Scripted[]; dispute: Scripted[] } =
    { product: [], plan: [], subscription: [], dispute: [] };
  /** The Sandbox evidence-request simulation is counted and scripted on its own. */
  simulation: { calls: number; script: Scripted[]; afterSuccess: (() => void) | null } = {
    calls: 0,
    script: [],
    afterSuccess: null,
  };
  /** The Sandbox settlement simulation, counted and scripted on its own. */
  adjudication: {
    calls: number;
    script: Scripted[];
    outcomes: AdjudicationOutcome[];
    afterSuccess: (() => void) | null;
  } = { calls: 0, script: [], outcomes: [], afterSuccess: null };
  seen: { customIds: string[]; requestIds: string[]; startTimes: (string | null)[] } = {
    customIds: [],
    requestIds: [],
    startTimes: [],
  };
  subscriptionStatus = "APPROVAL_PENDING";
  lastPayment: SubscriptionReadback["lastPayment"] = null;
  nextBillingTime: string | null = null;
  transactions: SubscriptionTransactionReadback[] = [];
  transactionReadFails = false;
  disputeReadFails = 0;
  disputes: Record<
    string,
    {
      status: string;
      transaction: DisputeReadback["summary"]["transaction"];
      /** Capabilities the scripted read reports; defaults to messaging only. */
      allowedActions?: ProviderObservation["allowedActions"];
      /** The outcome code a resolved case reports. */
      outcome?: string | null;
    }
  > = {};

  constructor(private readonly now: () => string) {}

  private next<T>(kind: keyof ScriptedProvider["calls"], ok: () => T): Promise<WriteOutcome<T>> {
    this.calls[kind] += 1;
    const step = this.script[kind].shift() ?? "ok";
    if (step === "hang") return new Promise(() => {});
    if (step === "throw") return Promise.reject(new Error("socket closed after write"));
    if (step === "fail")
      return Promise.resolve({
        kind: "failed",
        error: {
          code: "UNPROCESSABLE_ENTITY",
          message: "Rejected.",
          correlationId: "dbg-x",
          httpStatus: 422,
        },
      });
    if (step === "unknown")
      return Promise.resolve({
        kind: "unknown",
        error: { code: "TIMEOUT", message: "No response.", correlationId: null, httpStatus: null },
      });
    return Promise.resolve({
      kind: "succeeded",
      result: ok(),
      provenance: "sandbox_api",
      correlationId: "dbg-ok",
      providerRequestId: null,
    });
  }

  async createCatalogProduct(_p: SetupPreview, ctx: WriteContext) {
    this.seen.requestIds.push(ctx.requestId);
    return this.next("product", () => ({ productId: `PROD-SYN-${this.calls.product}` }));
  }

  async createBillingPlan(_productId: string, _p: SetupPreview, ctx: WriteContext) {
    this.seen.requestIds.push(ctx.requestId);
    return this.next("plan", () => ({ planId: `P-SYN-${this.calls.plan}` }));
  }

  async createSubscription(
    _planId: string,
    preview: SetupPreview,
    ctx: WriteContext,
    options?: SubscriptionCreateOptions,
  ): Promise<WriteOutcome<SetupResult>> {
    this.seen.requestIds.push(ctx.requestId);
    this.seen.customIds.push(preview.subscription.customId);
    this.seen.startTimes.push(options?.startTime ?? null);
    return this.next("subscription", () => ({
      subscriptionId: `I-SYN${this.calls.subscription}`,
      approveUrl: "https://approve.example.invalid/checkout",
      status: "APPROVAL_PENDING",
    }));
  }

  async cancelSubscription(
    subscriptionId: string,
  ): Promise<WriteOutcome<{ subscriptionId: string }>> {
    return {
      kind: "succeeded",
      result: { subscriptionId },
      provenance: "sandbox_api",
      correlationId: null,
      providerRequestId: null,
    };
  }

  /** The Sandbox simulation: a succeeded request moves the case to waiting for the seller. */
  async requireEvidence(disputeId: string): Promise<WriteOutcome<{ disputeId: string }>> {
    this.simulation.calls += 1;
    const step = this.simulation.script.shift() ?? "ok";
    if (step === "throw") throw new Error("socket closed after write");
    if (step === "fail")
      return {
        kind: "failed",
        error: {
          code: "UNPROCESSABLE_ENTITY",
          message: "Rejected.",
          correlationId: "dbg-x",
          httpStatus: 422,
        },
      };
    if (step !== "ok")
      return {
        kind: "unknown",
        error: { code: "TIMEOUT", message: "No response.", correlationId: null, httpStatus: null },
      };
    if (this.disputes[disputeId])
      this.disputes[disputeId] = {
        ...this.disputes[disputeId]!,
        status: "WAITING_FOR_SELLER_RESPONSE",
        allowedActions: ["provide_evidence", "send_message", "accept_claim"],
      };
    this.simulation.afterSuccess?.();
    return {
      kind: "succeeded",
      result: { disputeId },
      provenance: "sandbox_api",
      correlationId: "dbg-ok",
      providerRequestId: null,
    };
  }

  /** The Sandbox settlement simulation: a succeeded request resolves the case. */
  async adjudicate(
    disputeId: string,
    outcome: AdjudicationOutcome,
  ): Promise<WriteOutcome<{ disputeId: string }>> {
    this.adjudication.calls += 1;
    this.adjudication.outcomes.push(outcome);
    const step = this.adjudication.script.shift() ?? "ok";
    if (step === "throw") throw new Error("socket closed after write");
    if (step === "fail")
      return {
        kind: "failed",
        error: {
          code: "UNPROCESSABLE_ENTITY",
          message: "Rejected.",
          correlationId: "dbg-x",
          httpStatus: 422,
        },
      };
    if (step !== "ok")
      return {
        kind: "unknown",
        error: { code: "TIMEOUT", message: "No response.", correlationId: null, httpStatus: null },
      };
    if (this.disputes[disputeId])
      this.disputes[disputeId] = {
        ...this.disputes[disputeId]!,
        status: "RESOLVED",
        outcome: outcome === "BUYER_FAVOR" ? "RESOLVED_BUYER_FAVOUR" : "RESOLVED_SELLER_FAVOUR",
        allowedActions: [],
      };
    this.adjudication.afterSuccess?.();
    return {
      kind: "succeeded",
      result: { disputeId },
      provenance: "sandbox_api",
      correlationId: "dbg-adj",
      providerRequestId: null,
    };
  }

  /** Subscriptions PayPal no longer returns (an unapproved subscription is dropped after hours). */
  missingSubscriptions = new Set<string>();

  async getSubscription(subscriptionId: string): Promise<ReadResult<SubscriptionReadback>> {
    if (this.missingSubscriptions.has(subscriptionId))
      return {
        ok: false,
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "The specified resource does not exist.",
          correlationId: null,
          httpStatus: 404,
        },
        retriable: false,
      };
    return {
      ok: true,
      data: {
        subscriptionId,
        status: this.subscriptionStatus,
        planId: "P-SYN-1",
        createTime: "2026-10-01T10:00:00Z",
        statusUpdateTime: "2026-10-01T10:05:00Z",
        nextBillingTime: this.nextBillingTime,
        lastPayment: this.lastPayment,
        approveUrl: null,
      },
      provenance: "sandbox_api",
      observedAt: this.now(),
      correlationId: null,
    };
  }

  async listSubscriptionTransactions(): Promise<ReadResult<SubscriptionTransactionReadback[]>> {
    if (this.transactionReadFails)
      return {
        ok: false,
        error: { code: "HTTP_503", message: "Unavailable.", correlationId: null, httpStatus: 503 },
        retriable: true,
      };
    return {
      ok: true,
      data: this.transactions.map((t) => ({ ...t })),
      provenance: "sandbox_api",
      observedAt: this.now(),
      correlationId: null,
    };
  }

  async createBuyerDispute(
    _payload: BuyerDisputePayload,
  ): Promise<WriteOutcome<{ disputeId: string; status: string | null }>> {
    const out = await this.next("dispute", () => ({
      disputeId: `PP-D-SYN-${this.calls.dispute}`,
      status: "OPEN",
    }));
    if (out.kind === "succeeded")
      this.disputes[out.result.disputeId] = {
        status: "WAITING_FOR_SELLER_RESPONSE",
        transaction: null,
      };
    return out;
  }

  async provideEvidence(): Promise<WriteOutcome<{ accepted: true; disputeId: string }>> {
    return {
      kind: "failed",
      error: {
        code: "NOT_SCRIPTED",
        message: "Not used here.",
        correlationId: null,
        httpStatus: null,
      },
    };
  }

  async getDispute(disputeId: string): Promise<ReadResult<DisputeReadback>> {
    if (this.disputeReadFails > 0) {
      this.disputeReadFails -= 1;
      return {
        ok: false,
        error: { code: "HTTP_500", message: "Read failed.", correlationId: null, httpStatus: 500 },
        retriable: true,
      };
    }
    const d = this.disputes[disputeId];
    if (!d)
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "No such case.",
          correlationId: null,
          httpStatus: 404,
        },
        retriable: false,
      };
    const observedAt = this.now();
    const observation: ProviderObservation = {
      disputeId,
      provenance: "sandbox_api",
      status: d.status,
      stage: "INQUIRY",
      outcome: d.outcome ?? null,
      reason: "CANCELED_RECURRING_BILLING",
      sellerResponseDueAt: null,
      requestedEvidenceTypes: [],
      allowedActions: d.allowedActions ?? ["send_message"],
      observedVersion: 1,
      observedAt,
      enumsUnderstood: true,
      stale: false,
    };
    return {
      ok: true,
      data: {
        observation,
        summary: {
          disputeId,
          status: d.status,
          stage: "INQUIRY",
          reason: "CANCELED_RECURRING_BILLING",
          amountValue: "19.99",
          amountCurrency: "USD",
          createTime: "2026-11-08T08:00:00Z",
          updateTime: "2026-11-08T08:00:00Z",
          sellerResponseDueAt: null,
          requestedEvidenceTypes: [],
          rejectedLinks: [],
          messagesCount: 0,
          evidenceCount: 0,
          transaction: d.transaction,
          toolkitCrossCheck: null,
        },
      },
      provenance: "sandbox_api",
      observedAt,
      correlationId: null,
    };
  }

  async listDisputes() {
    return {
      ok: true as const,
      data: { items: [], total: 0, complete: true },
      provenance: "sandbox_api" as const,
      observedAt: this.now(),
      correlationId: null,
    };
  }
}

export interface SandboxHarness {
  ctx: AppContext;
  provider: ScriptedProvider;
  clock: TestHarness["clock"];
  dataDir: string;
  /** Open a second context on the same data directory (a restarted process). */
  reopen(provider?: ScriptedProvider): AppContext;
  cleanup(): void;
}

export function createSandboxHarness(clockIso = "2026-11-09T09:00:00Z"): SandboxHarness {
  const clock = mutableClock(clockIso);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cancelcase-sbx-test-"));
  const config = loadAppConfig({
    APP_MODE: "sandbox",
    DATA_DIR: dataDir,
    APP_ORIGIN: "http://127.0.0.1:3999",
    DEMO_RECORDING_MODE: "true",
  } as unknown as NodeJS.ProcessEnv);
  const provider = new ScriptedProvider(() => clock.now().toISOString());
  const contexts: AppContext[] = [];
  const open = (p: ScriptedProvider) => {
    const ctx = createAppContext({ config, clock, adapter: p, drafter: new FixtureDrafter() });
    contexts.push(ctx);
    return ctx;
  };
  const ctx = open(provider);
  return {
    ctx,
    provider,
    clock,
    dataDir,
    reopen: (p = provider) => open(p),
    cleanup() {
      for (const c of contexts) {
        try {
          c.db.close();
        } catch {
          /* ignore */
        }
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
