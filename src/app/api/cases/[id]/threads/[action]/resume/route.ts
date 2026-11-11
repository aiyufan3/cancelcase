import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { assertActionAllowedForRole } from "@/server/services/case-service";
import { buildCaseView } from "@/server/services/case-view";
import { resumeCaseThread } from "@/graph/case-graph";
import { AppError } from "@/server/services/errors";
import type { ActionKind } from "@/domain/types";

const ACTIONS: ActionKind[] = [
  "export_refund_request",
  "buyer_create_dispute",
  "merchant_provide_evidence",
];

const schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approve"),
    approvalId: z.string().min(1),
    simulate: z.enum(["timeout", "unsupported"]).nullable().optional(),
  }),
  z.object({ kind: z.literal("reject"), reason: z.string().min(1).max(300) }),
  z.object({ kind: z.literal("edit") }),
]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  try {
    const { env, body } = await guardMutation(req, { schema });
    const { id, action } = await params;
    if (!ACTIONS.includes(action as ActionKind))
      throw new AppError("UNKNOWN_ACTION", "Unknown action.", 404);
    assertActionAllowedForRole(env.role!, action as ActionKind);
    // Fixture test controls are only honoured in fixture mode; they never reach the Sandbox adapter.
    const decision =
      body.kind === "approve"
        ? { ...body, simulate: env.ctx.config.mode === "fixture" ? (body.simulate ?? null) : null }
        : body;
    const thread = await resumeCaseThread(env.ctx, {
      caseId: id,
      role: env.role!,
      action: action as ActionKind,
      decision,
    });
    return NextResponse.json({
      thread: {
        threadId: thread.threadId,
        interrupted: thread.interrupted,
        next: thread.next,
        log: thread.state.log ?? [],
        operationId: thread.state.operationId,
        operationStatus: thread.state.operationStatus,
      },
      view: buildCaseView(env.ctx, id, env.role!),
    });
  } catch (err) {
    return jsonError(err);
  }
}
