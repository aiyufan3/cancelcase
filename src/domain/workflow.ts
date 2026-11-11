import type { WorkflowEvent, WorkflowState } from "./types";

/**
 * Local case workflow. This describes what the application has done so far for one
 * role's action thread. It is never derived from, and never implies, the provider's
 * dispute status.
 */

export class WorkflowTransitionError extends Error {
  constructor(
    readonly from: WorkflowState,
    readonly event: WorkflowEvent["type"],
  ) {
    super(`Invalid workflow transition: ${event} from ${from}`);
    this.name = "WorkflowTransitionError";
  }
}

const TRANSITIONS: Record<WorkflowState, Partial<Record<WorkflowEvent["type"], WorkflowState>>> = {
  FLAGGED: { START_DRAFT: "DRAFTING" },
  DRAFTING: {
    DRAFT_READY: "READY_FOR_REVIEW",
    DRAFT_INVALID: "BLOCKED",
    START_DRAFT: "DRAFTING",
  },
  READY_FOR_REVIEW: {
    REQUEST_APPROVAL: "AWAITING_APPROVAL",
    EDIT: "DRAFTING",
    START_DRAFT: "DRAFTING",
    INVALIDATE: "DRAFTING",
    DRAFT_INVALID: "BLOCKED",
  },
  AWAITING_APPROVAL: {
    APPROVE: "AWAITING_APPROVAL",
    REJECT: "REJECTED",
    EDIT: "DRAFTING",
    INVALIDATE: "DRAFTING",
    DISPATCH_STARTED: "EXECUTING",
  },
  EXECUTING: {
    DISPATCH_SUCCEEDED: "SYNCED",
    DISPATCH_FAILED: "BLOCKED",
    DISPATCH_UNKNOWN: "UNKNOWN",
  },
  SYNCED: {
    // A new action on the same thread starts a new draft; the provider state is read back separately.
    START_DRAFT: "DRAFTING",
  },
  REJECTED: { EDIT: "DRAFTING", START_DRAFT: "DRAFTING", REOPEN: "DRAFTING" },
  BLOCKED: { REOPEN: "DRAFTING", START_DRAFT: "DRAFTING" },
  UNKNOWN: {
    RECOVERY_CONFIRMED_SUCCESS: "SYNCED",
    RECOVERY_CONFIRMED_FAILURE: "BLOCKED",
  },
};

export function transitionWorkflow(state: WorkflowState, event: WorkflowEvent): WorkflowState {
  const next = TRANSITIONS[state][event.type];
  if (!next) throw new WorkflowTransitionError(state, event.type);
  return next;
}

export function canTransition(state: WorkflowState, eventType: WorkflowEvent["type"]): boolean {
  return TRANSITIONS[state][eventType] !== undefined;
}

/** States in which a case thread must not be deleted or reset without a recovery decision. */
export function isInFlight(state: WorkflowState): boolean {
  return state === "EXECUTING" || state === "UNKNOWN";
}
