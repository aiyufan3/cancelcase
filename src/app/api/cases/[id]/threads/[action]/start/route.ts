import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { assertActionAllowedForRole } from "@/server/services/case-service";
import { buildCaseView } from "@/server/services/case-view";
import { startCaseThread } from "@/graph/case-graph";
import { AppError } from "@/server/services/errors";
import type { ActionKind } from "@/domain/types";

const ACTIONS: ActionKind[] = [
  "export_refund_request",
  "buyer_create_dispute",
  "merchant_provide_evidence",
];

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  try {
    const { env, body } = await guardMutation(req, {
      schema: z.object({ regenerate: z.boolean().optional() }).passthrough(),
    });
    const { id, action } = await params;
    if (!ACTIONS.includes(action as ActionKind))
      throw new AppError("UNKNOWN_ACTION", "Unknown action.", 404);
    assertActionAllowedForRole(env.role!, action as ActionKind);
    const thread = await startCaseThread(env.ctx, {
      caseId: id,
      role: env.role!,
      action: action as ActionKind,
      regenerate: body.regenerate === true,
    });
    return NextResponse.json({
      thread: {
        threadId: thread.threadId,
        interrupted: thread.interrupted,
        regenerated: thread.regenerated ?? false,
        next: thread.next,
        log: thread.state.log ?? [],
      },
      view: buildCaseView(env.ctx, id, env.role!),
    });
  } catch (err) {
    return jsonError(err);
  }
}
