import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { refreshProviderObservation } from "@/server/services/operation-service";
import { buildCaseView } from "@/server/services/case-view";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { env } = await guardMutation(req, { schema: z.object({}).passthrough() });
    const { id } = await params;
    const result = await refreshProviderObservation(env.ctx, id, null);
    return NextResponse.json({ error: result.error, view: buildCaseView(env.ctx, id, env.role!) });
  } catch (err) {
    return jsonError(err);
  }
}
