import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { setRequestedAmount } from "@/server/services/case-service";
import { buildCaseView } from "@/server/services/case-view";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { env, body } = await guardMutation(req, {
      schema: z.object({ cents: z.number().int().positive() }),
    });
    const { id } = await params;
    setRequestedAmount(env.ctx, env.role!, id, body.cents);
    return NextResponse.json(buildCaseView(env.ctx, id, env.role!));
  } catch (err) {
    return jsonError(err);
  }
}
