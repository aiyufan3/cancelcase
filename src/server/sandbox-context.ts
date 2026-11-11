import type { Clock } from "@/domain/time";
import type { ProviderAdapter } from "@/paypal/adapter";
import { PayPalRestClient } from "@/paypal/rest-client";
import { SandboxAdapter } from "@/paypal/sandbox-adapter";
import type { Drafter } from "@/llm/drafter";
import { FixtureDrafter } from "@/llm/fixture-drafter";
import { createLiveDrafter } from "@/llm/live-drafter";
import { loadLlmConfig, loadPayPalConfig, readLlmApiKey } from "./config";
import { createReadOnlyToolkit, type ToolkitHandle } from "@/paypal/toolkit";
import { fileDiagnostics } from "@/llm/diagnostics";
import path from "node:path";

/**
 * Connected services are only constructed in sandbox mode. Credentials are read here,
 * handed to the adapters, and never stored anywhere else.
 */
export function buildSandboxServices(
  clock: Clock,
  envDir: string,
): {
  adapter: ProviderAdapter;
  drafter: Drafter;
  restClient: PayPalRestClient;
} {
  const paypal = loadPayPalConfig();
  const restClient = new PayPalRestClient(
    { baseUrl: paypal.baseUrl, clientId: paypal.clientId, clientSecret: paypal.clientSecret },
    clock,
  );
  let toolkit: ToolkitHandle | null;
  try {
    toolkit = createReadOnlyToolkit({
      clientId: paypal.clientId,
      clientSecret: paypal.clientSecret,
    });
  } catch (err) {
    // A toolkit that does not match the read-only allowlist is not used at all.
    console.warn(
      `[cancelcase] toolkit disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    toolkit = null;
  }
  const adapter = new SandboxAdapter(
    restClient,
    clock,
    {
      clientId: paypal.clientId,
      buyerEmail: paypal.buyerEmail,
      buyerDisputesEnabled: paypal.buyerDisputesEnabled,
    },
    toolkit,
  );
  const llm = loadLlmConfig();
  const drafter: Drafter = llm.enabled
    ? createLiveDrafter(
        llm,
        readLlmApiKey(),
        fileDiagnostics(path.join(/* turbopackIgnore: true */ envDir, "diagnostics")),
      )
    : new FixtureDrafter();
  return { adapter, drafter, restClient };
}
