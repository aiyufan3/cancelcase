import { NextResponse } from "next/server";
import { guardMultipart, jsonError } from "@/server/http/guards";
import { addCaseEvidence } from "@/server/services/case-service";
import { buildCaseView } from "@/server/services/case-view";
import { AppError } from "@/server/services/errors";
import type { EvidenceKind } from "@/server/records";

const KINDS: EvidenceKind[] = [
  "receipt",
  "cancellation_confirmation",
  "charge_record",
  "screenshot",
  "communication",
  "merchant_record",
  "note",
  "other",
];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { env, form } = await guardMultipart(req);
    const { id } = await params;
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("NO_FILE", "Attach one file.", 400);
    const kind = String(form.get("kind") ?? "other") as EvidenceKind;
    if (!KINDS.includes(kind)) throw new AppError("INVALID_KIND", "Unknown evidence kind.", 400);
    const visibility =
      String(form.get("visibility") ?? "private") === "shared" ? "shared" : "private";
    const label = String(form.get("label") ?? file.name).slice(0, 120) || file.name;
    const eventTime = String(form.get("eventTime") ?? "").trim() || null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const record = addCaseEvidence(env.ctx, env.role!, {
      caseId: id,
      visibility,
      provenance: "user_attestation",
      kind,
      label,
      filename: file.name,
      declaredMime: file.type || null,
      bytes,
      capturedAt: env.ctx.clock.now().toISOString(),
      eventTime,
      facts: [],
    });
    return NextResponse.json({
      evidenceId: record.id,
      view: buildCaseView(env.ctx, id, env.role!),
    });
  } catch (err) {
    return jsonError(err);
  }
}
