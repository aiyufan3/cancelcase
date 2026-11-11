import { NextResponse } from "next/server";
import { SCHEMA_VERSION } from "@/server/db/schema";
import { envelope, jsonError } from "@/server/http/guards";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { ctx } = envelope(req);
    const cases = ctx.db.prepare("SELECT COUNT(*) AS n FROM dispute_cases").get() as { n: number };
    return NextResponse.json({
      ok: true,
      mode: ctx.config.mode,
      schemaVersion: SCHEMA_VERSION,
      cases: cases.n,
      serverTime: ctx.clock.now().toISOString(),
    });
  } catch (err) {
    return jsonError(err);
  }
}
