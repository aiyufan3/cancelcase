import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { deleteCase } from "@/server/services/deletion";
import { deleteCaseThreads } from "@/graph/case-graph";
import { AppError } from "@/server/services/errors";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { env, body } = await guardMutation(req, { schema: z.object({ confirm: z.string() }) });
    const { id } = await params;
    if (body.confirm !== id)
      throw new AppError("CONFIRM_MISMATCH", "Type the case ID to confirm deletion.", 400);
    const result = await deleteCase(env.ctx, id, env.role!, (ids) =>
      deleteCaseThreads(env.ctx, ids),
    );
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(err);
  }
}
