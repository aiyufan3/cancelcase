# Observability (optional)

CancelCase can send a trace of each agent run to LangSmith (the [`langsmith`](https://www.npmjs.com/package/langsmith) client). Tracing is off by default. Turn it on to see the LangGraph case thread step by step: which node ran, in what order, how long it took and where the run paused for a person.

## Turn it on

Add these lines to your local `.env`, then restart `pnpm demo` or `pnpm demo:sandbox`:

```sh
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=YOUR_API_KEY_HERE
LANGSMITH_PROJECT=cancelcase   # optional; this is the default
```

Tracing works in fixture mode and in Sandbox mode. Runs go to LangSmith's default endpoint, or to `LANGSMITH_ENDPOINT` if you set one.

The rules fail closed:

- `LANGSMITH_TRACING` without `LANGSMITH_API_KEY` stops the app at startup, so nothing is ever sent without a key.
- LangChain's own switches (`LANGCHAIN_TRACING_V2`, `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING`) also stop the app at startup. They would start LangChain's automatic tracer, which sends runs without redaction.
- CancelCase removes all four switches from its process environment once it has read them. LangChain's automatic tracer therefore never runs. Every trace goes through CancelCase's own tracer, `src/server/tracing.ts`.

## What a trace shows

Each graph run is one trace:

| Run | What it is |
| --- | --- |
| `CancelCase <action>: start`, `regenerate`, `resume after review (approve, reject or edit)` or `replay` | The root run, with tags `case:<id>`, `mode:<fixture or sandbox>`, `role:<buyer or merchant>`, `action:<action>` |
| `gather` | Collects the facts and sources the role may see |
| `draft` | Writes a new version, or reuses the one under review |
| `review` | The approval interrupt: the run pauses here until a person decides |
| `execute` | Runs the one approved operation through the operation ledger |
| `readback` | Reports the provider state that the operation read back |

## Exactly what is sent

- Run names, run types, start and end times.
- Errors, as one line of text each. The stack trace and every file path are dropped, and the line is redacted like everything else. LangChain records the pause for review as an error too; its line holds the case, draft and snapshot IDs, the role and action, and the review instructions.
- Tags and metadata:
  - the case ID, mode, role and action;
  - the thread ID;
  - LangGraph's and LangSmith's bookkeeping: step tags, the node, path, triggers and checkpoint namespace, the run depth and the integration name (`langgraph`).
- The library and runtime names (`langchain-js`, `node`), and the class names of the graph's runnables.
- As inputs and outputs, the thread state the nodes read and write:
  - case, draft, approval and operation IDs;
  - snapshot versions and flags;
  - the review decision's kind;
  - operation and provider statuses;
  - short log lines.

The thread state is not designed to hold the draft text, claims, evidence files or excerpts, PayPal requests or responses, prompts, model output, credentials or details about your machine, and the state schema has no field for them. This describes the implementation and what its tests and the recorded fixture runs checked; it is not a guarantee about every future value.

Before a run is sent, the langsmith client's `hideInputs`, `hideOutputs`, `hideMetadata` and `anonymizer` hooks pass everything through one redaction function, which also removes:

- secrets, tokens and credentials;
- personal fields such as email, name, address and phone;
- free text such as a rejection reason, which is replaced by its length;
- email addresses, and bearer and basic credentials;
- long opaque strings;
- PayPal identifiers (cases, subscriptions, plans, products, orders and transactions);
- the buyer's name.

Runtime details about your machine are omitted. The API key travels only in the request header LangSmith requires.

## Network

In fixture mode, tracing is the only network call CancelCase can make, and only when you turn it on. In Sandbox mode, the other calls are to PayPal Sandbox and, if you enable model drafting, to your configured model.

## Tests

- `tests/unit/tracing-config.test.ts`: the switches, the redaction function and the one-line errors.
- `tests/integration/tracing.test.ts`: with tracing off, no network call is made, even when LangChain's switches are set. With it on, only redacted, named and tagged runs reach a fake endpoint, and the pause for review arrives as one line, without a stack trace or a file path.
