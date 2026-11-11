import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { addContactEvent } from "@/server/services/case-service";
import { buildCaseView } from "@/server/services/case-view";

const schema = z.object({
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/),
  direction: z.enum(["buyer_to_merchant", "merchant_to_buyer", "note"]),
  summary: z.string().min(1).max(500),
  sourceIds: z.array(z.string()).max(10).default([]),
  shared: z.boolean().default(false),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { env, body } = await guardMutation(req, { schema });
    const { id } = await params;
    addContactEvent(env.ctx, env.role!, { caseId: id, ...body });
    return NextResponse.json(buildCaseView(env.ctx, id, env.role!));
  } catch (err) {
    return jsonError(err);
  }
}
