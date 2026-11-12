# Test and demo guide

This guide explains how to verify CancelCase and how to run the demonstration. It distinguishes three kinds of evidence throughout:

- **Fixture results** — produced by the local simulation. They prove the case engine, not the PayPal integration.
- **Connected results** — produced against PayPal Sandbox with your own credentials and read back. Only these count as PayPal verification.
- **Manual steps** — things a person does in a browser (approving a subscription, granting consent, creating a Sandbox case) that the application cannot and does not do for you.

## 1. Automated checks (no credentials)

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm format        # Prettier check
pnpm typecheck
pnpm test          # Vitest: unit (domain rules) + integration (SQLite-backed services)
pnpm build
pnpm test:e2e      # builds, then runs Playwright against a fresh fixture database on 127.0.0.1:3100
pnpm security:staged --all
pnpm deps:audit    # production advisories against the reviewed residual list (needs the npm registry)
```

CI (`.github/workflows/ci.yml`) runs exactly these steps on every push and pull request without any secret, on Node 22 (the version pinned in `.nvmrc`) and on Node 24. Its actions are pinned to commit hashes. Connected checks are never part of CI and are never reported as passed when they did not run.

### Acceptance cases covered by the suites

| Case | What is asserted | Where |
| --- | --- | --- |
| CC01 valid cancellation + later charge | one candidate, reason codes, sources, no write | `tests/unit/reconcile.test.ts`, `tests/integration/approval-operations.test.ts` |
| CC02 unconfirmed or conflicting cancellation | needs review; no executable case; attestation ≠ provider mandate | `reconcile.test.ts`, `approval-operations.test.ts` |
| CC03 time boundaries and offsets | posted-later is not a candidate; equality needs review; offsets compare consistently | `reconcile.test.ts` |
| CC04 association | merchant name alone is not an association; other subscription/account/env no match | `reconcile.test.ts` |
| CC05 statuses, refunds, decimals | pending/failed/reversed/zero/full refund; partial refund cap; exact parsing | `reconcile.test.ts`, `domain-rules.test.ts` |
| CC06 duplicates | reporting rows collapse to one charge; reconciliation is idempotent | `reconcile.test.ts` |
| CC07 channels | concurrent claim blocked; export is not a claim; reviewed escalation works | `domain-rules.test.ts`, `approval-operations.test.ts` |
| CC08 provider observations | no regression on older snapshots; unknown enums disable mutations | `domain-rules.test.ts` |
| CC09 untrusted receipt text | instructions in evidence never become tools, destinations or accepted amounts | `claims.test.ts` |
| CC10 citations, amounts, dates, certainty | invented sources, wrong amounts/dates, absolutes and outcome promises are rejected | `claims.test.ts` |
| CC11 drafting failure | labelled template fallback; never reported as a live run | `graph-and-toolkit.test.ts` |
| CC12 submission without a valid approval | denied with an audit reason; zero writes | `approval-operations.test.ts`, `http-guards.test.ts` |
| CC13 edits after approval | draft edit, new evidence, changed facts or changed attachment bytes invalidate | `approval-operations.test.ts` |
| CC14 concurrent dispatch | one operation, one reservation, no second write | `approval-operations.test.ts`, `graph-and-toolkit.test.ts` |
| CC15 restart and replay | interrupt survives a process restart on disk and resumes; replayed checkpoint repeats no write | `graph-and-toolkit.test.ts` |
| CC16 ambiguous result | `UNKNOWN`, no resend, read-back, human decision; expired lease after a crash | `approval-operations.test.ts` |
| CC17 capability | blocked before any write when the case does not accept evidence | `approval-operations.test.ts`, `sandbox-adapter.test.ts` |
| CC18 provider links | foreign origin/resource/method, http and embedded credentials rejected; redirects refused | `domain-rules.test.ts`, `sandbox-adapter.test.ts` |
| CC19 toolkit allowlist | exactly the read tools; refund/concession tools absent | `graph-and-toolkit.test.ts` |
| CC20 role scoping | buyer-private sources never reach the merchant view, draft, export or model snapshot | `approval-operations.test.ts`, `claims.test.ts`, `http-guards.test.ts`, e2e |
| CC21 evidence files | traversal, spoofed type, oversize, markup, executables, tampered bytes | `approval-operations.test.ts` |
| CC22 HTTP boundary | cross-origin, missing/mismatched CSRF, forged role, wrong host denied; a body that is not JSON answered with 400 and not echoed; GET never dispatches a provider write (it may update local bookkeeping and audit entries) | `http-guards.test.ts` |
| CC23 leakage | secret sentinels, variable names and machine paths absent from responses and exports | `http-guards.test.ts` |
| CC24 deletion and reset | cascade including checkpoints; blocked while in flight; reset refuses Sandbox data | `approval-operations.test.ts`, `scripts/demo-reset.ts` |

The independent engineering audit's reproductions are kept as regression tests. Test names carry the audit's finding numbers; this is what each number stands for:

| Finding | What it was about | Where it is pinned |
| --- | --- | --- |
| AUD01 | a second buyer claim for a charge that already has an open provider case | `tests/integration/claim-uniqueness.test.ts` |
| AUD02 | an unknown submission result must keep blocking channel changes, across restarts | `claim-uniqueness.test.ts` |
| AUD03 | a role-private file attached, cited or sent to the drafter by default | `tests/integration/disclosure.test.ts` |
| AUD04 | a manual cancellation record claiming provider provenance | `tests/integration/provenance.test.ts` |
| AUD05 | a role session or CSRF token issued for an untrusted Host | `tests/integration/http-boundary.test.ts` |
| AUD06 | reads, downloads, exports and health answering an untrusted Host | `http-boundary.test.ts` |
| AUD07 | the merchant view deleting the owner's case | `http-boundary.test.ts` |
| AUD08 | facts and citations that do not trace to a source | `provenance.test.ts` |
| AUD09 | a created provider case losing its reference when the first read-back fails | `tests/integration/connected-recovery.test.ts`, `provider-identity.test.ts` |
| AUD10 | approval issued for content that was not the reviewed version | `tests/integration/review-lifecycle.test.ts` |
| AUD11 | later subscription reads not updating existing charges; payment identity across cases | `connected-recovery.test.ts`, `subscription-lifecycle.test.ts`, `import-integrity.test.ts` |
| AUD12 | an imported case taking payment facts from anything but the provider read | `connected-recovery.test.ts` |
| AUD13 | unsaved visible edits approving or sending an older saved version | `review-lifecycle.test.ts`, `tests/e2e/review-regressions.spec.ts` |

The areas those tests cover:

| Area | What is asserted | Where |
| --- | --- | --- |
| One claim per charge | concurrent prepares, two processes on one database, forged approvals and restarts never open a second claim; unknown results keep blocking; a case creation with an unknown result is never recorded as failed, whatever the read-back listed; schema migration backfills reservations | `tests/integration/claim-uniqueness.test.ts` |
| Model configuration privacy | fictional endpoint, model and key strings never reach drafts, API JSON, pages, exports, audit or check output; sanitized upstream errors; truncated and empty output handled | `tests/integration/model-privacy.test.ts` |
| Disclosure | private sources stay out of drafts, model input and recipient packs unless explicitly included; selection changes need a new approval; the local archive is separate | `tests/integration/disclosure.test.ts` |
| Export downloads | the approved message, pack and selected attachments byte for byte; another role, unselected files, the archive and nested names refused; unchanged by a later draft or the passing of time; changed or missing stored files not served; an export without a record listed as not available; links not followed | `tests/integration/export-download.test.ts`, `tests/e2e/main-path.spec.ts` |
| Draft check coverage | the subject checked like a claim; dollar amounts with a symbol or the word; month names in any case; dates that do not exist, numeric dates, other currencies and non-UTC times block | `tests/unit/draft-validation-coverage.test.ts` |
| Diagnostic labels | a capability is `VERIFIED` only when its result was read; the model check validates as the app does and exits non-zero on a configuration problem | `tests/integration/diagnostic-labels.test.ts` |
| HTTP boundary | untrusted Host on pages and APIs, owner-only deletion, scoped audit, recording-mode masking | `tests/integration/http-boundary.test.ts` |
| Review and approval | approval only for a pending review of the exact saved version; regenerate during review; material changes between approval and dispatch; local-state mismatch after provider success | `tests/integration/review-lifecycle.test.ts`, `tests/e2e/review-regressions.spec.ts` |
| Provenance | manual cancellation cannot claim provider provenance; evidence must belong to the case; untraceable facts and mismatched citations rejected, and never offered to the connected model; truthful adapter labels | `tests/integration/provenance.test.ts` |
| Connected facts and recovery | provider reference kept when the first read-back fails; later payment reads update the charge and invalidate drafts; imports never use the creation time as payment time; unknown refunds stay unknown; buyer preflight; setup stages with failure, unknown, exception and restart at each boundary | `tests/integration/connected-recovery.test.ts` (scripted provider double, fictional data) |
| Import identity and claims | matching/mismatched/missing transaction references; idempotent atomic imports; legacy alias conflicts, claim replacement races, ordered payment enrichment/refunds; import never changes the setup pointer | `tests/integration/import-integrity.test.ts` |
| Subscription payment lifecycle | all initial/later/undated payments, later refunds, deleted or wrong manifest pointers, cancelled mandates with observed history, retained cancellation evidence, occupied adoption and reverse import ordering | `tests/integration/subscription-lifecycle.test.ts` |
| Exact provider submission | one authoritative preread, zero-write capability refusal, one post-write readback, evidence type backed by disclosed proof, full notes with length blocking and rejection preserved | `tests/integration/provider-preflight.test.ts`, `approval-operations.test.ts`, `graph-and-toolkit.test.ts` |
| Provider identity | late observations/failures cannot replace another dispute; new/recovered claim reference survives first readback failure; mismatched fresh merchant read refuses before sending | `tests/integration/provider-identity.test.ts`, `domain-rules.test.ts` |
| Safe next step | neutral merchant subject; provider handoff after submission, renewed evidence requests, unknown/inflight priority; a planned billing after a recorded cancellation is a warning, then a prompt to read payments, and never a claim that a charge happened | `tests/unit/next-step.test.ts`, `claims.test.ts`, fixture browser story |
| One-press preparation | the next-step button takes only reads and drafts and never what belongs to the person (recording, approving, sending, recovery); a run takes each kind of step once, stops after a draft and is bounded; every reported line comes from what the server returned; the step follows the channel and never hides a draft that waits for a decision; a failed last request stays in sight; time spans are never rounded up | `tests/unit/prepare-run.test.ts` |
| Payments read from the app | provider plan recorded beside the cancellation; one case per new payment; a case created before any payment adopts the first one; no manifest needed; failed reads change nothing; buyer view and connected mode only; mutation guards on the route | `tests/integration/connected-recovery.test.ts`, `tests/unit/reconcile.test.ts` |
| Dependency report integrity | registry errors, missing/malformed maps and findings, nonzero empty reports and interrupted processes fail closed | `tests/unit/deps-audit.test.ts` |
| Dependency boundary | residual advisories stay unreachable; LangChain's own tracing switches refused; the tracer's `langsmith` is the direct dependency, loaded on demand | `tests/unit/dependency-boundary.test.ts` |
| Optional tracing | off by default; the switch without a key stops startup; no network call without the key, even with LangChain's switches set; only redacted, named and tagged runs reach the endpoint; errors arrive as one line without a stack trace or file path | `tests/unit/tracing-config.test.ts`, `tests/integration/tracing.test.ts` |
| Readable dates | days in words and UTC times in views and letters; the validator reads written dates and times, accepts the facts' own and rejects others, at the edge of a UTC day too | `tests/unit/readable-dates.test.ts` |
| The refund letter | no claim about replies, the merchant-first context line, the basis in words, and the closing transaction reference from the cited payment record; invented IDs rejected; real IDs masked in recording mode | `tests/unit/letter-copy.test.ts`, `tests/integration/letter-reference.test.ts` |

### Browser acceptance (`tests/e2e/fixture-story.spec.ts`)

1. Fresh fixture start: timeline → record cancellation → candidate → draft → edit → approve → export → reload keeps progress.
2. Escalation to a simulated PayPal case with an ambiguous timeout, read-back and a recorded recovery decision.
3. Merchant view: scoped evidence, blocked capability explained, successful simulated evidence submission; no implied resolution.
4. Rejection, keyboard operation of the role switch, reduced motion, phone-width layout without horizontal overflow; documentation captures.

`tests/e2e/review-regressions.spec.ts` adds: unsaved edits block approval and the exported text is the saved, approved version; the Sandbox return pages never echo their query string; a role switch never silently discards unsaved draft edits.

`tests/e2e/main-path.spec.ts` runs the guide's main path on its own fixture server, so the case is untouched when it starts: open the form, fill it from the fixture email, save, **Prepare my case**, reject one version (nothing is exported), then **Approve and export**. It downloads every listed item in the browser and checks the files: the message against the bytes the export wrote, the pack's audience, the absence of the private note and of the archive, each attachment against the hash shown, the same bytes after a reload and after a later draft version, a phone-width layout, and a 404 for the seller's session. A second test follows steps 4 and 5 of the guide as written: the PayPal channel, one press to draft, the simulated timeout, `UNKNOWN`, read-back and the recorded decision, then the seller's response from the merchant view. It checks that the fixture test control applies to one request only, so the seller's request is not simulated as well.

The suite empties its data directory before a run. `tests/helpers/e2e-data-dir.ts` checks that directory first: it must not be a link, it must lie inside `test-results/` or the system temporary folder, and a custom `CC_E2E_DATA_DIR` must be new, empty or marked as created by the suite. Otherwise the run stops and nothing is deleted (`tests/unit/e2e-data-dir.test.ts`).

Run with the bundled Chromium (`pnpm exec playwright install chromium` once, then `pnpm test:e2e`) or with a system Chrome (`PW_CHANNEL=chrome pnpm test:e2e`).

## 2. Demo script (fixture mode, under three minutes)

1. `pnpm demo` → open the case. Point out the mode pill (*PayPal Sandbox · demo data*), the amount under review (not money recovered), the fact chain and the separate indicators for the local workflow and the provider case.
2. Follow the next step, **Record the cancellation you received** → **Open the form** → fill from the fixture email → save. The fact chain connects, *Needs review* becomes *Candidate: charged after cancellation* and the reason is listed. On a wide screen the **Current step** switch folds the rest of the case file to one line per section; a narrow screen does this by itself and docks the next step at the bottom.
3. Press **Prepare my case** on the next-step card. The card lists what was done (the facts gathered, the draft with its *Template — no model call* label, validation passed) and the page comes to rest on the draft. Show the letter and the sources under each paragraph. Edit a claim → the version increments. Edit an amount to a wrong one → the finding appears under that paragraph and approval is blocked.
4. **Approve and export** → one press records the approval and uses it once. The sheet shows how the request ended and the message says nothing was sent. **Approve this draft** alone starts the 15-minute countdown and leaves **Export approved request** for later.
5. Choose the PayPal channel with a reason → **Prepare my case** → set the fixture control to *simulate ambiguous timeout* → **Approve and submit**. The operation becomes *UNKNOWN*; **Read back** finds the simulated case; record the decision.
6. Switch to the **merchant view**: the buyer's private note is gone, the merchant's billing log is present. **Prepare the response**, then **Approve and submit**; the provider card reads *UNDER REVIEW*, never *RESOLVED*.

The buttons inside each section (**Generate draft**, **Approve this draft**, **Submit approved request**) still take the same steps one at a time; the browser tests use those.

## 3. Connected verification (your Sandbox credentials)

Prerequisites: a PayPal Developer account with a Sandbox REST app (Business) and a Sandbox Personal account for the buyer side. Fill `.env` from `.env.example`; keep `PAYPAL_ENV=sandbox`.

| Step | Command | Kind | What to record |
| --- | --- | --- | --- |
| Capability check | `pnpm sandbox:check` | connected read | granted scopes, each capability's state, the recommended tier; ledger under `data/local/ledger/` |
| Create test objects | `pnpm sandbox:setup --preview` then `--confirm` | connected writes (operator-approved, one per stage) | each stage's status; approval URL for your browser. An unknown stage stops the run: check the Developer Dashboard and record it with `--recover <stage>` |
| Approve the subscription | open the printed URL and log in with the Sandbox Personal account | manual | nothing to record in the repository |
| Read back | `pnpm sandbox:setup --resume` | connected read | subscription status, transactions, the connected case ID |
| Buyer case | if the app has the create scope and consent: approve and submit from the buyer view in `pnpm demo:sandbox`; otherwise create the case in the Sandbox Resolution Center and run `pnpm sandbox:setup --import-dispute <ID>` | connected write **or** manual + connected read | which path was used; the UI labels imported cases |
| Merchant evidence | in `pnpm demo:sandbox`, merchant view → draft → approve → submit; the case must be in `WAITING_FOR_SELLER_RESPONSE` with a `provide-evidence` link | connected write | operation status and the provider status after read-back |
| Live drafting | `pnpm llm:check --config-only`, then `pnpm llm:check` with `LLM_ENABLED=true` | configuration check, then one connected model call with synthetic facts | call count, validation result or error code. The endpoint and model stay in your local configuration and the ignored diagnostics file; they are not recorded in the repository |

### Sandbox setup in detail

1. Create a REST app in the PayPal Developer Dashboard (Sandbox) and copy `.env.example` to `.env`. Fill `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`; keep `PAYPAL_ENV=sandbox`. Live origins are refused.
2. `pnpm sandbox:check` — read-only diagnostic. It issues a token, lists granted scopes, calls one toolkit read tool, performs direct REST reads, checks buyer-path prerequisites and (if `PAYPAL_IMPORT_DISPUTE_ID` is set) a case's evidence capability. Output: a table of `VERIFIED` / `BLOCKED` / `NOT_TESTED` and a redacted ledger under `data/local/ledger/`.
3. `pnpm sandbox:setup --preview`, then `pnpm sandbox:setup --confirm` — records a fixed setup intent, then creates a synthetic product, plan and subscription as three separately recorded writes and prints the buyer approval URL. Re-running continues the same intent and never repeats a stage that succeeded; a stage with an unknown result stops everything until you check the Developer Dashboard and record what you found (`--recover <stage> --resource <ID>` or `--not-created`, with `--note`). Approve the subscription yourself in a browser with a Sandbox Personal account soon after it is created — PayPal drops a subscription nobody approved after a few hours; `pnpm sandbox:setup --replace-subscription` then creates a new one for the same plan, only after a fresh read reports the old one as not found. The return page is not proof of approval. Then run `pnpm sandbox:setup --resume` to read the subscription and its transactions back and create the connected case. Every later payment of the subscription that a read reports becomes its own case on the same subscription, so a cancellation recorded once is checked against each payment. Once a setup is complete, `pnpm sandbox:setup --new-intent --interval DAY --confirm` records a further intent with a daily plan (useful to observe a real payment one day after a recorded cancellation); it is refused while the current setup has a stage to create or settle. Add `--start-in <minutes>` to delay the first billing: the buyer approves and a cancellation can be recorded before any payment exists, and the first payment PayPal reports is then checked against it.
4. `pnpm demo:sandbox` — the same UI against the Sandbox data directory. Every provider write still needs an approval in the UI.

Buyer-side case creation additionally requires the documented `https://uri.paypal.com/services/disputes/create` scope on the app and buyer consent through *Log in with PayPal*: enable it for the Sandbox app with the return URL `<APP_ORIGIN>/sandbox/consent`, then open the link printed by `pnpm sandbox:setup --consent-url` as the Sandbox Personal account and re-run `pnpm sandbox:check`. If that is not available, create the test case manually in the Sandbox Resolution Center and import it with `pnpm sandbox:setup --import-dispute <ID>`; add `--case <caseId>` to select an existing case. The disputed transaction must match that case's payment; missing or mismatched references are refused. Without `--case`, a unique matching payment is reused, and ambiguous matches are refused. The UI identifies the case as manually opened, and importing does not change the setup intent's connected-case pointer.

Two Sandbox test controls stand in for PayPal's own steps on a case under review: `pnpm sandbox:setup --require-evidence --case <caseId>` asks for the seller's evidence again, and `pnpm sandbox:setup --adjudicate --case <caseId> --outcome BUYER_FAVOR|SELLER_FAVOR` settles the case. Each is a labelled test mutation with its own recorded approval; an approval sends exactly one request, and only when a fresh read offers that control. Neither is a case action, and the provider card lists every test control used on a case, labelled as a simulation.

`sandbox:setup --resume` refreshes all known payment cases, including later refunds, and discovers each additional observed payment. The same read is available in the app: in the buyer view of a connected case, **Read payments from PayPal** records the mandate's status and next planned billing beside the cancellation facts and turns each new payment into its own case. When the provider still plans to bill after a recorded cancellation takes effect, the case says so; a plan is shown as a plan, never as a payment. An ended provider mandate does not hide payment history, and a missing payment time stays unknown. A stale or deleted manifest case pointer is recovered from the subscription reference. If an unidentified placeholder might belong to a payment already recorded elsewhere, adoption is blocked and audited rather than merging records or assigning the same sale twice.

Optional live drafting: set `LLM_ENABLED=true`, `LLM_PROVIDER` (the protocol: `anthropic` for the Messages protocol or `openai` for Chat Completions), `LLM_BASE_URL` (your endpoint; there is no default host), `LLM_MODEL` (an identifier your endpoint documents) and `LLM_API_KEY`, then `pnpm llm:check --config-only` (no network) and `pnpm llm:check`. Model settings stay on the server: the UI and exports say *Connected model*, *Template — no model call* or *Human edit*, and precise diagnostics go only to an ignored local file. Fixture mode never calls a model even when a key is present.

The connected tier reached is reported in the capability table of the README once these runs exist. Buyer-side creation depends on account configuration (create scope and consent) that the project cannot grant; without it the honest result is tier B (manual buyer case, connected merchant handling) or tier C (connected read and export).

## 4. Status of verification in this repository

Fixture suites pass in this repository (`pnpm test`: unit and integration; `pnpm test:e2e`: browser scenarios including the review regressions and the Sandbox return pages), together with lint, format, typecheck, build, the tracked-file scan and `pnpm deps:audit`. An earlier revision was also verified on a native macOS install (frozen install, native SQLite module, tests, browser scenarios, build), and the same gates pass in a clean clone under Node 24.

Connected records retain the runs of 2026-11-09 New York time. A native recheck on 2026-11-10 at 05:16 UTC ran `pnpm sandbox:check` and `pnpm llm:check`; it did not repeat setup, cancellation, buyer creation or merchant submission writes.

A further connected session on 2026-11-10 (07:30 to 11:46 UTC) exercised four things on Sandbox: a subscription with a delayed first billing, PayPal's evidence-request simulation, a merchant evidence submission with attached files and a model-drafted text, and the payments read from the app. The session's in-app actions (recording the cancellation, the approval, the submission and its read-back) are in the private operation and audit ledger rather than in separate files.

Later the same day (13:42 to 19:15 UTC) Sandbox collected the delayed first payment, and the buyer path was exercised on it: the waiting case recorded the payment as a candidate, a one-press run drafted the PayPal case with the connected model, and an approved request was sent. PayPal refused the first request over the form of the cancellation date and created nothing; the second, with the same instant written with milliseconds, opened the case. PayPal then asked the seller for evidence by itself, and the seller's response was sent from the merchant view and read back `UNDER_REVIEW`. A read at 2026-11-11 02:08 UTC found the case `RESOLVED` with the outcome `RESOLVED_SELLER_FAVOUR`; no test control had been used on it. The same read showed the imported case still `UNDER_REVIEW`, with PayPal offering its settlement test control. Every call of this story, with times and results, is in [sandbox-evidence.md](sandbox-evidence.md).

On 2026-11-12 (04:10 to 04:27 UTC) the read-back of a refund was observed on Sandbox for the first time: the subscription's next payment was read as its own candidate case, the maintainer refunded that payment as the Sandbox seller in PayPal's own pages, and the next read from the app showed it `REFUNDED` and counted $19.99 as recovered. CancelCase sent PayPal no request in that session; the list is in `docs/sandbox-evidence.md`, section 3.

The operator keeps these evidence files under ignored `data/local/ledger/` (no credentials or private model configuration in the public record):

| Evidence file | Date (UTC) | Observed result |
| --- | --- | --- |
| `sandbox-check-2026-11-10T05-16-24-791Z.json` | 2026-11-10 05:16 | auth, toolkit/list reads, Transaction Search, create scope and buyer assertion reads succeeded; current case's merchant evidence capability blocked |
| `llm-check-2026-11-10T05-16-23-999Z.json` | 2026-11-10 05:16 | one real call on synthetic facts, origin `live_model`, validation passed, no issues |
| `sandbox-setup-2026-11-09T18-33-54-825Z.json` | 2026-11-09 18:33 | historical setup stage writes |
| `sandbox-resume-2026-11-10T01-05-05-994Z.json` | 2026-11-10 01:05 | historical approved subscription, ACTIVE and payment readback |
| `sandbox-import-2026-11-10T02-06-43-274Z.json` | 2026-11-10 02:06 | historical manually opened case import |
| `sandbox-check-2026-11-10T02-55-53-839Z.json` | 2026-11-10 02:55 | historical post-consent buyer assertion read |
| `sandbox-setup-2026-11-10T07-32-20-144Z.json` | 2026-11-10 07:32 | delayed-start intent: product, plan and subscription created, one request each; first billing requested for 09:31 UTC |
| `sandbox-require-evidence-2026-11-10T07-35-51-769Z.json` | 2026-11-10 07:35 | evidence-request simulation accepted; the read straight after still showed `UNDER_REVIEW` |
| `sandbox-resume-2026-11-10T07-39-45-813Z.json` | 2026-11-10 07:39 | delayed-start subscription approved in the browser and read back `ACTIVE` with no payment; the case waiting for its first payment was created |
| `sandbox-resume-2026-11-10T11-46-52-655Z.json` | 2026-11-10 11:46 | the same subscription still `ACTIVE` with no payment listed, 1 h 46 min after the billing PayPal had listed for 10:00 UTC |
| `sandbox-resume-2026-11-10T13-42-50-077Z.json` | 2026-11-10 13:42 | still no payment listed, 3 h 42 min after the listed time |
| `sandbox-resume-2026-11-10T18-20-10-195Z.json` | 2026-11-10 18:20 | one `COMPLETED` payment of 19.99 USD at 16:31:47 UTC, 6 h 31 min after the listed time; the waiting case adopted it; next billing listed for 2026-11-11 10:00 UTC |

The merchant write's historical approval, operation and readback remain in the private operation/audit ledger (2026-11-10 02:25 UTC). Public descriptions below distinguish those historical writes from the latest read-only checks.

| Capability | Connected state | Notes |
| --- | --- | --- |
| Merchant auth | VERIFIED | token issued; scopes listed |
| Toolkit read call (`list_disputes`) | VERIFIED | allowlist also asserted offline |
| Dispute, plan and product list reads | VERIFIED | |
| Transaction Search | VERIFIED | 2026-11-10 05:16 UTC: reporting read succeeded after earlier 403 responses; automatic reporting-based discovery is not implemented |
| Buyer create scope | VERIFIED (present) | consent and assertion still required |
| Buyer consent and assertion (read probe) | VERIFIED | before consent: HTTP 400 `No permissions to set target_client_id`; after the Sandbox Personal account consented through *Log in with PayPal* (`pnpm sandbox:setup --consent-url`), the read with `PayPal-Auth-Assertion` returned 2xx |
| Buyer case creation | VERIFIED | on the payment above (initiated 8 h 48 min after the recorded cancellation took effect). The buyer-side transaction reference was recorded by the operator, and a one-press run drafted the request (connected model, three cited facts, validation passed). First request, 2026-11-10 18:58 UTC: one approved request with the buyer assertion; PayPal answered HTTP 400, name `INVALID_REQUEST`, issue `INVALID_CANCELLATION_DATE`, with no field or description; the operation is `FAILED` after one attempt, the claim was released and nothing was created. The date had been sent as `2026-11-10T07:43:01Z`, which matches the date-time format in PayPal's published schema. Second request, 19:15 UTC, after a new draft version and a new approval: the same instant sent as `2026-11-10T07:43:01.000Z`; one request, accepted; read back `OPEN`, stage `CHARGEBACK`, reason `CANCELED_RECURRING_BILLING`. The only intended difference between the two requests was the form of the date; the draft text was regenerated in between. A read at 19:20 UTC showed `WAITING_FOR_SELLER_RESPONSE` with a response deadline and the requested evidence types `PROOF_OF_REFUND` and `OTHER`, without the evidence-request simulation. PayPal decided the case later without any test control: read 2026-11-11 02:08 UTC, `RESOLVED`, outcome `RESOLVED_SELLER_FAVOUR`. CancelCase reports the decision as read |
| Delayed first billing (`--new-intent --start-in`) | VERIFIED | three recorded writes, buyer approval in the browser, `ACTIVE` read-back with no payment, a case waiting for its first payment, a cancellation recorded before any payment existed. Sandbox collected the payment 6 h 31 min after the time it had listed; the waiting case adopted it and the check classified it as a candidate, charged after the cancellation |
| Payments and billing plan read from the app | VERIFIED | the mandate status and PayPal's planned billing were recorded beside the cancellation on two subscriptions, and the case said that a billing was still planned after the cancellation. The payments read reported that PayPal lists none while none existed (13:49 UTC) and, after the payment, that the one payment already has its case (19:09 UTC). The read that first recorded the payment was `sandbox:setup --resume`, not the in-app button |
| Evidence-request simulation (`--require-evidence`) | VERIFIED | sent once after a fresh read offered it; accepted. The read straight after still showed `UNDER_REVIEW`; a read ten minutes later showed `WAITING_FOR_SELLER_RESPONSE` with a response deadline, requested evidence types and the `provide_evidence` action |
| Settlement simulation (`--adjudicate`) | NOT_TESTED (offered) | implemented and covered by synthetic regressions; PayPal listed the `adjudicate` link on the imported case at the 2026-11-11 02:08 UTC read; not sent yet |
| Subscription setup writes (product, plan, subscription) | VERIFIED | one recorded request each, confirmed by the operator; read back as `APPROVAL_PENDING` |
| Buyer approval / `ACTIVE` read-back / connected case | VERIFIED | approved in the browser with the Sandbox Personal account; read back `ACTIVE` with one `COMPLETED` payment; the connected case uses that payment's time, amount and refund state. The first subscription was not approved within a few hours and PayPal dropped it; `--replace-subscription` created the replacement |
| Single dispute read-back / manual case import | VERIFIED (historical run) | the manually opened case was read and imported. Current identity matching, atomicity, idempotency and claim conflict fixes are covered by synthetic regressions; those modified import paths have not been rerun in Sandbox |
| Merchant evidence submission | VERIFIED (three runs) | first run: one approved template response (type `OTHER`, notes only) sent after a re-read; read back `UNDER_REVIEW`; the toolkit read agreed. Second run (2026-11-10 07:57 UTC, after the simulation reopened the case): a model-drafted response that passed validation, with a PDF and a PNG attached, one of them a private document explicitly disclosed for that version; one request, accepted, read back `UNDER_REVIEW`, toolkit read agreed. PayPal's own listing of the two uploaded documents was not read back. Third run (2026-11-10 19:22 UTC, on the case opened through the API): a one-press run drafted the response from the merchant view (connected model, four cited facts, validation passed, type `OTHER`, notes only); one request, accepted, read back `UNDER_REVIEW`. Nothing about the outcome is implied |
| Refund read-back | VERIFIED (one run) | 2026-11-12: the subscription's second payment was read as its own candidate case; the maintainer refunded it as the Sandbox seller in PayPal's own pages; the next read from the app showed it `REFUNDED` and counted $19.99 as recovered. CancelCase sent no request. Until then this path had run only against test doubles |
| Live model drafting | VERIFIED | native check: synthetic facts, one call, structured output, validation passed, private sources withheld. In the app on 2026-11-10, on the snapshot of a real Sandbox case: the first draft stated a fact that had no source and the validator blocked it; after the fix that offers the model only facts it can cite, the following drafts passed validation and one was approved and sent. Configured-output rejection and opaque-key redaction have additional synthetic regression coverage; selected service/model remain private |

Connected reads, the full subscription setup (writes, buyer approval, `ACTIVE` read-back, connected case), a delayed first billing through to a real payment after a recorded cancellation, the read-back and import of a manually created case, the evidence-request simulation, three merchant evidence submissions (one with attached files, two with a model-drafted text) and model drafting are verified. Buyer consent, the assertion and buyer case creation are verified: one case was opened through the API for a real payment made after a recorded cancellation, and the seller answered it through the API after PayPal asked for evidence.
