import { NextResponse } from "next/server";
import { envelope, jsonError } from "@/server/http/guards";
import {
  CSRF_COOKIE,
  ROLE_COOKIE,
  cookieHeader,
  csrfCookieHeader,
  encodeRoleCookie,
  newCsrfToken,
} from "@/server/http/session";

export const dynamic = "force-dynamic";

/** Issues the CSRF token and a default buyer role session. GET never mutates application state. */
export async function GET(req: Request) {
  try {
    const env = envelope(req);
    const headers = new Headers();
    let csrf = env.cookies[CSRF_COOKIE];
    if (!csrf) {
      csrf = newCsrfToken();
      headers.append("Set-Cookie", csrfCookieHeader(csrf));
    }
    let role = env.role;
    if (!role) {
      role = "buyer";
      headers.append("Set-Cookie", cookieHeader(ROLE_COOKIE, encodeRoleCookie(env.ctx, role)));
    }
    return NextResponse.json(
      {
        role,
        csrfToken: csrf,
        mode: env.ctx.config.mode,
        roleSwitchNote: "Local demo role switch. Not production authentication.",
      },
      { headers },
    );
  } catch (err) {
    return jsonError(err);
  }
}
