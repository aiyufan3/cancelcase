import type { ProviderAllowedAction, ProviderObservation, Role } from "./types";
import { KNOWN_DISPUTE_STATUSES, KNOWN_LIFECYCLE_STAGES } from "./types";
import { compareInstants, isValidInstant, type Clock } from "./time";

/**
 * Provider dispute state is an *observation*. We keep what PayPal reported, label unknown
 * enums, refuse to regress on older snapshots, and derive capabilities only from
 * validated action links plus current status/role/deadline.
 */

export function enumsUnderstood(status: string | null, stage: string | null): boolean {
  const statusOk =
    status === null || (KNOWN_DISPUTE_STATUSES as readonly string[]).includes(status);
  const stageOk = stage === null || (KNOWN_LIFECYCLE_STAGES as readonly string[]).includes(stage);
  return statusOk && stageOk;
}

export type MergeOutcome =
  | { kind: "applied"; observation: ProviderObservation }
  | { kind: "ignored_older"; observation: ProviderObservation }
  | { kind: "ignored_other_resource"; observation: ProviderObservation }
  | { kind: "ordering_uncertain"; observation: ProviderObservation };

/**
 * Merge an incoming observation of the same dispute into the current one. A different resource
 * never replaces the saved reference. Older observations never overwrite newer ones. Same
 * timestamp with different content means ordering is uncertain: keep the current snapshot and
 * flag it stale so the caller refreshes.
 */
export function mergeObservation(
  current: ProviderObservation | null,
  incoming: ProviderObservation,
): MergeOutcome {
  if (!current) return { kind: "applied", observation: incoming };
  if (current.disputeId !== incoming.disputeId)
    return { kind: "ignored_other_resource", observation: current };
  // Version 0 is the local reference saved when a create call succeeded, before any provider
  // read. The first real read of that same dispute replaces it.
  if (current.observedVersion === 0)
    return { kind: "applied", observation: { ...incoming, observedVersion: 1 } };
  const cmp = compareInstants(incoming.observedAt, current.observedAt);
  if (cmp === "before") {
    return { kind: "ignored_older", observation: current };
  }
  if (cmp === "equal" || cmp === "unknown") {
    const same = observationContent(current) === observationContent(incoming);
    if (same)
      return {
        kind: "applied",
        observation: { ...incoming, observedVersion: current.observedVersion },
      };
    return { kind: "ordering_uncertain", observation: { ...current, stale: true } };
  }
  return {
    kind: "applied",
    observation: { ...incoming, observedVersion: current.observedVersion + 1 },
  };
}

function observationContent(o: ProviderObservation): string {
  return JSON.stringify([
    o.disputeId,
    o.status,
    o.stage,
    o.outcome,
    o.reason,
    o.sellerResponseDueAt,
    [...o.requestedEvidenceTypes].sort(),
    [...o.allowedActions].sort(),
  ]);
}

export type CapabilityCode =
  | "NO_OBSERVATION"
  | "FIXTURE_OBSERVATION_NOT_PROVIDER"
  | "STALE_OBSERVATION"
  | "UNKNOWN_ENUM"
  | "WRONG_ROLE"
  | "STATUS_NOT_ELIGIBLE"
  | "ACTION_LINK_MISSING"
  | "DEADLINE_PASSED"
  | "NO_EVIDENCE_REQUESTED";

export interface CapabilityCheck {
  allowed: boolean;
  codes: CapabilityCode[];
}

/**
 * Can the merchant provide evidence right now? Requires a fresh, understood observation,
 * the merchant role, a waiting-for-seller status, a current provide-evidence link and
 * an unexpired deadline when a deadline is present.
 */
export function canProvideEvidence(
  observation: ProviderObservation | null,
  role: Role,
  clock: Clock,
  options: { requireRealProvider: boolean },
): CapabilityCheck {
  const codes: CapabilityCode[] = [];
  if (!observation) return { allowed: false, codes: ["NO_OBSERVATION"] };
  if (options.requireRealProvider && observation.provenance !== "sandbox_api") {
    codes.push("FIXTURE_OBSERVATION_NOT_PROVIDER");
  }
  if (observation.stale) codes.push("STALE_OBSERVATION");
  if (!observation.enumsUnderstood) codes.push("UNKNOWN_ENUM");
  if (role !== "merchant") codes.push("WRONG_ROLE");
  if (observation.status !== "WAITING_FOR_SELLER_RESPONSE") codes.push("STATUS_NOT_ELIGIBLE");
  if (!observation.allowedActions.includes("provide_evidence")) codes.push("ACTION_LINK_MISSING");
  if (observation.sellerResponseDueAt) {
    if (
      !isValidInstant(observation.sellerResponseDueAt) ||
      compareInstants(clock.now().toISOString(), observation.sellerResponseDueAt) !== "before"
    ) {
      codes.push("DEADLINE_PASSED");
    }
  }
  return { allowed: codes.length === 0, codes };
}

/** Validate a provider HATEOAS link against the configured Sandbox origin and expected shape. */
export interface HateoasLink {
  rel: string;
  href: string;
  method?: string;
}

export interface LinkValidationResult {
  ok: boolean;
  action: ProviderAllowedAction | null;
  reason: string | null;
}

const REL_TO_ACTION: Record<
  string,
  { action: ProviderAllowedAction; method: string; suffix: RegExp }
> = {
  provide_evidence: {
    action: "provide_evidence",
    method: "POST",
    suffix: /^\/v1\/customer\/disputes\/[A-Za-z0-9-]+\/provide-evidence$/,
  },
  send_message: {
    action: "send_message",
    method: "POST",
    suffix: /^\/v1\/customer\/disputes\/[A-Za-z0-9-]+\/send-message$/,
  },
  accept_claim: {
    action: "accept_claim",
    method: "POST",
    suffix: /^\/v1\/customer\/disputes\/[A-Za-z0-9-]+\/accept-claim$/,
  },
  escalate: {
    action: "escalate",
    method: "POST",
    suffix: /^\/v1\/customer\/disputes\/[A-Za-z0-9-]+\/escalate$/,
  },
  appeal: {
    action: "appeal",
    method: "POST",
    suffix: /^\/v1\/customer\/disputes\/[A-Za-z0-9-]+\/appeal$/,
  },
  require_evidence: {
    action: "require_evidence",
    method: "POST",
    suffix: /^\/v1\/customer\/disputes\/[A-Za-z0-9-]+\/require-evidence$/,
  },
  // Sandbox test control: PayPal's simulation of its own decision on a case under review.
  adjudicate: {
    action: "adjudicate",
    method: "POST",
    suffix: /^\/v1\/customer\/disputes\/[A-Za-z0-9-]+\/adjudicate$/,
  },
};

export function validateProviderLink(
  link: HateoasLink,
  allowedOrigins: readonly string[],
  expectedDisputeId: string,
): LinkValidationResult {
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    return { ok: false, action: null, reason: "MALFORMED_URL" };
  }
  if (url.protocol !== "https:") return { ok: false, action: null, reason: "NOT_HTTPS" };
  if (!allowedOrigins.includes(url.origin))
    return { ok: false, action: null, reason: "ORIGIN_NOT_ALLOWED" };
  if (url.username || url.password)
    return { ok: false, action: null, reason: "CREDENTIALS_IN_URL" };
  const rel = link.rel.toLowerCase().replace(/-/g, "_");
  const spec = REL_TO_ACTION[rel];
  if (!spec) return { ok: true, action: "unknown", reason: null };
  if (!spec.suffix.test(url.pathname)) return { ok: false, action: null, reason: "PATH_MISMATCH" };
  const idInPath = url.pathname.split("/")[4];
  if (idInPath !== expectedDisputeId)
    return { ok: false, action: null, reason: "RESOURCE_MISMATCH" };
  if ((link.method ?? spec.method).toUpperCase() !== spec.method) {
    return { ok: false, action: null, reason: "METHOD_MISMATCH" };
  }
  return { ok: true, action: spec.action, reason: null };
}

export function allowedActionsFromLinks(
  links: HateoasLink[],
  allowedOrigins: readonly string[],
  expectedDisputeId: string,
): { actions: ProviderAllowedAction[]; rejected: { rel: string; reason: string }[] } {
  const actions: ProviderAllowedAction[] = [];
  const rejected: { rel: string; reason: string }[] = [];
  for (const link of links) {
    const v = validateProviderLink(link, allowedOrigins, expectedDisputeId);
    if (!v.ok) {
      rejected.push({ rel: link.rel, reason: v.reason ?? "INVALID" });
      continue;
    }
    if (v.action && v.action !== "unknown" && !actions.includes(v.action)) actions.push(v.action);
  }
  return { actions, rejected };
}
