import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { ROLE_COOKIE, cookieHeader, encodeRoleCookie } from "@/server/http/session";
import { logAudit } from "@/server/services/audit";

export async function POST(req: Request) {
  try {
    const { env, body } = await guardMutation(req, {
      schema: z.object({ role: z.enum(["buyer", "merchant"]) }),
      requireRole: false,
    });
    logAudit(env.ctx, {
      action: "session.role_switched",
      role: body.role,
      details: { note: "local demo role switch" },
    });
    const headers = new Headers({
      "Set-Cookie": cookieHeader(ROLE_COOKIE, encodeRoleCookie(env.ctx, body.role)),
    });
    return NextResponse.json({ role: body.role }, { headers });
  } catch (err) {
    return jsonError(err);
  }
}
