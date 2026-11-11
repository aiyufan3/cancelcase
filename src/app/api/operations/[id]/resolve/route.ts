import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { resolveUnknownOperation } from "@/server/services/operation-service";
import { operations } from "@/server/db/repos";
import { AppError } from "@/server/services/errors";
import { buildCaseView } from "@/server/services/case-view";

const schema = z.object({
  decision: z.enum(["confirmed_succeeded", "confirmed_failed", "needs_manual_review"]),
  note: z.string().min(1).max(500),
  disputeId: z.string().max(64).nullable().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { env, body } = await guardMutation(req, { schema });
    const { id } = await params;
    const op = operations.get(env.ctx.db, id);
    if (!op || op.role !== env.role)
      throw new AppError("OPERATION_NOT_FOUND", "Operation not found for this role.", 404);
    const result = await resolveUnknownOperation(env.ctx, { operationId: id, ...body });
    return NextResponse.json({
      operation: { id: result.id, status: result.status },
      view: buildCaseView(env.ctx, op.caseId, env.role!),
    });
  } catch (err) {
    return jsonError(err);
  }
}
