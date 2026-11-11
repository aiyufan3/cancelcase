import { PayPalAgentToolkit } from "@paypal/agent-toolkit/langchain";
import { switchOffAutomaticTracing } from "@/server/tracing";

/**
 * Default-deny configuration for @paypal/agent-toolkit.
 *
 * Only read tools are enabled. The toolkit's `disputes.create` key enables
 * `accept_dispute_claim` (a mutation that closes a case in the buyer's favor), and
 * `payments.createRefund` enables `create_refund`; both stay off permanently, together with
 * every invoicing, order, shipment, cancel/update and insights tool. The expected tool names
 * below are asserted at startup and in tests against the installed package.
 */
export const TOOLKIT_READ_ACTIONS = {
  disputes: { list: true, get: true },
  transactions: { list: true },
  subscriptions: { show: true },
  subscriptionPlans: { list: true, show: true },
  products: { list: true, show: true },
} as const;

export const EXPECTED_READ_TOOL_NAMES = [
  "list_disputes",
  "get_dispute",
  "list_transactions",
  "show_subscription_details",
  "list_subscription_plans",
  "show_subscription_plan_details",
  "list_products",
  "show_product_details",
] as const;

export const FORBIDDEN_TOOL_NAMES = [
  "accept_dispute_claim",
  "create_refund",
  "cancel_subscription",
  "create_subscription",
  "update_subscription",
  "create_subscription_plan",
  "update_plan",
  "create_product",
  "update_product",
  "create_order",
  "pay_order",
  "create_invoice",
  "send_invoice",
  "send_invoice_reminder",
  "record_payment_for_invoice",
  "record_refund_for_invoice",
  "create_shipment_tracking",
  "get_merchant_insights",
] as const;

export interface ToolkitHandle {
  toolNames: string[];
  invoke(
    name: (typeof EXPECTED_READ_TOOL_NAMES)[number],
    args: Record<string, unknown>,
  ): Promise<string>;
}

export class ToolkitAllowlistError extends Error {
  constructor(
    message: string,
    readonly actual: string[],
  ) {
    super(message);
    this.name = "ToolkitAllowlistError";
  }
}

/** Build the toolkit with the read-only allowlist and assert the exposed tool names. */
export function createReadOnlyToolkit(credentials: {
  clientId: string;
  clientSecret: string;
}): ToolkitHandle {
  // Toolkit reads are LangChain runs; LangChain's own tracer must never send their results.
  switchOffAutomaticTracing();
  const toolkit = new PayPalAgentToolkit({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    configuration: {
      actions: structuredClone(TOOLKIT_READ_ACTIONS) as unknown as Record<
        string,
        Record<string, boolean>
      >,
      context: { sandbox: true },
    },
  });
  const tools = toolkit.getTools();
  const names = tools.map((t) => t.name).sort();
  assertAllowlist(names);
  return {
    toolNames: names,
    async invoke(name, args) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new ToolkitAllowlistError(`Tool ${name} is not enabled`, names);
      const result: unknown = await tool.invoke(args);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  };
}

export function assertAllowlist(actualNames: string[]): void {
  const expected = [...EXPECTED_READ_TOOL_NAMES].sort();
  const actual = [...actualNames].sort();
  const forbidden = actual.filter((n) => (FORBIDDEN_TOOL_NAMES as readonly string[]).includes(n));
  if (forbidden.length > 0) {
    throw new ToolkitAllowlistError(
      `Forbidden toolkit tools are enabled: ${forbidden.join(", ")}`,
      actual,
    );
  }
  if (expected.length !== actual.length || expected.some((n, i) => n !== actual[i])) {
    throw new ToolkitAllowlistError(
      `Installed toolkit exposes [${actual.join(", ")}] but the allowlist expects [${expected.join(", ")}]. Review the installed version before enabling it.`,
      actual,
    );
  }
}
