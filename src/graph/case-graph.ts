import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import Database from "better-sqlite3";
import type { AppContext } from "@/server/context";
import { drafts as draftRepo, cases } from "@/server/db/repos";
import { generateDraft, requireBundle } from "@/server/services/case-service";
import { buildRoleSnapshot } from "@/server/services/snapshot";
import { dispatchOperation, prepareOperation } from "@/server/services/operation-service";
import { AppError } from "@/server/services/errors";
import { reviewIsPending } from "@/server/services/readiness";
import type { ActionKind, Role } from "@/domain/types";
import { draftOriginLabel } from "@/llm/drafter";
import { traceConfig } from "@/server/tracing";

/**
 * LangGraph case workflow for one (case, role, action) thread.
 *
 *   gather -> draft -> review (interrupt) -> execute -> readback -> END
 *                         ^__ edit ______|
 *
 * The graph orchestrates; the deterministic services own every write. The `review` node
 * contains nothing but the interrupt, so re-executing it on resume has no side effects.
 * `execute` is idempotent through the operation ledger, so a replayed checkpoint can never
 * repeat an external mutation.
 */

export type ReviewDecision =
  | { kind: "approve"; approvalId: string; simulate?: "timeout" | "unsupported" | null }
  | { kind: "reject"; reason: string }
  | { kind: "edit" };

const ThreadState = Annotation.Root({
  caseId: Annotation<string>,
  role: Annotation<Role>,
  action: Annotation<ActionKind>,
  snapshotVersion: Annotation<number | null>({ reducer: (_a, b) => b, default: () => null }),
  draftId: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  draftValid: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  forceNewDraft: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  decision: Annotation<ReviewDecision | null>({ reducer: (_a, b) => b, default: () => null }),
  operationId: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  operationStatus: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  providerStatus: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  log: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});

export type ThreadStateType = typeof ThreadState.State;

export interface ReviewInterruptPayload {
  caseId: string;
  role: Role;
  action: ActionKind;
  draftId: string | null;
  draftValid: boolean;
  snapshotVersion: number | null;
  instructions: string;
}

export function threadId(env: string, caseId: string, role: Role, action: ActionKind): string {
  return `${env}:${caseId}:${role}:${action}`;
}

export function buildCaseGraph(ctx: AppContext, checkpointer: BaseCheckpointSaver) {
  const graph = new StateGraph(ThreadState)
    .addNode("gather", async (state) => {
      const bundle = requireBundle(ctx, state.caseId);
      const snapshot = buildRoleSnapshot(ctx, bundle, state.role);
      return {
        snapshotVersion: snapshot.version,
        log: [
          `gathered ${snapshot.facts.length} facts and ${snapshot.sources.length} sources visible to ${state.role} (snapshot v${snapshot.version})`,
        ],
      };
    })
    .addNode("draft", async (state) => {
      const latest = draftRepo.latest(ctx.db, state.caseId, state.role, state.action);
      const bundle = requireBundle(ctx, state.caseId);
      // An existing draft is only reused while its review is still pending. After a failed,
      // rejected or completed attempt the next review always starts from a new version.
      const needsNew =
        !latest ||
        state.forceNewDraft ||
        latest.snapshotVersion !== bundle.caseRecord.evidenceSnapshotVersion ||
        state.decision?.kind === "edit" ||
        !reviewIsPending(bundle, state.role);
      if (!needsNew && latest) {
        return {
          draftId: latest.id,
          draftValid: latest.validation.ok,
          decision: null,
          forceNewDraft: false,
          log: [
            `using existing draft ${latest.id} v${latest.version} · ${draftOriginLabel(latest.origin)}`,
          ],
        };
      }
      const draft = await generateDraft(ctx, {
        caseId: state.caseId,
        role: state.role,
        action: state.action,
      });
      return {
        draftId: draft.id,
        draftValid: draft.validation.ok,
        decision: null,
        forceNewDraft: false,
        log: [
          `drafted ${draft.id} v${draft.version} · ${draftOriginLabel(draft.origin)} (${draft.validation.ok ? "valid" : "blocked"})`,
        ],
      };
    })
    .addNode("review", async (state) => {
      // Nothing but the interrupt lives here: this node re-executes from its start on resume.
      const payload: ReviewInterruptPayload = {
        caseId: state.caseId,
        role: state.role,
        action: state.action,
        draftId: state.draftId,
        draftValid: state.draftValid,
        snapshotVersion: state.snapshotVersion,
        instructions:
          "Review the draft. Resume with {kind:'approve', approvalId} after recording an approval, {kind:'reject', reason} or {kind:'edit'}.",
      };
      const decision = interrupt<ReviewInterruptPayload, ReviewDecision>(payload);
      return { decision, log: [`review decision: ${decision.kind}`] };
    })
    .addNode("execute", async (state) => {
      if (!state.decision || state.decision.kind !== "approve") {
        return { log: ["execute skipped: no approval"] };
      }
      const { operation, created } = prepareOperation(ctx, {
        caseId: state.caseId,
        role: state.role,
        action: state.action,
        approvalId: state.decision.approvalId,
        simulate: state.decision.simulate ?? null,
      });
      const dispatched = await dispatchOperation(ctx, operation.id);
      return {
        operationId: dispatched.id,
        operationStatus: dispatched.status,
        log: [
          `operation ${dispatched.id} ${created ? "created" : "reused"} -> ${dispatched.status}${dispatched.errorCode ? ` (${dispatched.errorCode})` : ""}`,
        ],
      };
    })
    .addNode("readback", async (state) => {
      // Dispatch persists its single read-back. Graph replay only projects that observation;
      // recovery from a failed read is an explicit Refresh, not another implicit provider call.
      const observation = cases.get(ctx.db, state.caseId)?.providerObservation;
      return {
        providerStatus: observation?.status ?? null,
        log: [
          observation?.stale
            ? "read-back unavailable; refresh the provider case"
            : `persisted provider status ${observation?.status ?? "unknown"}`,
        ],
      };
    })
    .addEdge(START, "gather")
    .addEdge("gather", "draft")
    .addEdge("draft", "review")
    .addConditionalEdges("review", (state) => {
      if (!state.decision) return END;
      if (state.decision.kind === "approve") return "execute";
      if (state.decision.kind === "edit") return "draft";
      return END;
    })
    .addEdge("execute", "readback")
    .addEdge("readback", END);
  return graph.compile({ checkpointer });
}

export type CompiledCaseGraph = ReturnType<typeof buildCaseGraph>;

const graphCache = new WeakMap<
  AppContext,
  { graph: CompiledCaseGraph; checkpointer: BaseCheckpointSaver; close: () => void }
>();

export function getCaseGraph(ctx: AppContext): {
  graph: CompiledCaseGraph;
  checkpointer: BaseCheckpointSaver;
} {
  const cached = graphCache.get(ctx);
  if (cached) return cached;
  let checkpointer: BaseCheckpointSaver;
  let close = () => {};
  if (ctx.graphDbPath) {
    const db = new Database(ctx.graphDbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    checkpointer = new SqliteSaver(db);
    close = () => db.close();
  } else {
    checkpointer = new MemorySaver();
  }
  const graph = buildCaseGraph(ctx, checkpointer);
  const entry = { graph, checkpointer, close };
  graphCache.set(ctx, entry);
  return entry;
}

export interface ThreadRunResult {
  threadId: string;
  /** True when this call produced a new draft version for review */
  regenerated?: boolean;
  state: ThreadStateType;
  interrupted: boolean;
  interruptPayload: ReviewInterruptPayload | null;
  next: string[];
}

function config(ctx: AppContext, caseId: string, role: Role, action: ActionKind) {
  return { configurable: { thread_id: threadId(ctx.config.mode, caseId, role, action) } };
}

/**
 * Options for one graph run: the thread, plus, only when LangSmith tracing is on, a redacting
 * tracer with a readable run name and the case, mode, role and action as tags (src/server/tracing).
 */
async function runConfig(
  ctx: AppContext,
  caseId: string,
  role: Role,
  action: ActionKind,
  step: string,
) {
  const tracing = await traceConfig(ctx, {
    caseId,
    role,
    action,
    name: `CancelCase ${action.replace(/_/g, " ")}: ${step}`,
    knownNames: () => {
      const rec = cases.get(ctx.db, caseId);
      return rec ? [rec.buyerAlias] : [];
    },
  });
  return { ...config(ctx, caseId, role, action), ...tracing };
}

async function describe(
  ctx: AppContext,
  caseId: string,
  role: Role,
  action: ActionKind,
): Promise<ThreadRunResult> {
  const { graph } = getCaseGraph(ctx);
  const cfg = config(ctx, caseId, role, action);
  const snapshot = await graph.getState(cfg);
  const interruptTask = snapshot.tasks.find((t) => t.interrupts.length > 0);
  const interruptPayload =
    (interruptTask?.interrupts[0]?.value as ReviewInterruptPayload | undefined) ?? null;
  return {
    threadId: cfg.configurable.thread_id,
    state: snapshot.values as ThreadStateType,
    interrupted: interruptPayload !== null,
    interruptPayload,
    next: [...snapshot.next],
  };
}

/**
 * Start (or restart after completion) the thread; runs until the review interrupt.
 * With `regenerate` while a review is pending, the pending review is answered with an edit
 * decision so the draft node produces a new version and a new review interrupt; the earlier
 * version's approval is revoked by the new draft. `regenerated` reports what actually happened.
 */
export async function startCaseThread(
  ctx: AppContext,
  input: { caseId: string; role: Role; action: ActionKind; regenerate?: boolean },
): Promise<ThreadRunResult> {
  const { graph } = getCaseGraph(ctx);
  const cfg = config(ctx, input.caseId, input.role, input.action);
  const before = draftRepo.latest(ctx.db, input.caseId, input.role, input.action);
  const existing = await graph.getState(cfg);
  if (existing.next.length > 0) {
    if (input.regenerate) {
      await graph.invoke(
        new Command({ resume: { kind: "edit" } satisfies ReviewDecision }),
        await runConfig(ctx, input.caseId, input.role, input.action, "regenerate"),
      );
    }
  } else {
    await graph.invoke(
      {
        caseId: input.caseId,
        role: input.role,
        action: input.action,
        forceNewDraft: Boolean(input.regenerate),
      },
      await runConfig(ctx, input.caseId, input.role, input.action, "start"),
    );
  }
  const after = draftRepo.latest(ctx.db, input.caseId, input.role, input.action);
  const result = await describe(ctx, input.caseId, input.role, input.action);
  return { ...result, regenerated: Boolean(after && after.id !== before?.id) };
}

/** Resume the thread with a review decision. A thread without a pending interrupt is not resumed. */
export async function resumeCaseThread(
  ctx: AppContext,
  input: { caseId: string; role: Role; action: ActionKind; decision: ReviewDecision },
): Promise<ThreadRunResult> {
  const { graph } = getCaseGraph(ctx);
  const cfg = config(ctx, input.caseId, input.role, input.action);
  const current = await graph.getState(cfg);
  if (current.next.length === 0) {
    throw new AppError(
      "NO_PENDING_REVIEW",
      "This thread has no pending review to resume. Start the thread first.",
      409,
    );
  }
  await graph.invoke(
    new Command({ resume: input.decision }),
    await runConfig(
      ctx,
      input.caseId,
      input.role,
      input.action,
      `resume after review (${input.decision.kind})`,
    ),
  );
  return describe(ctx, input.caseId, input.role, input.action);
}

export async function getCaseThread(
  ctx: AppContext,
  input: { caseId: string; role: Role; action: ActionKind },
): Promise<ThreadRunResult> {
  return describe(ctx, input.caseId, input.role, input.action);
}

/** Return the checkpoint history for a thread (for recovery inspection and tests). */
export async function listThreadCheckpoints(
  ctx: AppContext,
  input: { caseId: string; role: Role; action: ActionKind },
) {
  const { graph } = getCaseGraph(ctx);
  const cfg = config(ctx, input.caseId, input.role, input.action);
  const out: { checkpointId: string | undefined; next: string[]; operationId: string | null }[] =
    [];
  for await (const s of graph.getStateHistory(cfg)) {
    out.push({
      checkpointId: s.config.configurable?.checkpoint_id as string | undefined,
      next: [...s.next],
      operationId: (s.values as ThreadStateType).operationId ?? null,
    });
  }
  return out;
}

/** Re-run from an earlier checkpoint (time travel). Used in tests to prove no external write repeats. */
export async function replayFromCheckpoint(
  ctx: AppContext,
  input: { caseId: string; role: Role; action: ActionKind; checkpointId: string },
) {
  const { graph } = getCaseGraph(ctx);
  const traced = await runConfig(ctx, input.caseId, input.role, input.action, "replay");
  const cfg = {
    ...traced,
    configurable: {
      thread_id: threadId(ctx.config.mode, input.caseId, input.role, input.action),
      checkpoint_id: input.checkpointId,
    },
  };
  await graph.invoke(null, cfg);
  return describe(ctx, input.caseId, input.role, input.action);
}

export async function deleteCaseThreads(ctx: AppContext, threadIds: string[]): Promise<void> {
  const { checkpointer } = getCaseGraph(ctx);
  for (const id of threadIds) {
    await checkpointer.deleteThread(id);
  }
}
