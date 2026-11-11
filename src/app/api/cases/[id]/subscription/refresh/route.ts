import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { refreshSubscriptionObservation } from "@/server/services/setup-service";
import { buildCaseView } from "@/server/services/case-view";

/** Reads the provider subscription (payment mandate) back; recorded beside, never merged into, the cancellation facts. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { env } = await guardMutation(req, { schema: z.object({}).passthrough() });
    const { id } = await params;
    const result = await refreshSubscriptionObservation(env.ctx, id);
    return NextResponse.json({ result, view: buildCaseView(env.ctx, id, env.role!) });
  } catch (err) {
    return jsonError(err);
  }
}
