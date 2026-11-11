import { NextResponse } from "next/server";
import type { z } from "zod";
import type { AppContext } from "../context";
import { getAppContext } from "../context";
import { AppError } from "../services/errors";
import { logAudit } from "../services/audit";
import { CSRF_COOKIE, CSRF_HEADER, ROLE_COOKIE, decodeRoleCookie, parseCookies } from "./session";
import type { Role } from "@/domain/types";
import { sweepExpiredLeases } from "../services/operation-service";
import { isTrustedHost, trustedOrigins } from "./host";

/**
 * Request guards for route handlers.
 * - GET routes never mutate.
 * - Mutations require: POST, same-origin Origin/Host, double-submit CSRF token, a valid role
 *   session cookie, and a JSON body that passes schema validation.
 * - Errors are returned as safe JSON with stable codes; nothing sensitive is echoed.
 */

export interface RequestEnvelope {
  ctx: AppContext;
  role: Role | null;
  cookies: Record<string, string>;
}

/**
 * Every route starts here. The Host header must name this application (trusted-Host boundary),
 * for reads and downloads as well as mutations, before any cookie is decoded or data returned.
 */
export function envelope(req: Request): RequestEnvelope {
  const ctx = getAppContext();
  if (!isTrustedHost(req.headers.get("host"), ctx.config.appOrigin)) {
    logAudit(ctx, {
      action: "http.denied",
      reasonCode: "HOST",
      details: { path: safePath(req) },
    });
    throw new AppError(
      "HOST_DENIED",
      "This server only answers requests addressed to its own origin.",
      403,
    );
  }
  const cookies = parseCookies(req.headers.get("cookie"));
  const role = decodeRoleCookie(ctx, cookies[ROLE_COOKIE]);
  return { ctx, role, cookies };
}

export function jsonError(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details ?? null } },
      { status: err.status },
    );
  }
  if (err && typeof err === "object" && (err as { name?: string }).name === "EvidenceError") {
    const e = err as Error & { code: string };
    return NextResponse.json(
      { error: { code: `EVIDENCE_${e.code}`, message: e.message, details: null } },
      { status: 400 },
    );
  }
  if (
    err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "WorkflowTransitionError"
  ) {
    return NextResponse.json(
      { error: { code: "WORKFLOW_TRANSITION", message: (err as Error).message, details: null } },
      { status: 409 },
    );
  }
  console.error(
    "[cancelcase] unexpected error:",
    err instanceof Error ? `${err.name}: ${err.message}` : err,
  );
  return NextResponse.json(
    {
      error: {
        code: "INTERNAL",
        message: "Unexpected server error. Check the server log.",
        details: null,
      },
    },
    { status: 500 },
  );
}

function safePath(req: Request): string {
  try {
    return new URL(req.url).pathname.slice(0, 200);
  } catch {
    return "(unparseable)";
  }
}

function sameOrigin(req: Request, ctx: AppContext): string | null {
  const host = req.headers.get("host");
  if (!isTrustedHost(host, ctx.config.appOrigin)) return "Host header is not this application";
  const origin = req.headers.get("origin");
  if (origin) {
    const normalized = origin.replace(/\/$/, "").toLowerCase();
    if (!trustedOrigins(ctx.config.appOrigin).includes(normalized)) return "Origin is not allowed";
    // The Origin must be the same host the request was addressed to.
    if (new URL(normalized).host !== (host ?? "").trim().toLowerCase())
      return "Origin and Host do not match";
  } else {
    const fetchSite = req.headers.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
      return `Cross-site request (${fetchSite})`;
    // No Origin header (scripted client): the CSRF double-submit check below still applies.
  }
  return null;
}

export interface MutationOptions<T> {
  schema: z.ZodType<T>;
  requireRole?: boolean;
}

export async function guardMutation<T>(
  req: Request,
  options: MutationOptions<T>,
): Promise<{ env: RequestEnvelope; body: T }> {
  if (req.method !== "POST")
    throw new AppError("METHOD_NOT_ALLOWED", "Mutations must use POST.", 405);
  const env = envelope(req);
  const originProblem = sameOrigin(req, env.ctx);
  if (originProblem) {
    logAudit(env.ctx, {
      action: "http.denied",
      reasonCode: "ORIGIN",
      details: { problem: originProblem, path: safePath(req) },
    });
    throw new AppError("ORIGIN_DENIED", originProblem, 403);
  }
  const headerToken = req.headers.get(CSRF_HEADER);
  const cookieToken = env.cookies[CSRF_COOKIE];
  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    logAudit(env.ctx, {
      action: "http.denied",
      reasonCode: "CSRF",
      details: { path: new URL(req.url).pathname },
    });
    throw new AppError(
      "CSRF_DENIED",
      "Missing or mismatched CSRF token. Reload the page and try again.",
      403,
    );
  }
  if (options.requireRole !== false && !env.role) {
    throw new AppError("NO_ROLE_SESSION", "No valid role session. Choose a demo role first.", 401);
  }
  let raw: unknown = {};
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const text = await req.text();
    if (text.length > 512 * 1024)
      throw new AppError("BODY_TOO_LARGE", "Request body is too large.", 413);
    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        // The parser's own message quotes a piece of the input, so it is neither returned nor
        // logged. The audit entry records that it happened, where, and how long the body was.
        logAudit(env.ctx, {
          action: "http.denied",
          reasonCode: "INVALID_JSON",
          details: { path: safePath(req), bodyCharacters: text.length },
        });
        throw new AppError("INVALID_JSON", "Request body is not valid JSON.", 400);
      }
    }
  }
  const parsed = options.schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      "INVALID_BODY",
      "Request body failed validation.",
      400,
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  sweepExpiredLeases(env.ctx);
  return { env, body: parsed.data };
}

export async function guardMultipart(
  req: Request,
): Promise<{ env: RequestEnvelope; form: FormData }> {
  if (req.method !== "POST")
    throw new AppError("METHOD_NOT_ALLOWED", "Mutations must use POST.", 405);
  const env = envelope(req);
  const originProblem = sameOrigin(req, env.ctx);
  if (originProblem) throw new AppError("ORIGIN_DENIED", originProblem, 403);
  const headerToken = req.headers.get(CSRF_HEADER);
  const cookieToken = env.cookies[CSRF_COOKIE];
  if (!headerToken || !cookieToken || headerToken !== cookieToken)
    throw new AppError("CSRF_DENIED", "Missing or mismatched CSRF token.", 403);
  if (!env.role)
    throw new AppError("NO_ROLE_SESSION", "No valid role session. Choose a demo role first.", 401);
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > 6 * 1024 * 1024)
    throw new AppError("BODY_TOO_LARGE", "Upload exceeds the 5 MB per-file limit.", 413);
  const form = await req.formData();
  return { env, form };
}

export function requireRole(env: RequestEnvelope): Role {
  if (!env.role)
    throw new AppError("NO_ROLE_SESSION", "No valid role session. Choose a demo role first.", 401);
  return env.role;
}
