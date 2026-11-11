import type { AppContext } from "../context";
import { operations as operationRepo } from "../db/repos";
import type { OperationRecord } from "../records";
import type { Role } from "@/domain/types";
import { sha256Hex } from "@/domain/canonical";
import { AppError } from "./errors";
import { logAudit } from "./audit";
import { requireBundle } from "./case-service";
import { isEvidenceVisible } from "./snapshot";
import { EvidenceError, readEvidenceBytes } from "./evidence-store";
import { readExportFile } from "./export-store";

/**
 * Recipient downloads of one approved export.
 *
 * Everything served here is tied to the export operation that succeeded: the files written for
 * that approval and the attachments it named, each checked against the hash recorded then. The
 * current draft and the current case content are never used to rebuild an earlier export. When
 * the record or the stored bytes cannot show what was approved, the item is reported as not
 * available. The private local archive is a different download and is not served from here.
 */
export type RecipientFileKey = "message" | "pack-md" | "pack-json";

export interface ExportedMaterial {
  key: RecipientFileKey;
  filename: string;
  mime: string;
  sha256: string;
  sizeBytes: number;
}

export interface ExportedAttachment {
  evidenceId: string;
  filename: string;
  mime: string;
  sha256: string;
  sizeBytes: number;
}

export interface ExportDownloadList {
  draftVersion: number | null;
  materials: ExportedMaterial[];
  attachments: ExportedAttachment[];
  /** Set when this export has no usable download record; says why nothing is offered. */
  unavailable: string | null;
}

export const RECIPIENT_FILE_LABELS: Record<RecipientFileKey, string> = {
  message: "Message to send",
  "pack-md": "Evidence pack (Markdown)",
  "pack-json": "Evidence pack (JSON)",
};

const NO_RECORD =
  "This export was made before download records were kept, so the app cannot show which files were approved. The files written at the time are still in the local exports folder.";

const KEYS: RecipientFileKey[] = ["message", "pack-md", "pack-json"];
const HEX_64 = /^[0-9a-f]{64}$/;

function isMaterial(v: unknown): v is ExportedMaterial {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.key === "string" &&
    KEYS.includes(m.key as RecipientFileKey) &&
    typeof m.filename === "string" &&
    typeof m.mime === "string" &&
    typeof m.sha256 === "string" &&
    HEX_64.test(m.sha256) &&
    typeof m.sizeBytes === "number"
  );
}

function isAttachment(v: unknown): v is ExportedAttachment {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.evidenceId === "string" &&
    typeof a.filename === "string" &&
    typeof a.mime === "string" &&
    typeof a.sha256 === "string" &&
    HEX_64.test(a.sha256) &&
    typeof a.sizeBytes === "number"
  );
}

/** What an export operation recorded for download, or null when it is not a completed export. */
export function exportDownloadList(op: OperationRecord): ExportDownloadList | null {
  if (op.action !== "export_refund_request" || op.status !== "SUCCEEDED") return null;
  const result = (op.result && typeof op.result === "object" ? op.result : {}) as Record<
    string,
    unknown
  >;
  const materials = Array.isArray(result.recipientMaterials)
    ? result.recipientMaterials.filter(isMaterial)
    : [];
  const attachments = Array.isArray(result.attachments)
    ? result.attachments.filter(isAttachment)
    : [];
  const complete =
    Array.isArray(result.recipientMaterials) &&
    Array.isArray(result.attachments) &&
    materials.length === KEYS.length &&
    KEYS.every((k) => materials.some((m) => m.key === k)) &&
    attachments.length === result.attachments.length;
  // The attachments recorded must be exactly the ones the approval was bound to.
  const boundHashes = JSON.stringify([...op.attachmentHashes].sort());
  const recordedHashes = JSON.stringify(attachments.map((a) => a.sha256).sort());
  if (!complete || boundHashes !== recordedHashes)
    return { draftVersion: null, materials: [], attachments: [], unavailable: NO_RECORD };
  return {
    draftVersion: typeof result.draftVersion === "number" ? result.draftVersion : null,
    materials,
    attachments,
    unavailable: null,
  };
}

export type ExportSelector = { file: string } | { attachment: string };

export interface ExportDownload {
  bytes: Buffer;
  filename: string;
  mime: string;
  sha256: string;
}

function unavailable(message: string): AppError {
  return new AppError("EXPORT_MATERIAL_UNAVAILABLE", message, 404);
}

export function readExportDownload(
  ctx: AppContext,
  role: Role,
  operationId: string,
  selector: ExportSelector,
): ExportDownload {
  const op = operationRepo.get(ctx.db, operationId);
  // Another role's export is reported exactly like one that does not exist.
  if (!op || op.action !== "export_refund_request" || op.role !== role)
    throw new AppError("EXPORT_NOT_FOUND", "Export not found for this role.", 404);
  const bundle = requireBundle(ctx, op.caseId);
  if (op.status !== "SUCCEEDED")
    throw new AppError(
      "EXPORT_NOT_COMPLETED",
      "This export did not complete, so there are no approved materials to download.",
      409,
    );
  const list = exportDownloadList(op);
  if (!list || list.unavailable) throw unavailable(list?.unavailable ?? NO_RECORD);

  let download: ExportDownload;
  let item: string;
  if ("file" in selector) {
    const material = list.materials.find((m) => m.key === selector.file);
    if (!material)
      throw new AppError("EXPORT_ITEM_NOT_FOUND", "That file is not part of this export.", 404);
    const payload = op.payload as { renderedText?: unknown };
    // The message is also checked against the approved text itself, not only the stored hash.
    if (
      material.key === "message" &&
      (typeof payload.renderedText !== "string" ||
        sha256Hex(Buffer.from(payload.renderedText, "utf8")) !== material.sha256)
    )
      throw new AppError(
        "EXPORT_MATERIAL_CHANGED",
        "The recorded message does not match the approved text; it is not served.",
        409,
      );
    const bytes = readExportFile(ctx, op.caseId, material.filename);
    if (!bytes)
      throw unavailable(
        "The exported file is no longer in local storage. It is not rebuilt from the current case.",
      );
    if (sha256Hex(bytes) !== material.sha256)
      throw new AppError(
        "EXPORT_MATERIAL_CHANGED",
        "The stored file no longer matches what was approved; it is not served.",
        409,
      );
    download = { bytes, filename: material.filename, mime: material.mime, sha256: material.sha256 };
    item = material.key;
  } else {
    const attachment = list.attachments.find((a) => a.evidenceId === selector.attachment);
    if (!attachment)
      throw new AppError(
        "EXPORT_ITEM_NOT_FOUND",
        "That file was not selected and approved for this export.",
        404,
      );
    // Only evidence that still belongs to this case, and that this role may see.
    const record = bundle.allEvidence.find((e) => e.id === attachment.evidenceId);
    if (!record || !isEvidenceVisible(record, role))
      throw unavailable("The approved attachment is no longer stored for this case.");
    let bytes: Buffer;
    try {
      bytes = readEvidenceBytes(ctx, record);
    } catch (err) {
      if (err instanceof EvidenceError && err.code === "HASH_MISMATCH")
        throw new AppError(
          "EXPORT_MATERIAL_CHANGED",
          "The stored attachment no longer matches what was approved; it is not served.",
          409,
        );
      throw unavailable("The approved attachment is no longer in local storage.");
    }
    if (sha256Hex(bytes) !== attachment.sha256)
      throw new AppError(
        "EXPORT_MATERIAL_CHANGED",
        "The stored attachment no longer matches what was approved; it is not served.",
        409,
      );
    download = {
      bytes,
      filename: attachment.filename,
      mime: attachment.mime,
      sha256: attachment.sha256,
    };
    item = `attachment:${attachment.evidenceId}`;
  }
  logAudit(ctx, {
    action: "export.material_downloaded",
    role,
    caseId: op.caseId,
    details: { operationId: op.id, item },
  });
  return download;
}
