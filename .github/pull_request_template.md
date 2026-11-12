## What and why

## How it was tested

## Checks

The same gates run in CI on Node 22 and 24.

- [ ] `pnpm security:staged --all`
- [ ] `pnpm deps:audit`
- [ ] `pnpm lint`
- [ ] `pnpm format`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm test:e2e` (builds, then runs the browser acceptance in fixture mode)
- [ ] No credentials, personal data, real Sandbox identifiers or machine paths in the diff
- [ ] Approvals, single dispatch, `UNKNOWN` recovery and role-private evidence behave as before, or the change is explained above
