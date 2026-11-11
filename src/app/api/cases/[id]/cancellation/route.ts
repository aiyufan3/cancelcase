import { NextResponse } from "next/server";
import { z } from "zod";
import { guardMutation, jsonError } from "@/server/http/guards";
import { recordCancellation } from "@/server/services/case-service";
import { buildCaseView } from "@/server/services/case-view";

const instant = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/,
    "ISO instant with offset required",
  );

const schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("RECORD_CANCELLATION_REQUEST"),
    requestedAt: instant,
    evidenceIds: z.array(z.string()).max(10).optional(),
  }),
  z.object({
    type: z.literal("RECORD_CONFIRMATION"),
    receivedAt: instant,
    effectiveAt: instant.nullable(),
    // Manual records are attestations or kept documents; a provider observation is only ever
    // recorded from an actual provider read, never typed in.
    basis: z.enum(["user_attestation", "merchant_confirmation_document"]).nullable(),
    evidenceIds: z.array(z.string()).max(10),
  }),
  z.object({
    type: z.literal("RESOLVE_REVIEW"),
    effectiveAt: instant,
    basis: z.enum(["user_attestation", "merchant_confirmation_document"]),
    evidenceIds: z.array(z.string()).min(1).max(10),
    resolvedAt: instant,
  }),
  z.object({
    type: z.literal("REOPEN_REVIEW"),
    reason: z.enum([
      "MISSING_EVIDENCE",
      "MISSING_EFFECTIVE_TIME",
      "MISSING_BASIS",
      "INVALID_TIMESTAMP",
      "CONFLICTING_EFFECTIVE_TIME",
      "CONFIRMATION_BEFORE_REQUEST",
    ]),
  }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { env, body } = await guardMutation(req, { schema });
    const { id } = await params;
    recordCancellation(env.ctx, { caseId: id, role: env.role!, event: body });
    return NextResponse.json(buildCaseView(env.ctx, id, env.role!));
  } catch (err) {
    return jsonError(err);
  }
}
