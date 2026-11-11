import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { readBackForRecovery } from "@/server/services/operation-service";
import { operations } from "@/server/db/repos";
import { AppError } from "@/server/services/errors";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { env } = await guardMutation(req, { schema: z.object({}).passthrough() });
    const { id } = await params;
    const op = operations.get(env.ctx.db, id);
    if (!op || op.role !== env.role)
      throw new AppError("OPERATION_NOT_FOUND", "Operation not found for this role.", 404);
    return NextResponse.json(await readBackForRecovery(env.ctx, id));
  } catch (err) {
    return jsonError(err);
  }
}
