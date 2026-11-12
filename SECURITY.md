# Security policy

CancelCase is a local, loopback-only application that handles your own cancellation evidence and, in connected mode, your own PayPal Sandbox credentials. It is an early-stage project: not hardened for hosting, not multi-tenant, and not a substitute for the dispute processes of a payment provider.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub's security advisory feature for this repository ("Report a vulnerability"). Include reproduction steps and the commit you tested. You should receive an acknowledgement within a few days; fixes are published as regular commits with a note in the release history.

## Scope

In scope:

- Bypassing approval binding, expiry or single-use consumption for any operation.
- Causing a second provider write for one approval (double dispatch, graph replay, concurrent requests).
- Disclosing role-private evidence without explicit, version-bound inclusion to the other role, the model, an export or a payload.
- Credential, token or assertion leakage in responses, logs, exports or bundles.
- Evidence upload handling (traversal, type spoofing, size limits, executable content, hash bypass).
- Cross-origin or CSRF bypass of mutation routes; mutations through GET.
- Following untrusted provider links or redirects with credentials; non-Sandbox origins.

Out of scope:

- Issues that require the attacker to already run code on the same machine as the operator.
- Hosting the application on a public interface (unsupported by design).
- PayPal Sandbox behaviour itself.

## Design notes relevant to reviewers

- Credentials are read server-side from `.env` only in sandbox mode; fixture mode never reads them. Nothing is exposed with a `NEXT_PUBLIC_` prefix.
- Provider origins are allow-listed to PayPal Sandbox hosts. Action links from provider responses are validated against the origin, the expected path and the expected resource before they are treated as capabilities.
- Writes are never retried automatically. Ambiguous results become `UNKNOWN` and require read-back plus a recorded human decision.
- The Agent Toolkit is configured with a read-only allowlist that is asserted against the installed package at startup and in tests.
- Evidence bytes are sniffed; names are never trusted; storage names are generated; files are served with `nosniff`, `attachment` disposition and a sandboxed CSP.
- A pre-commit hook runs a private-path check, content rules and the pinned `secretlint` scanner over staged content. CI runs the same scan over all tracked files.
- Claim reservations compare provider payment aliases within the same environment/account, including legacy imported/connected duplicate records. Import and reservation changes are atomic; provider resolution releases only the reservation identity that was observed, so a late resolution cannot delete a replacement claim.
- Configured model identifiers or credentials echoed inside otherwise valid generated output are rejected before a draft is stored. Exact credentials are redacted from private diagnostics, and toolkit failures expose only a neutral status. These checks complement, rather than replace, explicit disclosure and human review.
- Provider notes are never silently truncated. A complete message over the supported length blocks approval and dispatch; editing or rejecting it remains available.

## Dependencies

Dependency versions are pinned and installed with a frozen lockfile. `pnpm deps:audit` (also in CI) runs the production audit and fails on any advisory that is not in the reviewed residual list `scripts/accepted-advisories.json`, on an accepted advisory that shows up on a different dependency path, and after the list's review date. Registry errors, interrupted processes and incomplete or malformed reports are failures, not evidence of zero advisories.

Current state (2026-11-09): the PayPal Agent Toolkit's pinned LangChain core was moved within its 0.3 line to 0.3.80 with a scoped override, which removes the serialization-injection advisory. Twelve advisories remain (five high, five moderate, two low). All of them sit under `@paypal/agent-toolkit` (whose latest release pins `mathjs` 14, `ai` 4, `zod` 3 and a LangChain 0.3 core) or under the OpenAI client package that only satisfies an optional peer. Their fixes are major-version changes that the toolkit does not accept, so they were not forced with cross-major overrides. They are accepted as residual risk because, in this application:

- only the toolkit's LangChain entry is imported, and it loads neither the AI SDK, the OpenAI client nor the diff library;
- `mathjs` is used by the toolkit only to round amounts in an order tool that the allowlist never enables; no expression is evaluated;
- LangChain's own tracing switches are refused at startup and removed from the process environment, so its automatic tracer never runs; the optional LangSmith tracing ([docs/observability.md](docs/observability.md)) uses the direct, current `langsmith` dependency and redacts every run before it is sent; prompts are never pulled from a hub;
- the app passes only small fixed argument objects to the eight read tools.

`tests/unit/dependency-boundary.test.ts` enforces these facts, so an update that breaks one of them fails the test suite and the acceptance has to be reviewed again. Removing the toolkit or replacing it is a larger change that has not been made.
