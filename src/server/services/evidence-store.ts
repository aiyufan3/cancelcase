import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../context";
import { evidence as evidenceRepo } from "../db/repos";
import type { EvidenceKind, EvidenceRecord } from "../records";
import { newId } from "../ids";
import { sha256Hex } from "@/domain/canonical";
import type { NormalizedFact, Provenance, Role } from "@/domain/types";
import { isValidInstant } from "@/domain/time";

/**
 * Local evidence files. Product ceilings (not provider maxima): 5 MB per file, 5 files and
 * 20 MB per submitted pack, 25 files per case. Accepted: PDF, PNG, JPEG, UTF-8 text. Bytes are
 * sniffed; names are never trusted; storage names are generated; nothing is executed or
 * rendered as HTML.
 */
export const EVIDENCE_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  /** Attachments selected for one submission ("pack") */
  maxFilesPerPack: 5,
  maxTotalBytesPerPack: 20 * 1024 * 1024,
  /** Files stored per case in total */
  maxFilesPerCase: 25,
  maxTotalBytesPerCase: 60 * 1024 * 1024,
  maxTextChars: 20_000,
} as const;

export type AcceptedMime = "application/pdf" | "image/png" | "image/jpeg" | "text/plain";

const EXT: Record<AcceptedMime, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "text/plain": "txt",
};

export class EvidenceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "EMPTY"
      | "TOO_LARGE"
      | "TOO_MANY_FILES"
      | "CASE_QUOTA_EXCEEDED"
      | "UNSUPPORTED_TYPE"
      | "MIME_MISMATCH"
      | "DANGEROUS_CONTENT"
      | "INVALID_NAME"
      | "INVALID_TIME"
      | "NOT_FOUND"
      | "HASH_MISMATCH",
  ) {
    super(message);
    this.name = "EvidenceError";
  }
}

/** Determine the content type from bytes alone. Returns null when unsupported. */
export function sniffMime(bytes: Uint8Array): AcceptedMime | null {
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (looksLikeUtf8Text(bytes)) return "text/plain";
  return null;
}

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  for (let i = 0; i < Math.min(bytes.length, 8192); i += 1) {
    const b = bytes[i]!;
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const DANGEROUS_TEXT =
  /<\s*(html|svg|script|iframe|object|embed|body|head|meta|link|style)\b|^\s*#!|<\?php|javascript:/i;

export function sanitizeFilename(name: string): string {
  if (/[\\/\0]/.test(name) || name.includes("..")) {
    throw new EvidenceError(
      "File names must not contain path separators or traversal sequences.",
      "INVALID_NAME",
    );
  }
  const base = path.basename(name).trim();
  if (!base || base === "." || base === "..")
    throw new EvidenceError("Invalid file name.", "INVALID_NAME");
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 80);
  if (!cleaned.replace(/[._ -]/g, ""))
    throw new EvidenceError("Invalid file name.", "INVALID_NAME");
  return cleaned;
}

export interface AddEvidenceInput {
  caseId: string | null;
  subscriptionId: string | null;
  accountAlias: string;
  ownerRole: Role;
  visibility: "private" | "shared";
  provenance: Provenance;
  kind: EvidenceKind;
  label: string;
  filename: string;
  declaredMime: string | null;
  bytes: Uint8Array;
  capturedAt: string | null;
  eventTime: string | null;
  facts: NormalizedFact[];
}

export function validateEvidenceBytes(input: {
  bytes: Uint8Array;
  declaredMime: string | null;
  filename: string;
}): { mime: AcceptedMime; textExcerpt: string | null } {
  if (input.bytes.length === 0) throw new EvidenceError("The file is empty.", "EMPTY");
  if (input.bytes.length > EVIDENCE_LIMITS.maxFileBytes) {
    throw new EvidenceError(
      `The file exceeds the ${EVIDENCE_LIMITS.maxFileBytes / (1024 * 1024)} MB per-file limit.`,
      "TOO_LARGE",
    );
  }
  sanitizeFilename(input.filename);
  const sniffed = sniffMime(input.bytes);
  if (!sniffed)
    throw new EvidenceError(
      "Only PDF, PNG, JPEG and UTF-8 text files are accepted.",
      "UNSUPPORTED_TYPE",
    );
  if (input.declaredMime && normalizeMime(input.declaredMime) !== sniffed) {
    throw new EvidenceError(
      `Declared type ${input.declaredMime} does not match the file content (${sniffed}).`,
      "MIME_MISMATCH",
    );
  }
  const lowerName = input.filename.toLowerCase();
  if (/\.(html?|svg|js|mjs|exe|sh|bat|cmd|php|jar|dll|scr|ps1)$/.test(lowerName)) {
    throw new EvidenceError(
      "Executable or markup file types are not accepted.",
      "DANGEROUS_CONTENT",
    );
  }
  let textExcerpt: string | null = null;
  if (sniffed === "text/plain") {
    const text = new TextDecoder("utf-8").decode(input.bytes);
    if (DANGEROUS_TEXT.test(text))
      throw new EvidenceError(
        "Text evidence must not contain markup or scripts.",
        "DANGEROUS_CONTENT",
      );
    if (text.length > EVIDENCE_LIMITS.maxTextChars)
      throw new EvidenceError("Text evidence is too long.", "TOO_LARGE");
    textExcerpt = text.slice(0, 2000);
  }
  return { mime: sniffed, textExcerpt };
}

function normalizeMime(mime: string): string {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base === "image/jpg") return "image/jpeg";
  if (base === "text/markdown" || base === "text/csv") return "text/plain";
  return base;
}

export function addEvidence(ctx: AppContext, input: AddEvidenceInput): EvidenceRecord {
  if (input.capturedAt && !isValidInstant(input.capturedAt))
    throw new EvidenceError("capturedAt must be an ISO instant with offset.", "INVALID_TIME");
  if (input.eventTime && !isValidInstant(input.eventTime))
    throw new EvidenceError("eventTime must be an ISO instant with offset.", "INVALID_TIME");
  const { mime, textExcerpt } = validateEvidenceBytes({
    bytes: input.bytes,
    declaredMime: input.declaredMime,
    filename: input.filename,
  });

  if (input.caseId) {
    const existing = evidenceRepo
      .listForCase(ctx.db, input.caseId, input.subscriptionId ?? "")
      .filter((e) => e.storageName);
    if (existing.length >= EVIDENCE_LIMITS.maxFilesPerCase) {
      throw new EvidenceError(
        `A case holds at most ${EVIDENCE_LIMITS.maxFilesPerCase} files.`,
        "TOO_MANY_FILES",
      );
    }
    const total = existing.reduce((sum, e) => sum + (e.sizeBytes ?? 0), 0) + input.bytes.length;
    if (total > EVIDENCE_LIMITS.maxTotalBytesPerCase) {
      throw new EvidenceError(
        "The case would exceed its evidence storage quota.",
        "CASE_QUOTA_EXCEEDED",
      );
    }
  }

  const id = newId(ctx.config.mode, "ev");
  const storageName = `${id}.${EXT[mime]}`;
  const sha256 = sha256Hex(input.bytes);
  const target = path.join(/* turbopackIgnore: true */ ctx.evidenceDir, storageName);
  if (ctx.dbPath) {
    fs.mkdirSync(ctx.evidenceDir, { recursive: true });
    fs.writeFileSync(target, input.bytes, { flag: "wx" });
  } else {
    memoryFiles.set(target, Buffer.from(input.bytes));
  }
  const record: EvidenceRecord = {
    id,
    environment: ctx.config.mode,
    accountAlias: input.accountAlias,
    caseId: input.caseId,
    subscriptionId: input.subscriptionId,
    ownerRole: input.ownerRole,
    visibility: input.visibility,
    provenance: input.provenance,
    kind: input.kind,
    label: input.label.slice(0, 120),
    storageName,
    mime,
    sizeBytes: input.bytes.length,
    sha256,
    capturedAt: input.capturedAt,
    eventTime: input.eventTime,
    facts: input.facts.map((f) => ({
      ...f,
      sourceIds: f.sourceIds.length > 0 ? f.sourceIds : [id],
    })),
    textExcerpt,
    version: 1,
    createdAt: ctx.clock.now().toISOString(),
  };
  evidenceRepo.insert(ctx.db, record);
  return record;
}

/** A fact-only evidence record (manual attestation) without a file. */
export function addAttestation(
  ctx: AppContext,
  input: Omit<AddEvidenceInput, "filename" | "declaredMime" | "bytes">,
): EvidenceRecord {
  const id = newId(ctx.config.mode, "ev");
  const record: EvidenceRecord = {
    id,
    environment: ctx.config.mode,
    accountAlias: input.accountAlias,
    caseId: input.caseId,
    subscriptionId: input.subscriptionId,
    ownerRole: input.ownerRole,
    visibility: input.visibility,
    provenance: input.provenance,
    kind: input.kind,
    label: input.label.slice(0, 120),
    storageName: null,
    mime: null,
    sizeBytes: null,
    sha256: null,
    capturedAt: input.capturedAt,
    eventTime: input.eventTime,
    facts: input.facts.map((f) => ({
      ...f,
      sourceIds: f.sourceIds.length > 0 ? f.sourceIds : [id],
    })),
    textExcerpt: null,
    version: 1,
    createdAt: ctx.clock.now().toISOString(),
  };
  evidenceRepo.insert(ctx.db, record);
  return record;
}

const memoryFiles = new Map<string, Buffer>();

/** Read evidence bytes by validated record, never by a caller-supplied path. Verifies the stored hash. */
export function readEvidenceBytes(ctx: AppContext, record: EvidenceRecord): Buffer {
  if (!record.storageName || !record.sha256)
    throw new EvidenceError("This evidence has no file.", "NOT_FOUND");
  const target = path.join(ctx.evidenceDir, path.basename(record.storageName));
  const bytes = ctx.dbPath ? fs.readFileSync(target) : memoryFiles.get(target);
  if (!bytes) throw new EvidenceError("Evidence file is missing.", "NOT_FOUND");
  if (sha256Hex(bytes) !== record.sha256)
    throw new EvidenceError("Evidence bytes no longer match the recorded hash.", "HASH_MISMATCH");
  return bytes;
}

/** Test/demo helper: overwrite an evidence file's bytes to simulate tampering. */
export function overwriteEvidenceBytesForTest(
  ctx: AppContext,
  record: EvidenceRecord,
  bytes: Uint8Array,
): void {
  if (!record.storageName) return;
  const target = path.join(ctx.evidenceDir, path.basename(record.storageName));
  if (ctx.dbPath) fs.writeFileSync(target, bytes);
  else memoryFiles.set(target, Buffer.from(bytes));
}

export function deleteEvidenceFiles(ctx: AppContext, records: EvidenceRecord[]): void {
  for (const r of records) {
    if (!r.storageName) continue;
    const target = path.join(ctx.evidenceDir, path.basename(r.storageName));
    if (ctx.dbPath) {
      if (fs.existsSync(target)) fs.rmSync(target);
    } else {
      memoryFiles.delete(target);
    }
  }
}

export function evidenceMimeToExtension(mime: AcceptedMime): string {
  return EXT[mime];
}
