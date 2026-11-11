import { NextResponse } from "next/server";
import { envelope, jsonError, requireRole } from "@/server/http/guards";
import { listCaseSummaries } from "@/server/services/case-view";
import { describeMode } from "@/server/config";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const env = envelope(req);
    const role = requireRole(env);
    return NextResponse.json({
      role,
      mode: { environment: env.ctx.config.mode, ...describeMode(env.ctx.config.mode) },
      cases: listCaseSummaries(env.ctx, role),
    });
  } catch (err) {
    return jsonError(err);
  }
}
