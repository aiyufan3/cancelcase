import type { AppContext } from "../context";
import { audit } from "../db/repos";
import type { Role } from "@/domain/types";

export interface AuditInput {
  action: string;
  role?: Role | null;
  caseId?: string | null;
  operationId?: string | null;
  approvalId?: string | null;
  reasonCode?: string | null;
  details?: unknown;
  actor?: string;
}

/** Append-only application audit. Never pass tokens, assertions, file bytes or raw provider bodies. */
export function logAudit(ctx: AppContext, input: AuditInput): void {
  audit.append(ctx.db, {
    at: ctx.clock.now().toISOString(),
    environment: ctx.config.mode,
    actor: input.actor ?? ctx.actor,
    role: input.role ?? null,
    action: input.action,
    caseId: input.caseId ?? null,
    operationId: input.operationId ?? null,
    approvalId: input.approvalId ?? null,
    reasonCode: input.reasonCode ?? null,
    details: input.details ?? null,
  });
}
