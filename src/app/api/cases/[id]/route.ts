import { NextResponse } from "next/server";
import { envelope, jsonError, requireRole } from "@/server/http/guards";
import { buildCaseView } from "@/server/services/case-view";
import { sweepExpiredLeases } from "@/server/services/operation-service";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const env = envelope(req);
    const role = requireRole(env);
    const { id } = await params;
    sweepExpiredLeases(env.ctx);
    return NextResponse.json(buildCaseView(env.ctx, id, role));
  } catch (err) {
    return jsonError(err);
  }
}
