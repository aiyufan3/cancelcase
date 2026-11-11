import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { decideApproval } from "@/server/services/case-service";
import { buildCaseView } from "@/server/services/case-view";

const schema = z.object({
  action: z.enum(["export_refund_request", "buyer_create_dispute", "merchant_provide_evidence"]),
  draftId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().max(300).optional(),
  /** The content hash of the version on screen: a decision never applies to another version */
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { env, body } = await guardMutation(req, { schema });
    const { id } = await params;
    const approval = decideApproval(env.ctx, { caseId: id, role: env.role!, ...body });
    return NextResponse.json({
      approval: { id: approval.id, decision: approval.decision, expiresAt: approval.expiresAt },
      view: buildCaseView(env.ctx, id, env.role!),
    });
  } catch (err) {
    return jsonError(err);
  }
}
