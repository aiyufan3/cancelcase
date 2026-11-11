import { envelope, jsonError, requireRole } from "@/server/http/guards";
import { requireBundle } from "@/server/services/case-service";
import { buildRoleSnapshot } from "@/server/services/snapshot";
import { buildEvidencePack, renderEvidencePackMarkdown } from "@/domain/evidence-pack";
import { drafts as draftRepo, operations as operationRepo } from "@/server/db/repos";
import { logAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

/**
 * Local archive download (JSON or Markdown): the requesting role's complete view of the case,
 * including its own private sources and internal action history. It is labelled as an archive
 * that is not meant to be sent; recipient-facing material is produced by the approved export.
 * A read; nothing is sent anywhere.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const env = envelope(req);
    const role = requireRole(env);
    const { id } = await params;
    const format = new URL(req.url).searchParams.get("format") === "md" ? "md" : "json";
    const bundle = requireBundle(env.ctx, id);
    const snapshot = buildRoleSnapshot(env.ctx, bundle, role);
    const latestDraft = [
      "export_refund_request",
      "buyer_create_dispute",
      "merchant_provide_evidence",
    ]
      .map((a) => draftRepo.latest(env.ctx.db, id, role, a))
      .filter((d) => d !== null)
      .sort((a, b) => (a!.createdAt < b!.createdAt ? 1 : -1))[0];
    const obs = bundle.caseRecord.providerObservation;
    const pack = buildEvidencePack({
      audience: "local_archive",
      snapshot,
      generatedAt: env.ctx.clock.now().toISOString(),
      buyerAlias: bundle.caseRecord.buyerAlias,
      merchantAlias: bundle.caseRecord.merchantAlias,
      subscriptionLabel: bundle.subscription.label,
      modeLabel: env.ctx.config.mode === "fixture" ? "Fixture (synthetic)" : "Sandbox (connected)",
      providerCase: {
        id: obs?.disputeId ?? null,
        status: obs?.status ?? null,
        stage: obs?.stage ?? null,
        observedAt: obs?.observedAt ?? null,
        provenance: obs?.provenance ?? null,
      },
      actions: operationRepo
        .listForCase(env.ctx.db, id)
        .filter((o) => o.role === role)
        .map((o) => ({
          operationId: o.id,
          action: o.action,
          status: o.status,
          approvalId: o.approvalId,
          at: o.updatedAt,
        })),
      draft: latestDraft
        ? {
            version: latestDraft.version,
            hash: latestDraft.contentHash,
            origin: latestDraft.origin,
          }
        : null,
      remedyText:
        role === "buyer"
          ? "Refund of the charge made after the effective cancellation."
          : "Factual merchant response for the reviewer.",
    });
    logAudit(env.ctx, {
      action: "evidence_pack.exported",
      role,
      caseId: id,
      details: { format, packHash: pack.packHash },
    });
    const body = format === "md" ? renderEvidencePackMarkdown(pack) : JSON.stringify(pack, null, 2);
    return new Response(body, {
      headers: {
        "Content-Type":
          format === "md" ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="local-archive-${role}-${id}.${format}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
