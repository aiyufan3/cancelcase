import type { ActionKind, DraftContent, DraftOrigin, Role, RoleSnapshot } from "@/domain/types";

/**
 * Drafting boundary. A drafter receives only an immutable, role-filtered snapshot and
 * returns structured claims. It has no tools, no network access beyond its own model
 * endpoint, and no ability to approve, route funds, select credentials or execute writes.
 *
 * Results carry neutral metadata only (origin, call count, public-safe notes). The configured
 * service, endpoint and model identifier are private operator configuration: a live drafter
 * may record them in ignored local diagnostics, never in its return value.
 */

export interface DrafterResult {
  ok: true;
  content: DraftContent;
  origin: DraftOrigin;
  /** Number of model calls actually made (0 for templates) */
  calls: number;
  /** Public-safe notes about repairs or fallbacks */
  notes: string[];
}

export type DrafterFailureCode =
  | "NOT_CONFIGURED"
  | "TIMEOUT"
  | "MALFORMED_OUTPUT"
  | "EMPTY_OUTPUT"
  | "TRUNCATED_OUTPUT"
  | "PROVIDER_ERROR"
  | "BUDGET_EXCEEDED";

export interface DrafterFailure {
  ok: false;
  code: DrafterFailureCode;
  /** Public-safe message: never contains the configured service, endpoint, model or upstream body */
  message: string;
  calls: number;
}

export interface Drafter {
  readonly kind: "fixture_template" | "live_model";
  /** Neutral label, e.g. "Connected model" or "Template — no model call" */
  readonly label: string;
  draft(input: {
    snapshot: RoleSnapshot;
    action: ActionKind;
    role: Role;
    attachmentEvidenceIds: string[];
  }): Promise<DrafterResult | DrafterFailure>;
}

/** Neutral, user-facing description of where a draft's text came from. */
export function draftOriginLabel(origin: DraftOrigin): string {
  switch (origin) {
    case "live_model":
      return "Connected model";
    case "repaired_model":
      return "Connected model · one repair";
    case "fixture_template":
      return "Template — no model call";
    case "human_edit":
      return "Human edit";
    default: {
      const exhaustive: never = origin;
      return exhaustive;
    }
  }
}
