import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { transferChannel } from "@/server/services/case-service";
import { buildCaseView } from "@/server/services/case-view";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { env, body } = await guardMutation(req, {
      schema: z.object({
        channel: z.enum(["merchant_refund", "app_store", "paypal", "chargeback"]),
        reason: z.string().min(3).max(300),
      }),
    });
    const { id } = await params;
    transferChannel(env.ctx, {
      caseId: id,
      role: env.role!,
      channel: body.channel,
      reason: body.reason,
    });
    return NextResponse.json(buildCaseView(env.ctx, id, env.role!));
  } catch (err) {
    return jsonError(err);
  }
}
