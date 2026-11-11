import type { AppContext } from "../context";
import {
  approvals,
  audit,
  cases,
  charges,
  claims,
  contacts,
  drafts,
  evidence as evidenceRepo,
  operations,
  subscriptions,
} from "../db/repos";
import { assertDeletable } from "./case-service";
import { AppError } from "./errors";
import { logAudit } from "./audit";
import type { Role } from "@/domain/types";
import { deleteEvidenceFiles } from "./evidence-store";
import { deleteExportFiles } from "./export-store";
import type { DeletionResult } from "./case-service";

/**
 * Case deletion cascades to attachments, drafts, approvals, operations, contact events and
 * (through the supplied callback) graph checkpoints for that case. It is refused while an
 * operation is executing or unknown. Only a minimal non-personal marker remains in the audit log.
 *
 * Deleting local data does not delete anything previously sent to PayPal or a model provider,
 * and filesystem deletion is not secure erasure.
 */
export async function deleteCase(
  ctx: AppContext,
  caseId: string,
  role: Role,
  deleteGraphThreads: (threadIds: string[]) => Promise<void>,
): Promise<DeletionResult> {
  // The buyer is the local owner of the case and its evidence. The merchant view is a
  // simulation of the other party and must not be able to erase the owner's records.
  if (role !== "buyer") {
    logAudit(ctx, { action: "case.delete_denied", role, caseId, reasonCode: "OWNER_ONLY" });
    throw new AppError(
      "OWNER_ONLY",
      "Only the case owner (buyer view) can delete this case and its evidence.",
      403,
    );
  }
  const bundle = assertDeletable(ctx, caseId);
  const threadIds = ["buyer", "merchant"].flatMap((role) =>
    ["export_refund_request", "buyer_create_dispute", "merchant_provide_evidence"].map(
      (action) => `${ctx.config.mode}:${caseId}:${role}:${action}`,
    ),
  );
  // A subscription can carry several cases (one per payment). Its record and the documents
  // scoped to it go only with the last of those cases.
  const lastCaseOfSubscription = cases
    .list(ctx.db)
    .every((c) => c.id === caseId || c.subscriptionId !== bundle.subscription.id);
  const evidenceRecords = evidenceRepo
    .listForCase(ctx.db, caseId, bundle.subscription.id)
    .filter((e) => e.caseId === caseId || lastCaseOfSubscription);
  const draftCount = drafts.listForCase(ctx.db, caseId).length;
  const approvalCount = approvals.listForCase(ctx.db, caseId).length;
  const operationCount = operations.listForCase(ctx.db, caseId).length;

  const txn = ctx.db.transaction(() => {
    operations.deleteForCase(ctx.db, caseId);
    claims.deleteForCase(ctx.db, caseId);
    approvals.deleteForCase(ctx.db, caseId);
    drafts.deleteForCase(ctx.db, caseId);
    contacts.deleteForCase(ctx.db, caseId);
    evidenceRepo.deleteForCase(ctx.db, caseId);
    if (lastCaseOfSubscription)
      ctx.db
        .prepare("DELETE FROM evidence WHERE subscription_id = ? AND case_id IS NULL")
        .run(bundle.subscription.id);
    cases.delete(ctx.db, caseId);
    const otherCases = cases.listForCharge(ctx.db, bundle.charge.id);
    if (otherCases.length === 0)
      ctx.db.prepare("DELETE FROM charges WHERE id = ?").run(bundle.charge.id);
    if (lastCaseOfSubscription)
      ctx.db.prepare("DELETE FROM subscriptions WHERE id = ?").run(bundle.subscription.id);
    audit.scrubForCase(ctx.db, caseId, ctx.clock.now().toISOString(), ctx.config.mode);
  });
  txn();
  deleteEvidenceFiles(ctx, evidenceRecords);
  deleteExportFiles(ctx, caseId);
  let checkpointsDeleted: boolean;
  try {
    await deleteGraphThreads(threadIds);
    checkpointsDeleted = true;
  } catch {
    checkpointsDeleted = false;
  }
  return {
    caseId,
    evidenceFiles: evidenceRecords.filter((e) => e.storageName).length,
    drafts: draftCount,
    approvals: approvalCount,
    operations: operationCount,
    checkpointsDeleted,
  };
}

export { subscriptions, charges };
