import fs from "node:fs";
import path from "node:path";
import { redactText } from "@/paypal/redact";

/**
 * Private model-call diagnostics.
 *
 * The configured service, endpoint and model are operator configuration. When a call fails,
 * the precise reason (HTTP status, finish reason, a redacted excerpt of the upstream body)
 * is useful to the operator but must not reach browsers, exports, shared logs or captures.
 * It is appended to an ignored local file under the data directory instead
 * (data/local/<mode>/diagnostics/model-calls.jsonl), readable only by the local user.
 */

export interface ModelCallDiagnostic {
  at: string;
  transport: string | null;
  model: string | null;
  endpointHost: string | null;
  endpointPath: string | null;
  attempt: number;
  ok: boolean;
  outcome: string;
  httpStatus: number | null;
  finishReason: string | null;
  elapsedMs: number;
  /** Redacted, truncated upstream detail; never the API key */
  detail: string | null;
}

export interface ModelDiagnostics {
  record(entry: ModelCallDiagnostic): void;
}

export const noDiagnostics: ModelDiagnostics = { record: () => {} };

export function fileDiagnostics(dir: string): ModelDiagnostics {
  const file = path.join(dir, "model-calls.jsonl");
  return {
    record(entry) {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      } catch {
        // Diagnostics are best-effort and must never break drafting.
      }
    },
  };
}

/** Remove configured values (and anything that looks like a URL or secret) from a string. */
export function scrubConfigured(
  text: string,
  configured: (string | null | undefined)[],
  maxLength = 300,
): string {
  let out = text;
  const values = configured
    .filter((v): v is string => typeof v === "string" && v.trim().length >= 3)
    .flatMap((v) => {
      const extra: string[] = [v];
      try {
        const u = new URL(v);
        extra.push(u.host, u.hostname);
      } catch {
        /* not a URL */
      }
      return extra;
    })
    .sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join("[configured]");
  out = out.replace(/https?:\/\/[^\s"'<>]+/gi, "[url]");
  return redactText(out, maxLength);
}
