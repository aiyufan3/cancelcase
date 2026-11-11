/**
 * Trusted-Host boundary for the loopback server. A browser request carries the Host it was
 * addressed to; DNS rebinding makes a hostile name resolve to 127.0.0.1, so binding to
 * loopback alone does not prove the request was meant for this application. Every route —
 * session issuance, reads, downloads, pages and mutations — only answers for the configured
 * origin's host (and its loopback alias on the same port).
 *
 * Pure functions with no Node imports, so the request proxy can use them too.
 */

const DEFAULT_ORIGIN = "http://127.0.0.1:3000";

function parseOrigin(appOrigin: string | undefined | null): URL {
  try {
    return new URL((appOrigin ?? "").trim() || DEFAULT_ORIGIN);
  } catch {
    return new URL(DEFAULT_ORIGIN);
  }
}

/** Host header values (host:port) this server answers to. */
export function trustedHosts(appOrigin: string | undefined | null): string[] {
  const url = parseOrigin(appOrigin);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const names = new Set([url.hostname.toLowerCase()]);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    names.add("127.0.0.1");
    names.add("localhost");
  }
  const hosts: string[] = [];
  for (const name of names) {
    hosts.push(`${name}:${port}`);
    if (
      (url.protocol === "http:" && port === "80") ||
      (url.protocol === "https:" && port === "443")
    )
      hosts.push(name);
  }
  return hosts;
}

/** Origins (scheme://host:port) allowed to send mutations. */
export function trustedOrigins(appOrigin: string | undefined | null): string[] {
  const url = parseOrigin(appOrigin);
  return trustedHosts(appOrigin).map((h) => `${url.protocol}//${h}`);
}

export function isTrustedHost(
  hostHeader: string | null | undefined,
  appOrigin: string | undefined | null,
): boolean {
  if (!hostHeader) return false;
  return trustedHosts(appOrigin).includes(hostHeader.trim().toLowerCase());
}
