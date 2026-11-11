import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createTestHarness, type TestHarness } from "../helpers/context";
import { setAppContextForTests } from "@/server/context";
import { CSRF_COOKIE, CSRF_HEADER, ROLE_COOKIE, encodeRoleCookie } from "@/server/http/session";
import { GET as sessionGet } from "@/app/api/session/route";
import { GET as casesGet } from "@/app/api/cases/route";
import { GET as caseGet } from "@/app/api/cases/[id]/route";
import { GET as evidenceGet } from "@/app/api/evidence/[id]/route";
import { GET as exportGet } from "@/app/api/cases/[id]/export/route";
import { GET as healthGet } from "@/app/api/health/route";
import { POST as deletePost } from "@/app/api/cases/[id]/delete/route";
import { POST as contactPost } from "@/app/api/cases/[id]/contact/route";
import { proxy } from "@/proxy";
import { isTrustedHost } from "@/server/http/host";
import { cases, charges, evidence as evidenceRepo } from "@/server/db/repos";
import { buildCaseView } from "@/server/services/case-view";
import { decideApproval, generateDraft, requireBundle } from "@/server/services/case-service";

/**
 * Local HTTP boundary (independent audit AUD05, AUD06, AUD07 and follow-ups): a common
 * trusted-Host check for session issuance, reads, downloads, pages and mutations; owner-only
 * deletion; role-scoped audit; recording-mode masking of every real identifier.
 */

const ORIGIN = "http://127.0.0.1:3999";
let h: TestHarness;
beforeEach(() => {
  h = createTestHarness();
  setAppContextForTests(h.ctx);
});
afterEach(() => {
  setAppContextForTests(null);
  h.cleanup();
});

function cookie(role: "buyer" | "merchant" | null, csrf: string | null = null): string {
  const parts: string[] = [];
  if (role) parts.push(`${ROLE_COOKIE}=${encodeURIComponent(encodeRoleCookie(h.ctx, role))}`);
  if (csrf) parts.push(`${CSRF_COOKIE}=${csrf}`);
  return parts.join("; ");
}

function get(path: string, host: string, role: "buyer" | "merchant" | null = "buyer"): Request {
  const headers = new Headers({ host });
  const c = cookie(role);
  if (c) headers.set("cookie", c);
  return new Request(`http://${host}${path}`, { headers });
}

function post(
  path: string,
  body: unknown,
  opts: { host?: string; origin?: string; role?: "buyer" | "merchant" },
) {
  const host = opts.host ?? "127.0.0.1:3999";
  return new Request(`http://${host}${path}`, {
    method: "POST",
    headers: {
      host,
      origin: opts.origin ?? ORIGIN,
      cookie: cookie(opts.role ?? "buyer", "tok"),
      [CSRF_HEADER]: "tok",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const p = (id: string) => ({ params: Promise.resolve({ id }) });
const EVIL = "attacker.example:3999";

describe("trusted-Host boundary", () => {
  it("AUD05: no role session or CSRF token is issued for an untrusted Host", async () => {
    const res = await sessionGet(get("/api/session", EVIL, null));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).not.toMatch(/csrfToken/);
  });

  it("AUD06: reads, downloads, exports and health refuse an untrusted Host even with a valid role cookie", async () => {
    const fileEvidence = evidenceRepo
      .listForCase(h.ctx.db, h.caseId, requireBundle(h.ctx, h.caseId).subscription.id)
      .find((e) => e.storageName && e.visibility === "shared")!;
    const responses = [
      await caseGet(get(`/api/cases/${h.caseId}`, EVIL), p(h.caseId)),
      await casesGet(get("/api/cases", EVIL)),
      await evidenceGet(get(`/api/evidence/${fileEvidence.id}`, EVIL), p(fileEvidence.id)),
      await exportGet(get(`/api/cases/${h.caseId}/export`, EVIL), p(h.caseId)),
      await healthGet(get("/api/health", EVIL, null)),
    ];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("Alex Example");
    }
  });

  it("answers the configured host and its loopback alias on the same port only", async () => {
    expect(
      (await caseGet(get(`/api/cases/${h.caseId}`, "127.0.0.1:3999"), p(h.caseId))).status,
    ).toBe(200);
    expect(
      (await caseGet(get(`/api/cases/${h.caseId}`, "localhost:3999"), p(h.caseId))).status,
    ).toBe(200);
    expect(isTrustedHost("127.0.0.1:4000", ORIGIN)).toBe(false);
    expect(isTrustedHost("127.0.0.1.attacker.example:3999", ORIGIN)).toBe(false);
    expect(isTrustedHost(null, ORIGIN)).toBe(false);
  });

  it("mutations need an Origin that matches the Host they were sent to", async () => {
    const body = {
      at: "2026-11-08T14:00:00Z",
      direction: "note",
      summary: "x",
      sourceIds: [],
      shared: false,
    };
    const mixed = await contactPost(
      post(`/api/cases/${h.caseId}/contact`, body, { host: "localhost:3999", origin: ORIGIN }),
      p(h.caseId),
    );
    expect(mixed.status).toBe(403);
    const ok = await contactPost(post(`/api/cases/${h.caseId}/contact`, body, {}), p(h.caseId));
    expect(ok.status).toBe(200);
  });

  it("the request proxy refuses page requests for an untrusted Host", () => {
    const previous = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = ORIGIN;
    try {
      const denied = proxy(new NextRequest(`http://${EVIL}/cases/x`, { headers: { host: EVIL } }));
      expect(denied.status).toBe(403);
      const allowed = proxy(
        new NextRequest(`${ORIGIN}/cases/x`, { headers: { host: "127.0.0.1:3999" } }),
      );
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("x-middleware-next")).toBe("1");
    } finally {
      if (previous === undefined) delete process.env.APP_ORIGIN;
      else process.env.APP_ORIGIN = previous;
    }
  });
});

describe("ownership", () => {
  it("AUD07: the merchant view cannot delete the owner's case; the owner can", async () => {
    const denied = await deletePost(
      post(`/api/cases/${h.caseId}/delete`, { confirm: h.caseId }, { role: "merchant" }),
      p(h.caseId),
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("OWNER_ONLY");
    expect(cases.get(h.ctx.db, h.caseId)).not.toBeNull();
    const ok = await deletePost(
      post(`/api/cases/${h.caseId}/delete`, { confirm: h.caseId }, { role: "buyer" }),
      p(h.caseId),
    );
    expect(ok.status).toBe(200);
    expect(cases.get(h.ctx.db, h.caseId)).toBeNull();
  });
});

describe("role-scoped audit", () => {
  it("the merchant does not see the buyer's drafting and approval activity, but both see shared system events", async () => {
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: draft.id,
      decision: "approved",
    });
    const merchantAudit = buildCaseView(h.ctx, h.caseId, "merchant").audit;
    const buyerAudit = buildCaseView(h.ctx, h.caseId, "buyer").audit;
    expect(merchantAudit.some((a) => a.action === "draft.created")).toBe(false);
    expect(merchantAudit.some((a) => a.action.startsWith("approval."))).toBe(false);
    expect(merchantAudit.every((a) => a.role === "merchant" || a.role === null)).toBe(true);
    expect(buyerAudit.some((a) => a.action === "draft.created")).toBe(true);
    expect(merchantAudit.some((a) => a.action === "case.reconciled")).toBe(true);
    expect(buyerAudit.some((a) => a.action === "case.reconciled")).toBe(true);
  });
});

describe("recording mode", () => {
  it("masks a manually entered real transaction reference as well as provider observations", () => {
    const bundle = requireBundle(h.ctx, h.caseId);
    const realLooking = "8AB12345CD678901E";
    charges.update(h.ctx.db, {
      ...bundle.charge,
      providerRefs: [
        ...bundle.charge.providerRefs.filter((r) => r.kind !== "buyer_transaction_id"),
        { kind: "buyer_transaction_id", value: realLooking, provenance: "user_attestation" },
      ],
    });
    const masked = JSON.stringify(buildCaseView(h.ctx, h.caseId, "buyer"));
    expect(masked).not.toContain(realLooking);
    expect(masked).toContain("8AB…01E");
    // Invented fixture values stay readable.
    expect(masked).toContain("FX-SALE-SYNTHETIC-2");
    h.ctx.config.recordingMode = false;
    expect(JSON.stringify(buildCaseView(h.ctx, h.caseId, "buyer"))).toContain(realLooking);
  });
});
