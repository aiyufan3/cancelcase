"use client";

/**
 * Browser-side API helper. Adds the CSRF double-submit header, sends same-origin requests
 * only, and converts error envelopes into typed exceptions.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;
let currentRole: "buyer" | "merchant" | null = null;

export async function ensureSession(): Promise<{
  role: "buyer" | "merchant";
  csrfToken: string;
  mode: string;
}> {
  const res = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
  const data = (await res.json()) as {
    role: "buyer" | "merchant";
    csrfToken: string;
    mode: string;
  };
  csrfToken = data.csrfToken;
  currentRole = data.role;
  return data;
}

export function knownRole(): "buyer" | "merchant" | null {
  return currentRole;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: unknown } } | null)
      ?.error;
    throw new ApiError(
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? `Request failed (${res.status})`,
      res.status,
      err?.details ?? null,
    );
  }
  return data as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  return parse<T>(res);
}

export async function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  if (!csrfToken) await ensureSession();
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-cc-csrf": csrfToken ?? "" },
    body: JSON.stringify(body ?? {}),
  });
  return parse<T>(res);
}

export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  if (!csrfToken) await ensureSession();
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-cc-csrf": csrfToken ?? "" },
    body: form,
  });
  return parse<T>(res);
}

export async function switchRole(role: "buyer" | "merchant"): Promise<void> {
  await apiPost("/api/session/role", { role });
  currentRole = role;
}
