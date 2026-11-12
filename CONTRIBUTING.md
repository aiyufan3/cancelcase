# Contributing to CancelCase

Thanks for your interest. CancelCase is a small, safety-focused codebase; contributions are welcome when they keep the following boundaries intact.

## Non-negotiable boundaries

- **Approval before any external mutation.** Every provider write goes through a content-bound, expiring approval and the operation ledger. Do not add a code path that writes to a provider without them, and do not weaken approval validation, duplicate-write prevention or `UNKNOWN` recovery.
- **Honest labelling.** Fixture results are synthetic and must be labelled as such everywhere they appear. A simulated provider response is never a PayPal result. Submitting evidence never implies an outcome.
- **Role scoping before context.** Unselected private evidence is filtered out before model context, exports and payloads are built. Explicit inclusion is versioned and needs approval. Keep those checks server-side.
- **No model tools.** The drafter receives a snapshot and returns claims. It must not gain tools, network access beyond its own endpoint, or any ability to approve, route funds, select credentials or execute writes.
- **Default-deny toolkit.** `src/paypal/toolkit.ts` enables read tools only. `accept_dispute_claim`, `create_refund` and unrelated mutations stay disabled permanently.
- **Loopback only.** P0 binds to `127.0.0.1`. Hosting, multi-tenant auth and public write APIs are explicit future decisions, not incremental changes.
- **English, synthetic, public.** Everything committed is English and public-safe: no credentials, personal data, real Sandbox identifiers, machine paths or private notes. Fixtures use example-domain personas.

## Development setup

```sh
pnpm install          # also installs the pre-commit security hook
pnpm demo             # fixture mode on http://127.0.0.1:3000
pnpm test             # unit + integration (SQLite in memory)
pnpm exec playwright install chromium   # once
pnpm test:e2e         # builds, then runs the browser story against a fresh fixture database
pnpm lint && pnpm typecheck && pnpm format
```

- Node 22.12+ and pnpm 10 (pinned in `package.json`). Install dependencies with the frozen lockfile in CI.
- Playwright uses its bundled Chromium by default; set `PW_CHANNEL=chrome` to use a system Chrome instead.
- Put local generated files, such as trace exports, screenshots and scratch output, in `outputs/` at the repository root. It is ignored and never committed. Public assets stay where they are: README images in `docs/assets/`, the app's icons in `src/app/` and the demo's synthetic documents in `fixtures/`.
- Connected checks (`pnpm sandbox:check`, `pnpm llm:check`) need your own Sandbox app or model key in a local `.env`. They are opt-in and never run in CI.
- `pnpm typecheck` generates Next.js route declarations before running TypeScript, so it works in a fresh checkout. `next-env.d.ts` is generated and ignored: development and production use different type paths, and neither should create a source-control change. See the [Next.js TypeScript guidance](https://nextjs.org/docs/app/api-reference/config/typescript).

## Project layout

| Path | Contents |
| --- | --- |
| `src/domain/` | Framework-independent rules: money, time, cancellation reducer, reconciler, workflow, channel claims, approval binding, provider-state merge, claims validation, evidence pack |
| `src/server/` | Configuration, SQLite schema and repositories, services (case, operation ledger, evidence store, snapshot, setup), HTTP guards |
| `src/paypal/` | Provider adapter interface, fixture simulation, Sandbox REST client and adapter, toolkit allowlist, redaction |
| `src/llm/` | Drafter interface, deterministic template, live model adapter |
| `src/graph/` | LangGraph case thread with a durable SQLite checkpointer |
| `src/app/`, `src/components/` | Next.js routes and the buyer/merchant workbench |
| `scripts/` | Root commands |
| `fixtures/` | Committed synthetic fixture (manifest + documents) |
| `tests/` | Vitest unit/integration suites and Playwright acceptance |
| `docs/` | Architecture, test and demo guide, assets |

## Making changes

1. Open an issue or discussion for anything that changes a boundary above.
2. Add or update tests next to the behaviour you change. Acceptance cases are referenced by ID in test names (`CC01`–`CC24`); keep those references accurate.
3. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and, for UI changes, `pnpm test:e2e`.
4. Commit with Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). The pre-commit hook runs `pnpm security:staged`; do not bypass it.
5. Never commit `.env`, data directories, evidence files, logs, recordings or anything matched by `.gitignore`.

## Reporting problems

Bugs and ideas: open a GitHub issue with reproduction steps (fixture mode preferred). Security issues: see [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the Apache License 2.0 that covers this project.
