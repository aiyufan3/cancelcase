import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../context";
import type { Role } from "@/domain/types";

/**
 * Local demo role session. The role switch is a demonstrator convenience for one operator on
 * loopback, not tenant authentication. The cookie is HMAC-signed with a per-installation
 * secret generated into the environment data directory (never from .env, never public).
 */
export const ROLE_COOKIE = "cc_role";
export const CSRF_COOKIE = "cc_csrf";
export const CSRF_HEADER = "x-cc-csrf";

let cachedSecret: Buffer | null = null;

export function sessionSecret(ctx: AppContext): Buffer {
  if (cachedSecret) return cachedSecret;
  if (!ctx.dbPath) {
    cachedSecret = randomBytes(32);
    return cachedSecret;
  }
  const file = path.join(ctx.config.envDir, "session-secret");
  if (fs.existsSync(file)) {
    cachedSecret = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
  } else {
    cachedSecret = randomBytes(32);
    fs.writeFileSync(file, cachedSecret.toString("hex"), { mode: 0o600 });
  }
  return cachedSecret;
}

function sign(ctx: AppContext, value: string): string {
  return createHmac("sha256", sessionSecret(ctx)).update(value).digest("hex");
}

export function encodeRoleCookie(ctx: AppContext, role: Role): string {
  const payload = `${role}.${ctx.clock.now().getTime()}`;
  return `${payload}.${sign(ctx, payload)}`;
}

export function decodeRoleCookie(ctx: AppContext, raw: string | undefined | null): Role | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [role, issued, mac] = parts as [string, string, string];
  if (role !== "buyer" && role !== "merchant") return null;
  const expected = sign(ctx, `${role}.${issued}`);
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return role;
}

export function newCsrfToken(): string {
  return randomBytes(24).toString("hex");
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function cookieHeader(
  name: string,
  value: string,
  maxAgeSeconds = 60 * 60 * 24 * 7,
): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

/** The CSRF cookie must be readable by the page script, so it is not HttpOnly. */
export function csrfCookieHeader(value: string): string {
  return `${CSRF_COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Strict; Max-Age=${60 * 60 * 24 * 7}`;
}
