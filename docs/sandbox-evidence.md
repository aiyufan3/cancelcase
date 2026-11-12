# Sandbox evidence

A redacted record of the calls CancelCase made to **PayPal Sandbox** with the maintainer's own Sandbox app. It is taken from the private operation ledger and audit log, which are not committed. Times are UTC. Identifiers are left out; `debug` is the `PayPal-Debug-Id` response header, shortened. Fixture runs are not listed: they never call PayPal.

- **Write**: a request that changes something at PayPal. Each one has a person's approval and a ledger operation, and is sent once.
- **Read**: a read-back. Statuses below are what PayPal returned, not what CancelCase expected.
- **Manual**: a step a person took outside the app.

## 1. Charged after a recorded cancellation: the whole loop

A daily Sandbox subscription with a first billing set in the future, so that a cancellation could be recorded before any payment existed.

| Time (UTC) | Kind | What happened | Result |
| --- | --- | --- | --- |
| 2026-11-10 07:32:17–07:32:20 | Write ×3 | `POST /v1/catalogs/products`, `POST /v1/billing/plans`, `POST /v1/billing/subscriptions` with a start time in the future | Each succeeded on its only attempt (debug `f921…f727`, `f637…e41e`, `f637…b59e`) |
| Before 07:39 | Manual | The subscription was approved in the browser with the Sandbox Personal account | — |
| 07:39 | Read | Subscription `ACTIVE`, no payment | A case was opened to wait for its first payment |
| 07:44:18 | Manual | Cancellation recorded: takes effect 07:43:01, proved by a merchant confirmation document (a Sandbox test document) | The check: nothing to compare yet |
| 07:44:33 | Read | Payment mandate `ACTIVE`, next billing listed for 10:00 | The case warned that a billing was still planned after the cancellation |
| 11:01 and 13:49 | Read | Payments | None listed |
| 16:31:47 | PayPal | PayPal collected 19.99 USD, `COMPLETED` (PayPal's own time, 6 h 31 min after the time it had listed) | — |
| 18:20:10 | Read | Payments | The waiting case recorded the payment. The check: *candidate, charged after cancellation*, initiated 8 h 48 min after the cancellation took effect |
| 18:26 | Manual | The buyer-side transaction reference was read in the Sandbox Personal account and recorded as an operator attestation | — |
| 18:58:40 | Write | `POST /v1/customer/disputes` with `PayPal-Auth-Assertion`, reason `CANCELED_RECURRING_BILLING`; text drafted by the connected model, validated, approved | **Refused:** HTTP 400 `INVALID_REQUEST`, issue `INVALID_CANCELLATION_DATE` (debug `ca58…db95`). Recorded as failed after one attempt, not resent; nothing was created |
| 19:15:10 | Write | The same endpoint after a new draft version and a new approval; the cancellation time written with milliseconds | Succeeded on its only attempt (debug `f630…40bd`). Read 19:15:15: `OPEN`, stage `CHARGEBACK` |
| 19:20:55 | Read | The case | `WAITING_FOR_SELLER_RESPONSE`: PayPal asked the seller for evidence by itself; no simulation was used |
| 19:22:00 | Write | `POST /v1/customer/disputes/{id}/provide-evidence` from the merchant view: evidence type `OTHER`, notes only, drafted by the connected model, validated, approved | Succeeded on its only attempt (debug `f259…c1fc`). Read 19:22:05: `UNDER_REVIEW` |
| 2026-11-11 02:08:21 | Read | The case | `RESOLVED`, outcome `RESOLVED_SELLER_FAVOUR`. No Sandbox test control was used on this case. When PayPal changed the status between the two reads is not known |

## 2. A case opened by hand, answered through the API

The Sandbox buyer opened this case in PayPal's Resolution Center (reason `CREDIT_NOT_PROCESSED`). CancelCase imported it and answered it from the merchant view.

| Time (UTC) | Kind | What happened | Result |
| --- | --- | --- | --- |
| 2026-11-10 02:06:43 | Read | `pnpm sandbox:setup --import-dispute` | `WAITING_FOR_SELLER_RESPONSE`, stage `CHARGEBACK`; imported |
| 02:25:36 | Write | `provide-evidence`: template text, type `OTHER`, notes only | Succeeded on its only attempt (debug `f961…4499`). Read 02:25:43: `UNDER_REVIEW` |
| 07:35:48 | Write, Sandbox test control | `POST /v1/customer/disputes/{id}/require-evidence` with `SELLER_EVIDENCE`, sent only after a fresh read offered it. This is PayPal's Sandbox simulation of its own request for evidence | Succeeded on its only attempt (debug `f542…38d8`). Read 07:35:51: still `UNDER_REVIEW`; read 07:45:28: `WAITING_FOR_SELLER_RESPONSE` |
| 07:57:08 | Write | `provide-evidence`: text drafted by the connected model, a PDF and a PNG attached, one of them a private document the merchant chose to disclose for that version | Succeeded on its only attempt (debug `ca58…4df1`). Read 07:57:14: `UNDER_REVIEW` |
| 2026-11-11 02:08:05 | Read | The case | `UNDER_REVIEW`; PayPal lists its settlement test control (`adjudicate`) among the allowed actions |

## 3. The next payment: a refund issued by the seller, then read back

The same daily subscription took a second payment after the recorded cancellation. No case was opened at PayPal for it, and CancelCase sent PayPal no request in this section.

| Time (UTC) | Kind | What happened | Result |
| --- | --- | --- | --- |
| 2026-11-12 04:10:30 | Read | The subscription's payments, from the app | A second payment: 2026-11-11 10:54:38, $19.99, `COMPLETED`. It became its own case: candidate, charged after the cancellation |
| 04:13:58 | Local | The refund request to the merchant, drafted by the connected model from that case | Validation passed. It was not approved and not exported: the refund below came first |
| Between 04:14 and 04:25 | Manual | The maintainer, signed in as the Sandbox seller, refunded that payment in full in PayPal's Sandbox pages | Not a request by CancelCase; there is no ledger operation for it |
| 04:25:44 | Read | The subscription's payments, from the app | The same payment, now `REFUNDED`. The case shows $19.99 refunded (verified), reason `FULLY_REFUNDED`, nothing left to claim, and $19.99 as money recovered |
| 04:27:40 | Read | The subscription's payments again | Two payments, each with its own case; no new payment and no extra record for the refund |

The first payment and its case in section 1 were not touched: that payment still reads `COMPLETED` and the case stays resolved for the seller.

## 4. Earlier subscription setups and checks

- Three earlier subscription setups, each write sent once and succeeded: 2026-11-09 18:33 (product, plan, subscription), 2026-11-10 00:41 (a replacement subscription) and 03:43 (product, plan and subscription of a daily plan).
- Six read-only diagnostics (`pnpm sandbox:check`) between 2026-11-09 15:28 and 2026-11-10 05:16, each requesting a token and reading only.

## 5. Totals

16 provider writes were recorded. 15 succeeded and 1 was refused by PayPal's validation. None ended `UNKNOWN`, and none was sent twice. The refund in section 3 is not one of them: a person issued it in PayPal's own pages.

Four of the 16 were dispute submissions whose text a connected model drafted: two buyer case requests (the first was the one PayPal refused) and two seller evidence responses. The other 12 were ten subscription setup requests, one Sandbox test control and one seller response written from the labelled template.

## 6. What this does not claim

- Nothing here is a result in PayPal's live environment. In the live environment the buyer files the case in PayPal; PayPal offers buyer case creation through the API in Sandbox only.
- The refund in section 3 was issued by the maintainer acting as the Sandbox seller, on test accounts. It shows that a refund is read back from PayPal and only then counted as recovered. It is not a recovery the product obtained from a merchant, and it is not a recovery rate.
- A decision is reported as PayPal returned it. CancelCase does not judge it, and a decision made by a Sandbox test control is labelled as a simulation wherever it appears.
- PayPal's own listing of the submitted text and files was not read back.
- The debug values let PayPal trace a call on request; they are not proof on their own. The unshortened records stay in the maintainer's private ledger.
