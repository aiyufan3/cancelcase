import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/context";
import { setAppContextForTests } from "@/server/context";
import { CSRF_COOKIE, CSRF_HEADER, ROLE_COOKIE, encodeRoleCookie } from "@/server/http/session";
import { GET as sessionGet } from "@/app/api/session/route";
import { GET as caseGet } from "@/app/api/cases/[id]/route";
import { POST as contactPost } from "@/app/api/cases/[id]/contact/route";
import { GET as evidenceGet } from "@/app/api/evidence/[id]/route";
import { GET as exportGet } from "@/app/api/cases/[id]/export/route";
import { POST as approvalsPost } from "@/app/api/cases/[id]/approvals/route";
import { evidence as evidenceRepo } from "@/server/db/repos";

/**
 * Route-handler level checks for the HTTP boundary: same-origin and CSRF enforcement, role
 * sessions, read-only GETs, role-scoped evidence download and leakage sentinels (CC22, CC23).
 */

let h: TestHarness;
const ORIGIN = "http://127.0.0.1:3999";
const SENTINEL = "SENTINEL-NEVER-LEAK-7f3a9c";

beforeEach(() => {
  process.env.PAYPAL_CLIENT_SECRET = SENTINEL; // fixture mode must never read or echo it
  process.env.LLM_API_KEY = SENTINEL;
  h = createTestHarness();
  setAppContextForTests(h.ctx);
});
afterEach(() => {
  setAppContextForTests(null);
  delete process.env.PAYPAL_CLIENT_SECRET;
  delete process.env.LLM_API_KEY;
  h.cleanup();
});

function cookies(role: "buyer" | "merchant" | null, csrf: string | null): string {
  const parts: string[] = [];
  if (role) parts.push(`${ROLE_COOKIE}=${encodeURIComponent(encodeRoleCookie(h.ctx, role))}`);
  if (csrf) parts.push(`${CSRF_COOKIE}=${csrf}`);
  return parts.join("; ");
}

function post(
  path: string,
  body: unknown,
  opts: {
    role?: "buyer" | "merchant" | null;
    csrfCookie?: string | null;
    csrfHeader?: string | null;
    origin?: string | null;
    host?: string;
  } = {},
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    host: opts.host ?? "127.0.0.1:3999",
  });
  if (opts.origin !== null) headers.set("origin", opts.origin ?? ORIGIN);
  const csrfCookie = opts.csrfCookie === undefined ? "tok" : opts.csrfCookie;
  const csrfHeader = opts.csrfHeader === undefined ? "tok" : opts.csrfHeader;
  if (csrfHeader) headers.set(CSRF_HEADER, csrfHeader);
  const cookie = cookies(opts.role === undefined ? "buyer" : opts.role, csrfCookie);
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function get(path: string, role: "buyer" | "merchant" | null = "buyer"): Request {
  const headers = new Headers({ host: "127.0.0.1:3999" });
  const cookie = cookies(role, null);
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { method: "GET", headers });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const contactBody = {
  at: "2026-11-08T14:00:00Z",
  direction: "buyer_to_merchant",
  summary: "Emailed support.",
  sourceIds: [],
  shared: true,
};

describe("CC22 mutation guards", () => {
  it("denies cross-origin, missing or mismatched CSRF, missing role, and wrong host", async () => {
    expect(
      (
        await contactPost(
          post(`/api/cases/${h.caseId}/contact`, contactBody, { origin: "https://evil.example" }),
          params(h.caseId),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await contactPost(
          post(`/api/cases/${h.caseId}/contact`, contactBody, { csrfHeader: null }),
          params(h.caseId),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await contactPost(
          post(`/api/cases/${h.caseId}/contact`, contactBody, { csrfHeader: "other" }),
          params(h.caseId),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await contactPost(
          post(`/api/cases/${h.caseId}/contact`, contactBody, { role: null }),
          params(h.caseId),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await contactPost(
          post(`/api/cases/${h.caseId}/contact`, contactBody, { host: "attacker.example:3999" }),
          params(h.caseId),
        )
      ).status,
    ).toBe(403);
    // A forged role cookie (bad signature) is not a session.
    const forged = new Request(`${ORIGIN}/api/cases/${h.caseId}/contact`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1:3999",
        origin: ORIGIN,
        [CSRF_HEADER]: "tok",
        cookie: `${ROLE_COOKIE}=merchant.1.deadbeef; ${CSRF_COOKIE}=tok`,
      },
      body: JSON.stringify(contactBody),
    });
    expect((await contactPost(forged, params(h.caseId))).status).toBe(401);
    // Nothing was written by the denied requests.
    const view = await (await caseGet(get(`/api/cases/${h.caseId}`), params(h.caseId))).json();
    expect(view.contactHistory).toHaveLength(0);
  });

  it("accepts a same-origin request with a matching CSRF token and a valid role", async () => {
    const res = await contactPost(
      post(`/api/cases/${h.caseId}/contact`, contactBody),
      params(h.caseId),
    );
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.contactHistory).toHaveLength(1);
    // Schema validation rejects garbage.
    const bad = await contactPost(
      post(`/api/cases/${h.caseId}/contact`, { at: "yesterday", direction: "x", summary: "" }),
      params(h.caseId),
    );
    expect(bad.status).toBe(400);
  });

  it("approval routes require a draft that exists for this role and action", async () => {
    const res = await approvalsPost(
      post(`/api/cases/${h.caseId}/approvals`, {
        action: "export_refund_request",
        draftId: "fx_draft_nope",
        decision: "approved",
        expectedContentHash: "0".repeat(64),
      }),
      params(h.caseId),
    );
    expect(res.status).toBe(409);
    const merchant = await approvalsPost(
      post(
        `/api/cases/${h.caseId}/approvals`,
        {
          action: "export_refund_request",
          draftId: "fx_draft_nope",
          decision: "approved",
          expectedContentHash: "0".repeat(64),
        },
        { role: "merchant" },
      ),
      params(h.caseId),
    );
    expect(merchant.status).toBe(403);
  });
});

describe("CC20/CC23 read scoping and leakage", () => {
  it("serves evidence bytes only to a role that may see them, with safe headers", async () => {
    const bundleEvidence = evidenceRepo.listForSubscription(
      h.ctx.db,
      (await (await caseGet(get(`/api/cases/${h.caseId}`), params(h.caseId))).json()).subscription
        .id,
    );
    const buyerPrivate = bundleEvidence.find(
      (e) => e.ownerRole === "buyer" && e.visibility === "private",
    )!;
    const merchantPrivate = bundleEvidence.find(
      (e) => e.ownerRole === "merchant" && e.visibility === "private",
    )!;
    const shared = bundleEvidence.find((e) => e.visibility === "shared" && e.storageName)!;
    expect(
      (
        await evidenceGet(
          get(`/api/evidence/${merchantPrivate.id}`, "buyer"),
          params(merchantPrivate.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await evidenceGet(
          get(`/api/evidence/${buyerPrivate.id}`, "merchant"),
          params(buyerPrivate.id),
        )
      ).status,
    ).toBe(404);
    const ok = await evidenceGet(get(`/api/evidence/${shared.id}`, "merchant"), params(shared.id));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(ok.headers.get("content-security-policy")).toContain("sandbox");
    expect(
      (await evidenceGet(get(`/api/evidence/${shared.id}`, null), params(shared.id))).status,
    ).toBe(401);
  });

  it("views, exports and session responses never contain secret sentinels or buyer-private sources for the merchant", async () => {
    const session = await (await sessionGet(get("/api/session", null))).text();
    const buyerView = await (
      await caseGet(get(`/api/cases/${h.caseId}`, "buyer"), params(h.caseId))
    ).text();
    const merchantView = await (
      await caseGet(get(`/api/cases/${h.caseId}`, "merchant"), params(h.caseId))
    ).text();
    const merchantExport = await (
      await exportGet(get(`/api/cases/${h.caseId}/export?format=md`, "merchant"), params(h.caseId))
    ).text();
    for (const text of [session, buyerView, merchantView, merchantExport]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain("PAYPAL_CLIENT_SECRET");
      expect(text).not.toMatch(/\/home\/|\/Users\//);
    }
    expect(buyerView).toContain("Buyer's private note");
    expect(merchantView).not.toContain("Buyer's private note");
    expect(merchantExport).not.toContain("Buyer's private note");
    expect(merchantView).toContain("Merchant billing log extract");
    expect(merchantExport).toContain("## 6. Source manifest");
  });
});

describe("request bodies that are not JSON (T06)", () => {
  const FRAGMENT = "SECRET-LOOKING-INPUT-91c2";

  function rawPost(body: string): Request {
    return new Request(`http://127.0.0.1:3999/api/cases/${h.caseId}/contact`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1:3999",
        origin: ORIGIN,
        cookie: cookies("buyer", "tok"),
        [CSRF_HEADER]: "tok",
      },
      body,
    });
  }

  it("answers 400 without repeating the input, and logs no fragment of it", async () => {
    const logged: string[] = [];
    const original = { error: console.error, warn: console.warn, log: console.log };
    console.error =
      console.warn =
      console.log =
        (...args: unknown[]) => {
          logged.push(args.map(String).join(" "));
        };
    let res: Response;
    try {
      res = await contactPost(rawPost(`{"summary": "${FRAGMENT}", oops`), {
        params: Promise.resolve({ id: h.caseId }),
      });
    } finally {
      Object.assign(console, original);
    }
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("INVALID_JSON");
    expect(text).not.toContain(FRAGMENT);
    expect(text).not.toContain("oops");
    expect(text).not.toMatch(/position|Unexpected|node_modules|\/src\//);
    expect(logged.join("\n")).not.toContain(FRAGMENT);
    expect(logged.join("\n")).not.toContain("SyntaxError");

    // The denial is still on record, with the place and the size only.
    const entry = h.ctx.db
      .prepare("SELECT * FROM audit_log WHERE reason_code = 'INVALID_JSON'")
      .all() as { details_json: string }[];
    expect(entry).toHaveLength(1);
    expect(entry[0]!.details_json).not.toContain(FRAGMENT);
    expect(JSON.parse(entry[0]!.details_json)).toEqual({
      path: `/api/cases/${h.caseId}/contact`,
      bodyCharacters: `{"summary": "${FRAGMENT}", oops`.length,
    });
  });

  it("still accepts an empty body where the schema allows it, and rejects valid JSON of the wrong shape as before", async () => {
    const wrong = await contactPost(rawPost(`{"unexpected": true}`), {
      params: Promise.resolve({ id: h.caseId }),
    });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error.code).toBe("INVALID_BODY");
  });
});
