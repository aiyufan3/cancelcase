# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-12

First public release.

### Added

- A buyer and merchant workbench for one case: the cancellation record with its documents, a deterministic check of each charge against the effective cancellation time, drafts with every statement of fact cited, an approval sheet, requests and results, and the provider case.
- A LangGraph agent that gathers the facts, drafts, pauses for a person, submits the approved request once and reads the result back. Its thread is checkpointed on disk.
- Drafting by a labelled template offline, or by a connected language model through a configurable adapter. The server validates the subject and every claim, including written amounts, dates, times and transaction IDs in the forms it reads, before a draft can be approved; a form it cannot read blocks approval. Letters to the merchant end with the transaction ID of the cited payment record.
- Content-bound, expiring, single-use approvals and an operation ledger. Each write is sent once; an ambiguous result becomes `UNKNOWN` until a read-back and a recorded human decision. A case creation with an unknown result is never recorded as failed and keeps its claim on the charge.
- PayPal Sandbox integration: Subscriptions and Catalog setup, Disputes on the buyer side (with the buyer's consent) and the seller side (evidence), read-back of PayPal's decision, Transaction Search reads, the PayPal Agent Toolkit limited to read tools, and Sandbox test controls labelled as simulations.
- An offline demo with synthetic fixture data, started with `pnpm demo`, and a recording mode that masks real identifiers on screen.
- Optional LangSmith tracing of the agent's graph runs: off by default, refused without its key, and redacted before anything is sent. Errors are sent as one line, without stack traces or file paths.
- Local export of a case as Markdown and JSON. After an approved export, the result lists the approved message, the recipient evidence pack and the selected attachments as downloads, each checked against the hash recorded at approval; the private local archive is a separate download.
- CI on Node 22 and 24: security scan, dependency audit, lint, format, typecheck, unit and integration tests, build and browser acceptance.
- Documentation: README, reviewer guide, architecture, observability, testing and demo guide, Sandbox evidence log, contributing guide, security policy and code of conduct.
