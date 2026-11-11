import { NextResponse, type NextRequest } from "next/server";
import { isTrustedHost } from "@/server/http/host";

/**
 * Trusted-Host boundary for every request, including pages and their server-rendered data.
 * API route handlers check the same rule again in their request envelope; this proxy also
 * covers page entry paths (/, /cases/…, /sandbox/…), whose server components read cookies.
 */
export function proxy(request: NextRequest) {
  if (!isTrustedHost(request.headers.get("host"), process.env.APP_ORIGIN)) {
    return new NextResponse("This server only answers requests addressed to its own origin.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  // The PayPal return and cancel URLs carry tokens and identifiers in the query string. The
  // landing pages never need them, so drop them before rendering: they stay out of the address
  // bar, the browser history and any screen recording of the page.
  const url = request.nextUrl;
  if (SANDBOX_RETURN_PATHS.has(url.pathname) && url.search) {
    const clean = url.clone();
    clean.search = "";
    const response = NextResponse.redirect(clean, 303);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  }
  return NextResponse.next();
}

const SANDBOX_RETURN_PATHS = new Set([
  "/sandbox/approved",
  "/sandbox/cancelled",
  "/sandbox/consent",
]);
