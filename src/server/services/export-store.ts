import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../context";
import { sha256Hex } from "@/domain/canonical";

/**
 * Files written by an approved export. They live under the environment's export folder, one
 * folder per case, and are read back only by a name the server generated, never by a path a
 * caller supplied. An in-memory context keeps them in memory, as the evidence store does.
 */
const memoryFiles = new Map<string, Buffer>();

export interface StoredExportFile {
  sha256: string;
  sizeBytes: number;
}

function caseDir(ctx: AppContext, caseId: string): string {
  return path.join(ctx.exportDir, path.basename(caseId));
}

export function writeExportFile(
  ctx: AppContext,
  caseId: string,
  relativeName: string,
  content: string,
): StoredExportFile {
  const bytes = Buffer.from(content, "utf8");
  const target = path.join(caseDir(ctx, caseId), relativeName);
  if (ctx.dbPath) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  } else {
    memoryFiles.set(target, bytes);
  }
  return { sha256: sha256Hex(bytes), sizeBytes: bytes.length };
}

/**
 * Read one recipient file of a case. Returns null when it is not there, or when the name or
 * the file on disk would leave the case's export folder (a nested name, a link, a directory).
 */
export function readExportFile(ctx: AppContext, caseId: string, name: string): Buffer | null {
  if (!name || path.basename(name) !== name || name.startsWith(".")) return null;
  const dir = caseDir(ctx, caseId);
  const target = path.join(dir, name);
  if (!ctx.dbPath) return memoryFiles.get(target) ?? null;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  // The case folder itself must also be a real folder inside the export folder.
  const realRoot = fs.realpathSync(ctx.exportDir);
  const realTarget = fs.realpathSync(target);
  if (path.dirname(realTarget) !== path.join(realRoot, path.basename(caseId))) return null;
  return fs.readFileSync(realTarget);
}

export function deleteExportFiles(ctx: AppContext, caseId: string): void {
  const dir = caseDir(ctx, caseId);
  if (ctx.dbPath) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  for (const key of Array.from(memoryFiles.keys()))
    if (key.startsWith(dir + path.sep)) memoryFiles.delete(key);
}

/** Test helper: change a stored export file to simulate tampering. */
export function overwriteExportFileForTest(
  ctx: AppContext,
  caseId: string,
  name: string,
  content: string,
): void {
  const target = path.join(caseDir(ctx, caseId), name);
  if (ctx.dbPath) fs.writeFileSync(target, content);
  else memoryFiles.set(target, Buffer.from(content, "utf8"));
}
