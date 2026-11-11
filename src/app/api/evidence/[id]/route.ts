import { envelope, jsonError, requireRole } from "@/server/http/guards";
import { evidence as evidenceRepo } from "@/server/db/repos";
import { isEvidenceVisible } from "@/server/services/snapshot";
import { readEvidenceBytes } from "@/server/services/evidence-store";
import { AppError } from "@/server/services/errors";
import { logAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

/** Serves evidence bytes by validated ID only, with the stored (sniffed) content type, never executable. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const env = envelope(req);
    const role = requireRole(env);
    const { id } = await params;
    const record = evidenceRepo.get(env.ctx.db, id);
    if (!record || !isEvidenceVisible(record, role))
      throw new AppError("EVIDENCE_NOT_FOUND", "Evidence not found for this role.", 404);
    if (!record.storageName || !record.mime)
      throw new AppError("EVIDENCE_NO_FILE", "This evidence has no file.", 404);
    const bytes = readEvidenceBytes(env.ctx, record);
    logAudit(env.ctx, {
      action: "evidence.downloaded",
      role,
      caseId: record.caseId,
      details: { evidenceId: id },
    });
    const inline =
      new URL(req.url).searchParams.get("inline") === "1" &&
      (record.mime === "image/png" || record.mime === "image/jpeg" || record.mime === "text/plain");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": record.mime === "text/plain" ? "text/plain; charset=utf-8" : record.mime,
        "Content-Length": String(bytes.length),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${record.storageName}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
