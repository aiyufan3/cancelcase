import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { readSubscriptionPayments } from "@/server/services/setup-service";
import { buildCaseView } from "@/server/services/case-view";

/**
 * Reads the subscription's mandate and payments from the provider. Every payment no local charge
 * holds yet becomes its own case; nothing is sent that changes anything at the provider.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { env } = await guardMutation(req, { schema: z.object({}).passthrough() });
    const { id } = await params;
    // Whether this case was still waiting for its first payment, for the wording only. A case the
    // view cannot be built for is reported by the read itself.
    let wasUnpaid = false;
    try {
      const before = buildCaseView(env.ctx, id, env.role!);
      wasUnpaid = before.charge.eventTime === null && before.charge.providerRefs.length === 0;
    } catch {
      wasUnpaid = false;
    }
    const result = await readSubscriptionPayments(env.ctx, id, env.role!);
    const view = buildCaseView(env.ctx, id, env.role!);
    const found = result.newCaseIds.length;
    const taken = wasUnpaid && view.charge.eventTime !== null;
    const count = result.transactionCount;
    const message =
      found > 0
        ? `${found} new payment${found === 1 ? "" : "s"} found. ${found === 1 ? "It is" : "Each is"} its own case, checked against the cancellation you recorded.`
        : taken
          ? "A payment was read. It is recorded in this case and checked against the cancellation you recorded."
          : count === 0
            ? "No payment yet. PayPal lists none for this subscription."
            : count === 1
              ? "No new payment. PayPal lists 1 payment for this subscription, and it already has its case."
              : `No new payment. PayPal lists ${count} payments for this subscription, and each already has its case.`;
    return NextResponse.json({ result, view, message });
  } catch (err) {
    return jsonError(err);
  }
}
