# Reviewer guide

CancelCase is the buyer's side of a PayPal dispute: you cancelled a subscription, you were charged anyway, and it puts together the proof of the cancellation, catches the charge, prepares the case and sends only what you approved. This page gets you from a clean checkout to the whole story in a few minutes, without any account or key.

## 1. Run it without any account or key (about 2 minutes)

You need Node.js 22.12+ (or 24+) and pnpm 10. No pnpm? Run `corepack enable` once, or put `npx pnpm@10` in place of `pnpm` below.

```sh
pnpm install
pnpm demo
```

Open the link it prints (`http://127.0.0.1:3000/cases/…`). Everything in this mode is a local simulation: the header says *PayPal Sandbox · demo data*, and each record is labelled *synthetic fixture*; no PayPal call and no model call is made.

The page always shows one **next step**. Follow it:

1. **Open the form**, fill it from the fixture confirmation email, save. The check turns into *Candidate: charged after cancellation* and names its reason.
2. **Prepare my case.** One press gathers the facts, drafts the request and stops for your approval. Each paragraph lists the documents it rests on.
3. **Approve and export.** One press approves exactly that version and uses the approval once. Nothing is sent: the files are written on your computer, and the result lists them as downloads (the message, the evidence pack and the attachments you selected).
4. Choose the PayPal channel, **Prepare my case** again, set the fixture control to *simulate ambiguous timeout* (it applies to that one request) and press **Approve and submit**. The request becomes `UNKNOWN` and is never sent again until a read-back and a person settle it: press **Read back**, note what you verified and **Confirm it succeeded**.
5. Switch to the **merchant view**: the buyer's private note is gone. **Prepare the response**, then **Approve and submit**.

Start over at any time:

```sh
pnpm demo:reset --yes --acknowledge-unresolved && pnpm demo
```

It runs on your own machine at `127.0.0.1` only; the server checks the `Host` header, so it is not meant for port forwarding or a hosted container.

## 2. What is real and what is simulated

| What you see | Where it comes from |
| --- | --- |
| Step 1 above | A local simulation with synthetic data: *PayPal Sandbox · demo data* in the header of every screen, *synthetic fixture* on each record |
| The Sandbox scenes in the video | Real PayPal Sandbox calls made with the maintainer's own Sandbox app, read back |
| The list of those calls | [docs/sandbox-evidence.md](docs/sandbox-evidence.md): time, endpoint, result and read-back, with identifiers shortened |
| The $19.99 counted as recovered on the subscription's second payment | A refund the maintainer issued as the Sandbox seller in PayPal's own pages, then read back by the app. It shows the read-back of a refund on test accounts, not a recovery the product obtained |
| A decision marked *simulation* | PayPal's own Sandbox test control, which stands in for its decision; never presented as a real outcome |

## 3. Check the PayPal integration with your own Sandbox app (about 5 minutes, read-only)

Create a Sandbox REST app in the PayPal Developer Dashboard, copy `.env.example` to `.env`, fill `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` and keep `PAYPAL_ENV=sandbox`. Then:

```sh
pnpm sandbox:check
```

It requests a token, calls one PayPal Agent Toolkit read tool and several REST reads, and prints each capability as `VERIFIED`, `BLOCKED` or `NOT_TESTED`. Nothing is created. The writes (subscription setup, buyer case, seller evidence) are described step by step in [docs/testing-and-demo.md](docs/testing-and-demo.md); each one asks for an approval and is sent once.

## 4. Run the checks

```sh
pnpm test        # unit and integration suites, no network
pnpm test:e2e    # builds, then the browser scenarios (run `pnpm exec playwright install chromium` once first)
```

## 5. If something fails

- An `engines` error on install: use Node.js 22.12+ or 24+.
- Port 3000 is taken: `pnpm demo --port 3100`.
- The database module fails to load: install your platform's build tools (Xcode command-line tools on macOS) and run `pnpm install` again.
- Anything else: the [test and demo guide](docs/testing-and-demo.md) has the full procedure.
