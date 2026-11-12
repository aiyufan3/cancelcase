# CancelCase architecture

This document describes the system as implemented in this repository. It is written for reviewers and contributors; the README covers usage.

## 1. Shape of the system

CancelCase is one Next.js application with a Node server, bound to `127.0.0.1`. Business logic lives in framework-independent TypeScript modules; the web layer is thin. Storage is local: a SQLite database for business records, a second SQLite file for LangGraph checkpoints, and a directory of evidence files, all under `data/local/<mode>/`.

Two modes share every rule, screen and persistence path:

- **Fixture mode** (`APP_MODE=fixture`, the default): a local provider simulation and a deterministic template drafter. No credentials are read; no network calls are made. Every record carries `synthetic` provenance.
- **Sandbox mode** (`APP_MODE=sandbox`): a PayPal Sandbox REST adapter and, optionally, a live model drafter. Credentials and model settings come from a local `.env`, server-side only. Live PayPal origins are refused. LangChain's own tracing switches are refused at startup; optional LangSmith tracing of the graph goes only through CancelCase's redacting tracer ([observability.md](observability.md)).

```
src/domain      pure rules (no I/O)
src/server      config, SQLite, services, HTTP guards
src/paypal      adapter interface, fixture simulation, Sandbox REST + toolkit allowlist
src/llm         drafter interface, template drafter, live model adapter
src/graph       LangGraph case thread + durable checkpointer
src/app         Next.js routes (API + pages)
src/components  buyer/merchant workbench
scripts         root commands
```

## 2. Three facts that never merge

The design keeps three things separate because conflating them produces false confidence:

| Fact | Where it lives | Who can change it |
| --- | --- | --- |
| **Cancellation record** — request time, confirmation arrival, effective time, basis, evidence | `subscriptions.cancellation_json`, reduced by `src/domain/cancellation.ts` | The buyer, by recording; a provider mandate observation (status and next planned billing) is stored beside it, never merged |
| **Local case workflow** — what this application has done for one role (`FLAGGED → DRAFTING → READY_FOR_REVIEW → AWAITING_APPROVAL → EXECUTING → SYNCED`, plus `REJECTED`, `BLOCKED`, `UNKNOWN`) | `dispute_cases.buyer_state` / `merchant_state`, `src/domain/workflow.ts` | The services, through explicit transitions |
| **Provider observation** — status, stage, outcome, deadline, requested evidence, allowed actions, observed time | `dispute_cases.provider_observation_json`, merged by `src/domain/provider-state.ts` | Read-back only; older snapshots never overwrite newer ones |

The UI shows all three with their provenance (`synthetic fixture`, `Sandbox API observation`, `user attestation`). Only a verified refund counts as money recovered; otherwise the amount is shown as *under review*.

## 3. Reconciliation

`reconcile(subscription, charge)` in `src/domain/reconcile.ts` is a pure function that returns `{ classification, reasonCodes, sourceIds, claimableCents, facts }`.

Order of checks: environment and account identity → association method (merchant name alone is never enough) → cancellation confirmed with an effective time → USD and a known amount → charge status (pending, failed, reversed, refunded) → event time strictly later than the effective time (equality and missing or offset-less timestamps go to review; a late posting time does not make an earlier charge a candidate) → arrears and service-period context → refund state (unknown blocks a payable amount; partial refunds cap it).

`CANDIDATE_AFTER_CANCEL` is a reviewable anomaly, not a conclusion. Duplicate reporting rows are collapsed by provider reference before they reach the reconciler.

Payment identity compares seller transaction IDs with subscription sale IDs and separately tracks buyer transaction IDs, scoped to environment and account. Provider records can explicitly link those aliases; subscription names, amounts and order IDs do not identify a payment. Legacy duplicate local records are preserved, but reservations treat their linked aliases as one payment.

## 4. Evidence and role scoping

Evidence records carry an owner role, a visibility (`private` or `shared`), a provenance, a content hash and normalized facts. `buildRoleSnapshot` (`src/server/services/snapshot.ts`) produces an immutable, role-filtered snapshot: sources the role may see, facts carried by those sources, system facts (charge, subscription, provider case) with only the visible source references, visible contact history, and explicit gaps. The snapshot version is bumped on every material change (evidence added, cancellation recorded, amount changed, provider state changed), which invalidates open approvals.

Files are limited to PDF, PNG, JPEG and UTF-8 text; bytes are sniffed, names are rejected when they contain separators or traversal, markup and executables are refused, storage names are generated, and downloads go through validated IDs with `nosniff`, `attachment` and a sandboxed CSP. Product ceilings (5 MB per file, 5 files and 20 MB per submission) are deliberately stricter than any provider maximum and are not claims about PayPal's limits. A provider evidence response attaches only PDF, PNG and JPEG files, the types PayPal accepts; text files stay citable sources and part of the export. The response is labelled `OTHER` unless it carries the stated proof for a specific type, because a type the evidence does not carry would be a false statement to the reviewer: `CANCELLATION_DETAILS` only when the response cites disclosed cancellation records, and never `PROOF_OF_REFUND` in this version, because the application does not record or send the refund reference that type is expected to name. A refund a provider read showed is stated in the notes.

The evidence pack has six sections — case context, cancellation timeline, charge and provider facts, contact history and gaps, requested remedy, source manifest — and is exported as JSON and Markdown per role. Empty sections stay empty.

Outward disclosure is explicit. A draft, a model call, a provider submission and the recipient pack see the *outward snapshot*: shared sources plus the role's private sources the person explicitly included for that draft version. Changing the selection or the attachments creates a new version that needs a new approval. The export writes the recipient files (message, pack JSON, pack Markdown) separately from a clearly labelled local archive of the full role view, which is not meant to be sent.

The export operation records each recipient file and each approved attachment with its hash and size, and the result lists them as downloads (`GET /api/operations/<id>/export`, one item per request). A download is served only to the role that made the export, only for an item that export recorded, and only when the stored bytes still match the recorded hash; the message is also compared with the approved text, and the attachment list with the hashes the approval was bound to. Nothing is rebuilt from the current draft: a later version, a consumed or expired approval and the passing of time change nothing, and a missing or changed file is reported as not available. The local archive and files that were not selected are not reachable through this route.

Every fact keeps where it came from. System facts derived from a provider read cite an observation source (`obs_charge_*`, `obs_subscription_*`, `obs_case_*`); a cancellation recorded by a person can only be a user attestation or a merchant confirmation document backed by a matching evidence record of the same case, and a provider mandate is stored only from a provider read-back.

Cancellation records and the documents they retain are subscription-scoped. Only evidence retained by the cancellation reducer is promoted; an ignored event cannot expand disclosure. A retained source changing scope invalidates affected sibling snapshots and approvals even if the cancellation's values did not change.

## 5. Drafting and validation

A drafter receives the snapshot and returns `claims[]`, each with `text`, `source_ids` and `fact_ids`. Two implementations exist:

- `FixtureDrafter`: deterministic template built from the snapshot; labelled *Template — no model call*, zero model calls.
- `LiveDrafter`: a configured endpoint speaking the Messages or the Chat Completions protocol (`LLM_PROVIDER` selects the protocol, `LLM_BASE_URL` the endpoint, `LLM_MODEL` the identifier; there is no default host or model). The model receives the outward snapshot as JSON data, with only the facts that trace to a source in it (a fact nothing backs is not offered, because the validator would refuse any claim built on it), and a system prompt that forbids invention, outcome promises and instruction-following from evidence text. A malformed response may receive one bounded repair call. Truncated or empty output is not repaired: the call fails safely. In each failing case the service falls back to the labelled template and records the failure.

Model configuration never leaves the server. Drafts, API responses, server-rendered pages, exports and audit details carry only a neutral origin (*Connected model*, *Template — no model call*, *Human edit*) and the call count; upstream errors are reduced to a sanitized code and message, and precise diagnostics are appended to an ignored local file (`<DATA_DIR>/<mode>/diagnostics/model-calls.jsonl`).

`validateDraft` (`src/domain/claims.ts`) checks schema, role scope, disclosure scope, source and fact existence, required facts per action, that every amount and date in a claim belongs to a fact it cites (an untraceable fact or a citation that does not carry the figure is rejected), unsupported certainty ("guarantee", "fraud", "entitled to"), outcome promises and contradictions with refund facts. The subject is checked like a claim, against all the facts the draft cites. The check reads a limited set of written forms: US dollar amounts with a symbol or the word (`$19.99`, `USD 19.99`, `19.99 dollars`), ISO dates and instants, and dates in words with a month name. Times are compared in UTC to the minute, and to the second when seconds are written. A form it cannot verify blocks approval instead of passing: another currency, an amount with other than two decimals, a numeric date such as `11/08/2026`, a date that does not exist, or a time in another zone. A bare number without a currency is not treated as an amount. Generated drafts and human edits pass through the same function. A valid citation does not prove that a paraphrase follows from its source; human review remains part of the flow, and approval is impossible while blocking issues exist.

## 6. Approval and the operation ledger

Readiness is computed on the server (`src/server/services/readiness.ts`) for generate, approve and submit, with a reason for every blocker (no reviewed candidate, wrong channel, an open or unresolved claim on the charge, no provider case, no valid or current draft, no pending review, blocked capability, expired, revoked or used approval). The UI only shows those reasons; it never decides on its own.

An approval (`src/domain/approval.ts`) binds actor, role, environment, account alias, resource, action, canonical payload hash, payload version, evidence snapshot version and sorted attachment hashes, and expires 15 minutes after the decision. It can only be given while a review is pending, and only for the exact saved version the person sees (the request carries that version's content hash). A separate material fingerprint (channel, claimable and requested amounts, charge status, amount, refund state and time, cancellation state and basis, provider status/stage/actions/deadline, snapshot version) is compared again at prepare time and twice at dispatch time; a refresh timestamp alone changes nothing, a material change revokes.

One claim per payment. `claim_reservations` holds at most one row per local charge, and an immediate transaction checks reservations across canonical provider aliases before insertion. `prepareOperation` reserves the claim with the operation and consumes the approval atomically, so legacy duplicate charge IDs, two tabs, two processes or a forged approval cannot open a second external claim. A definitive provider failure releases it, success turns it into an open claim, an unknown result keeps it, and only a provider-reported resolution or a recorded recovery decision with read-back evidence releases it later. Resolution compares the full observed reservation identity in a transaction, preserving any newer replacement claim. Channel transfer is refused while anything is in flight or a claim is open.

`dispatchOperation` acquires the single `DISPATCHING` reservation with a lease, re-verifies the approval, the latest draft, the material facts and the attachment bytes, re-reads provider state for provider writes and checks the capability (`WAITING_FOR_SELLER_RESPONSE` + validated `provide-evidence` link + deadline for merchant evidence). For a connected buyer request it re-reads the subscription transaction first: a read failure or a missing reference blocks the request, and changed payment facts are applied so the final check stops it. Then it calls the adapter exactly once.

Outcomes: `SUCCEEDED`, `FAILED` (definitive 4xx-class errors, blocked capability, changed facts) or `UNKNOWN` (timeouts, lost responses, 5xx on writes, an expired lease after a crash). The provider result is persisted first; a local workflow state that no longer allows the transition is recorded on the operation instead of turning a provider success into an error. A successful case creation also saves a minimal provider reference (version 0, stale) in the same transaction, so a failed first read-back is recovered with Refresh and never by creating the case again. `UNKNOWN` is never resent. Read-back gathers evidence (a matching case created after the operation, a changed status or evidence count) and a human records `confirmed_succeeded` (with the provider case ID), `confirmed_failed` or `needs_manual_review`, with a note. A case creation is never recorded as `confirmed_failed`: a failed read, a partial page and even a complete empty list do not prove that the provider created no case, and releasing the claim could open a second case for the same charge. It stays `UNKNOWN`, with its claim, until a case is found. The list read reports the provider's own total and whether the page is complete; it does not follow further pages.

`PayPal-Request-Id` is sent only for endpoints documented to support it (subscription setup). Everywhere else, local uniqueness plus conservative recovery is the guarantee; the project does not claim exactly-once delivery.

The provider note is the complete approved rendered message. Notes above 2,000 characters block approval, prepare and dispatch instead of being silently cut; rejection and editing remain available. A cancellation evidence type requires confirmed, disclosed and cited cancellation proof, not merely a requested type. The dispatcher owns the authoritative evidence preread and final binding check; the adapter does not insert another asynchronous preread afterward.

The cancellation time in a buyer case request is sent as the recorded instant in UTC with milliseconds. Sandbox refused the same instant written in whole seconds (`INVALID_CANCELLATION_DATE`), although its published schema makes fractional seconds optional.

## 7. LangGraph thread

Each (case, role, action) has a LangGraph thread persisted with `SqliteSaver` in `graph.sqlite`: `gather → draft → review ⏸ → execute → readback`. The `review` node contains only the `interrupt()`, so re-executing it on resume has no side effects. `execute` calls the ledger, which is idempotent, so a replayed checkpoint (time travel) cannot repeat an external write. Checkpoints and business records are distinct; recovery reconciles them through the ledger, never through graph replay. Case deletion removes the thread checkpoints together with the case.

Dispatch performs and stores one post-write readback. The graph's readback node projects that stored observation rather than calling the provider again; a failed read is retried through the explicit Refresh action. A successful new or recovered claim replaces an earlier closed dispute's reference before readback. Late responses or failures for the earlier resource cannot overwrite or stale its replacement.

The page drives the thread from one place. The next-step card derives a single step from the server's state (operations, the cancellation record, the classification, readiness). Where that step is a read or a draft, its button takes it: it calls the routes the section buttons call (the payments read, the provider refresh, the thread start), goes on while the following step is again a read or a draft, takes each kind at most once and at most three in a row, and stops at the review interrupt. The card lists what each call returned. Approving and resuming the thread stay on the approval sheet, where one press records the approval for the version on screen and then resumes the thread with it; those are the two calls the separate buttons make, in the same order.

## 8. Providers

`ProviderAdapter` (`src/paypal/adapter.ts`) defines reads (dispute, disputes list, subscription, subscription transactions) and writes (buyer dispute creation, evidence submission, catalog product, billing plan and subscription creation, subscription cancellation). Writes return `succeeded`, `failed` or `unknown`; each write method makes exactly one request.

Payment facts come only from provider reads (`src/server/services/charge-sync.ts`): the payment time is the transaction time, never a local creation or import time; an unrecognised status stays `UNKNOWN`; a refund amount is known only when the status states it (`COMPLETED` → nothing refunded, `REFUNDED` → fully refunded), so a partial refund without an amount stays unknown. A later subscription read updates the existing charge (adopting a payment observed after the case was created) and moves the evidence snapshot forward.

Sandbox setup (`src/server/services/setup-service.ts`) records a fixed intent — the preview, including a subscription `custom_id` derived from the intent — before the first write, then runs product, plan and subscription as separate ledger operations keyed by intent, stage and attempt, with a manifest checkpoint after each. Succeeded stages are never repeated, rejected stages retry as a new attempt, and an unknown or in-flight stage stops the run until the operator records what the Developer Dashboard shows. The ledger is the source of truth: a missing manifest is rebuilt from it, from the latest intent. A further intent (for example a daily plan) can be recorded only when every stage of the current one has succeeded and nothing is in flight or unknown; the completed manifest is archived beside it. A delayed-start intent records only the delay: each subscription attempt fixes its own first-billing instant in the approved stage payload, sends exactly that value, and is refused locally once the instant is no longer ahead, so a retry is a new attempt with a later instant. Each payment a subscription read reports gets its own charge and case on the same subscription record, never merged into an earlier charge; documents cited by the subscription's cancellation are scoped to the subscription, so every one of those cases sees them, recording a cancellation reconciles all of them, and deleting one case keeps what the others still use. The PayPal return and cancel URLs land on static pages that drop the query string and state that a return is not proof of approval. Three labelled Sandbox test mutations exist beside the setup stages: cancelling the test subscription; PayPal's evidence-request simulation, which moves a case under review back to waiting for the seller; and PayPal's settlement simulation, which resolves a case under review in the buyer's or the seller's favour. Each is its own ledger operation with a recorded operator approval and exactly one request; a simulation is sent only when a fresh read lists that capability, is never repeated while an attempt is unsettled, and is not a case action. The case view lists the simulations used on a case, and a decision that followed one is labelled as a simulation.

`SandboxAdapter` uses `PayPalRestClient`: Sandbox origins only, client-credentials token cached in memory, bounded retries with backoff for reads, no automatic retries for writes, redirects refused, errors reduced to a safe code, a redacted message and the `PayPal-Debug-Id`. Action links from dispute responses are validated against the origin, path and resource before they become capabilities. Synthetic references are refused before any call.

Every subscription resume refreshes each known payment's status and refund facts, then discovers unrecorded payments, including undated transactions. The buyer view offers the same read per case, without the setup manifest: it reads the payments first, then the mandate, and a failed read changes nothing. When the mandate is observed as active and its next planned billing is after a confirmed cancellation takes effect, the view shows both facts side by side as a billing watch; it infers no payment, and only a provider read can add one. An ended mandate does not suppress observed payment history; only an active subscription may create a pre-payment placeholder. Stale manifest pointers are resolved through the provider subscription reference. Adoption refuses a sale already represented by another charge, preserving an unresolved placeholder and audit reason rather than merging data. Initial and later discovery also reject imported-payment alias conflicts atomically.

Manual dispute import reads the provider once, checks transaction/environment/account identity and reuses a unique existing payment/case or refuses ambiguity. Re-import is idempotent, updates ordered provider payment facts conservatively, and preserves refunds against payable regressions. References, manual origin, claim registration, reconciliation and observation invalidation commit in one transaction. Import never changes the subscription setup manifest's connected-case pointer. Existing runtime duplicates are not deleted or silently merged.

The Agent Toolkit is configured with a read-only allowlist (`disputes.list/get`, `transactions.list`, `subscriptions.show`, `subscriptionPlans.list/show`, `products.list/show`), and the exposed tool names are asserted against the installed package. `disputes.create` would enable `accept_dispute_claim` and is kept off; `create_refund` and every unrelated tool stay disabled. Approved writes go through deterministic server code, never through model tool execution.

`FixtureAdapter` simulates the provider with a small JSON state file so that a "write whose response was lost" can still be found by read-back, which is what the recovery flow needs. It never performs network I/O.

## 9. HTTP boundary

Every request, pages included, passes a trusted-Host check in `src/proxy.ts` (the configured loopback host and its loopback alias on the same port); API handlers check it again. Mutations are `POST` only and require a trusted `Host`, a double-submit CSRF token and a valid, HMAC-signed role cookie whose secret is generated into the data directory. A supplied `Origin` must be trusted and match `Host`; without one, a cross-site `Sec-Fetch-Site` is refused. Scripted clients may omit these browser headers but still need the trusted Host, CSRF token and signed role cookie. Whole-case deletion is owner-only in both the route and the service. The audit view shows a role its own entries plus shared system events, and recording mode masks real provider identifiers that were entered by hand. The role switch is a local demonstration convenience, not authentication. Read routes never dispatch provider writes. They may update local bookkeeping: opening a case marks an expired dispatch lease as `UNKNOWN`, and a download writes an audit entry. Case views are built server-side for the current role so the private-evidence filter runs once. Security headers (`nosniff`, `DENY` framing, no referrer) are set globally.

## 10. Recovery after restart

On startup and before listing operations, any `DISPATCHING` operation whose lease expired becomes `UNKNOWN` with reason `LEASE_EXPIRED`, and a `PREPARED` operation whose approval expired fails as `NEVER_DISPATCHED` and frees its claim reservation. Nothing is resent. The UI shows the uncertainty and offers read-back and a recovery decision. Case deletion and fixture reset are refused while an operation is executing or unknown.

## 11. What this architecture does not do

It does not cancel subscriptions, adjudicate disputes, move money, send email, listen for webhooks, read inboxes or bank accounts, or run as a hosted service. Those are either explicit roadmap items or deliberately outside the product boundary.
