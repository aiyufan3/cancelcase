import type { SafeError } from "./adapter";
import { redactText, summarizeProviderError } from "./redact";
import type { Clock } from "@/domain/time";
import { SANDBOX_ORIGINS } from "@/server/config";

/**
 * Minimal PayPal REST client for Sandbox only.
 *
 * - Refuses any origin that is not a PayPal Sandbox origin.
 * - Issues client_credentials tokens and caches them in memory (never on disk).
 * - Classifies failures: reads may retry with bounded backoff; writes never retry
 *   automatically, and ambiguous failures are surfaced as `ambiguous: true`.
 * - Never logs headers, tokens, assertions or raw bodies.
 */

export interface TokenInfo {
  accessToken: string;
  scopes: string[];
  appId: string | null;
  expiresAt: number;
}

export type RestResult<T> =
  | { ok: true; status: number; data: T; debugId: string | null; headers: Headers }
  | {
      ok: false;
      status: number | null;
      error: SafeError;
      /** For reads: worth retrying with backoff */
      retriable: boolean;
      /** For writes: the request may have been applied */
      ambiguous: boolean;
      retryAfterMs: number | null;
    };

export interface RequestOptions {
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** PayPal-Request-Id; only pass for endpoints documented to support it */
  requestId?: string;
  /** PayPal-Auth-Assertion JWT; only for buyer-context Sandbox calls */
  authAssertion?: string;
  kind: "read" | "write";
}

export type FetchLike = typeof fetch;

export class PayPalRestClient {
  private token: TokenInfo | null = null;
  readonly origin: string;

  constructor(
    private readonly cfg: { baseUrl: string; clientId: string; clientSecret: string },
    private readonly clock: Clock,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    const url = new URL(cfg.baseUrl);
    if (!(SANDBOX_ORIGINS as readonly string[]).includes(url.origin)) {
      throw new Error(`Refusing non-Sandbox PayPal origin ${url.origin}`);
    }
    this.origin = url.origin;
  }

  /** Issue or reuse a client_credentials token. The token value never leaves this class except in headers. */
  async getToken(force = false): Promise<RestResult<TokenInfo>> {
    const now = this.clock.now().getTime();
    if (!force && this.token && this.token.expiresAt - 60_000 > now) {
      return { ok: true, status: 200, data: this.token, debugId: null, headers: new Headers() };
    }
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await this.fetchImpl(`${this.origin}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
        signal: controller.signal,
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        return {
          ok: false,
          status: res.status,
          error: {
            code: "UNEXPECTED_REDIRECT",
            message:
              "The token endpoint answered with a redirect; refusing to follow it with credentials.",
            correlationId: res.headers.get("paypal-debug-id"),
            httpStatus: res.status,
          },
          retriable: false,
          ambiguous: false,
          retryAfterMs: null,
        };
      }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !body || typeof body.access_token !== "string") {
        const summary = summarizeProviderError(body);
        return {
          ok: false,
          status: res.status,
          error: {
            code: summary.name ?? `HTTP_${res.status}`,
            message: summary.message ?? "Token request failed.",
            correlationId: summary.debugId ?? res.headers.get("paypal-debug-id"),
            httpStatus: res.status,
          },
          retriable: res.status >= 500,
          ambiguous: false,
          retryAfterMs: null,
        };
      }
      const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 300;
      this.token = {
        accessToken: body.access_token,
        scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [],
        appId: typeof body.app_id === "string" ? body.app_id : null,
        expiresAt: now + expiresIn * 1000,
      };
      return {
        ok: true,
        status: res.status,
        data: this.token,
        debugId: null,
        headers: res.headers,
      };
    } catch (err) {
      return {
        ok: false,
        status: null,
        error: {
          code: "NETWORK_ERROR",
          message: redactText(describeNetworkError(err)),
          correlationId: null,
          httpStatus: null,
        },
        retriable: true,
        ambiguous: false,
        retryAfterMs: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Scopes granted to the current token (empty until a token has been issued). */
  grantedScopes(): string[] {
    return this.token?.scopes ?? [];
  }

  async request<T>(
    method: "GET" | "POST" | "PATCH",
    pathOrUrl: string,
    options: RequestOptions,
  ): Promise<RestResult<T>> {
    const url = this.resolveUrl(pathOrUrl);
    if (!url) {
      return {
        ok: false,
        status: null,
        error: {
          code: "ORIGIN_NOT_ALLOWED",
          message: "Refusing a request outside the configured Sandbox origin.",
          correlationId: null,
          httpStatus: null,
        },
        retriable: false,
        ambiguous: false,
        retryAfterMs: null,
      };
    }
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult as RestResult<T>;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokenResult.data.accessToken}`,
      Accept: "application/json",
      ...(options.headers ?? {}),
    };
    if (options.requestId) headers["PayPal-Request-Id"] = options.requestId;
    if (options.authAssertion) headers["PayPal-Auth-Assertion"] = options.authAssertion;
    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.form) {
      body = options.form; // fetch sets the multipart boundary
    }
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? (options.kind === "write" ? 30_000 : 20_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: "manual",
      });
      const debugId = res.headers.get("paypal-debug-id");
      if (res.status >= 300 && res.status < 400) {
        return {
          ok: false,
          status: res.status,
          error: {
            code: "UNEXPECTED_REDIRECT",
            message:
              "The provider answered with a redirect; refusing to follow it with credentials.",
            correlationId: debugId,
            httpStatus: res.status,
          },
          retriable: false,
          ambiguous: options.kind === "write",
          retryAfterMs: null,
        };
      }
      const text = await res.text();
      let data: unknown = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      if (res.ok) {
        return { ok: true, status: res.status, data: data as T, debugId, headers: res.headers };
      }
      const summary = summarizeProviderError(data);
      const retryAfter = res.headers.get("retry-after");
      const retryAfterMs =
        retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;
      const isServerError = res.status >= 500;
      return {
        ok: false,
        status: res.status,
        error: {
          code: summary.name ?? `HTTP_${res.status}`,
          message:
            [summary.message, ...summary.issues].filter(Boolean).join(" | ") ||
            `Request failed with HTTP ${res.status}.`,
          correlationId: summary.debugId ?? debugId,
          httpStatus: res.status,
        },
        retriable: options.kind === "read" && (isServerError || res.status === 429),
        ambiguous: options.kind === "write" && isServerError,
        retryAfterMs,
      };
    } catch (err) {
      const message = redactText(describeNetworkError(err));
      return {
        ok: false,
        status: null,
        error: {
          code: isAbort(err) ? "NETWORK_TIMEOUT" : "NETWORK_ERROR",
          message,
          correlationId: null,
          httpStatus: null,
        },
        retriable: options.kind === "read",
        ambiguous: options.kind === "write",
        retryAfterMs: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Bounded retry for reads only: exponential backoff with jitter, honoring Retry-After. */
  async read<T>(
    pathOrUrl: string,
    options: Omit<RequestOptions, "kind"> = {},
    maxAttempts = 3,
  ): Promise<RestResult<T>> {
    let attempt = 0;
    let last: RestResult<T>;
    for (;;) {
      attempt += 1;
      last = await this.request<T>("GET", pathOrUrl, { ...options, kind: "read" });
      if (last.ok) return last;
      if (last.status === 401 && attempt === 1) {
        await this.getToken(true);
        continue;
      }
      if (!last.retriable || attempt >= maxAttempts) return last;
      const base = Math.min(8_000, 500 * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      await sleep(last.retryAfterMs ?? base + jitter);
    }
  }

  /** Writes are sent exactly once by this client. Callers own idempotency and recovery. */
  async write<T>(
    method: "POST" | "PATCH",
    pathOrUrl: string,
    options: Omit<RequestOptions, "kind">,
  ): Promise<RestResult<T>> {
    return this.request<T>(method, pathOrUrl, { ...options, kind: "write" });
  }

  private resolveUrl(pathOrUrl: string): string | null {
    if (pathOrUrl.startsWith("/")) return `${this.origin}${pathOrUrl}`;
    try {
      const u = new URL(pathOrUrl);
      if (u.origin !== this.origin) return null;
      if (u.username || u.password) return null;
      return u.toString();
    } catch {
      return null;
    }
  }
}

function isAbort(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError"
  );
}

function describeNetworkError(err: unknown): string {
  if (isAbort(err)) return "The request timed out.";
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    return `${err.message}${cause?.code ? ` (${cause.code})` : ""}`;
  }
  return "Network request failed.";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the documented Sandbox buyer assertion: an unsigned JWT ({"alg":"none"}) whose
 * payload carries the app client ID and the consenting Sandbox buyer's email.
 * This header is only meaningful once the app has the create scope and buyer consent.
 */
export function buildBuyerAuthAssertion(clientId: string, buyerEmail: string): string {
  const b64url = (s: string) =>
    Buffer.from(s, "utf8")
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: clientId, email: buyerEmail }));
  return `${header}.${payload}.`;
}

/**
 * Build the Sandbox "Log in with PayPal" consent link through which the Sandbox Personal
 * account grants this app the buyer dispute scopes. The host is fixed to Sandbox; the link
 * carries only public values (client ID, scopes, return URL, state) and no network call is made.
 */
export function buildBuyerConsentUrl(clientId: string, redirectUri: string, state: string): string {
  const target = new URL(redirectUri);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
  if (!(target.protocol === "https:" || (target.protocol === "http:" && loopback)))
    throw new Error("The consent return URL must be https or a loopback http URL.");
  const params = new URLSearchParams({
    flowEntry: "static",
    client_id: clientId,
    response_type: "code",
    scope: ["openid", SCOPES.disputesCreate, SCOPES.disputesReadBuyer].join(" "),
    redirect_uri: target.toString(),
    state,
  });
  return `https://www.sandbox.paypal.com/connect?${params.toString().replace(/\+/g, "%20")}`;
}

export const SCOPES = {
  disputesReadSeller: "https://uri.paypal.com/services/disputes/read-seller",
  disputesUpdateSeller: "https://uri.paypal.com/services/disputes/update-seller",
  disputesReadBuyer: "https://uri.paypal.com/services/disputes/read-buyer",
  disputesCreate: "https://uri.paypal.com/services/disputes/create",
  disputesUpdateBuyer: "https://uri.paypal.com/services/disputes/update-buyer",
  subscriptions: "https://uri.paypal.com/services/subscriptions",
  reportingSearchRead: "https://uri.paypal.com/services/reporting/search/read",
  payments: "https://uri.paypal.com/services/payments/payment",
} as const;
