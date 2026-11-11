import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { editDraft } from "@/server/services/case-service";
import { buildCaseView } from "@/server/services/case-view";
import { AppError } from "@/server/services/errors";
import type { ActionKind } from "@/domain/types";

const ACTIONS: ActionKind[] = [
  "export_refund_request",
  "buyer_create_dispute",
  "merchant_provide_evidence",
];

const schema = z.object({
  subject: z.string().min(1).max(200).optional(),
  claims: z
    .array(z.object({ id: z.string().min(1).max(64), text: z.string().min(1).max(1200) }))
    .max(24),
  attachmentEvidenceIds: z.array(z.string().max(128)).max(5).optional(),
  privateSourceIdsIncluded: z.array(z.string().max(128)).max(25).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  try {
    const { env, body } = await guardMutation(req, { schema });
    const { id, action } = await params;
    if (!ACTIONS.includes(action as ActionKind))
      throw new AppError("UNKNOWN_ACTION", "Unknown action.", 404);
    const draft = editDraft(env.ctx, {
      caseId: id,
      role: env.role!,
      action: action as ActionKind,
      ...body,
    });
    return NextResponse.json({
      draftId: draft.id,
      valid: draft.validation.ok,
      view: buildCaseView(env.ctx, id, env.role!),
    });
  } catch (err) {
    return jsonError(err);
  }
}
