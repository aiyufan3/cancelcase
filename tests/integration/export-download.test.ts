import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/context";
import { setAppContextForTests } from "@/server/context";
import { ROLE_COOKIE, encodeRoleCookie } from "@/server/http/session";
import { GET as exportItemGet } from "@/app/api/operations/[id]/export/route";
import {
  addCaseEvidence,
  decideApproval,
  editDraft,
  generateDraft,
} from "@/server/services/case-service";
import { dispatchOperation, prepareOperation } from "@/server/services/operation-service";
import { buildCaseView } from "@/server/services/case-view";
import { evidence as evidenceRepo, operations } from "@/server/db/repos";
import { sha256Hex } from "@/domain/canonical";
import { overwriteEvidenceBytesForTest, readEvidenceBytes } from "@/server/services/evidence-store";
import { overwriteExportFileForTest, readExportFile } from "@/server/services/export-store";
import type { OperationRecord } from "@/server/records";

/**
 * Recipient downloads of an approved export (delivery audit D01). After Approve and export the
 * person takes the approved message, the recipient pack and the selected attachments from the
 * app. Each download is tied to the export operation and to the hashes recorded for that
 * approval; nothing is rebuilt from the current draft, and the private archive, unselected
 * files and the other role's material are never part of it.
 */

const HOST = "127.0.0.1:3999";
const PRIVATE_TEXT = "PRIVATE NOTE THAT WAS NEVER SELECTED 7731";
let h: TestHarness;
afterEach(() => {
  setAppContextForTests(null);
  h?.cleanup();
});

function start(options: { onDisk?: boolean } = {}): void {
  h = createTestHarness(options);
  setAppContextForTests(h.ctx);
}

function get(href: string, role: "buyer" | "merchant" | null = "buyer"): Promise<Response> {
  const headers = new Headers({ host: HOST });
  if (role)
    headers.set("cookie", `${ROLE_COOKIE}=${encodeURIComponent(encodeRoleCookie(h.ctx, role))}`);
  const id = /\/api\/operations\/([^/]+)\/export/.exec(href)![1]!;
  return exportItemGet(new Request(`http://${HOST}${href}`, { headers }), {
    params: Promise.resolve({ id }),
  });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

function addPrivateFile() {
  return addCaseEvidence(h.ctx, "buyer", {
    caseId: h.caseId,
    visibility: "private",
    provenance: "user_attestation",
    kind: "note",
    label: "Private work note",
    filename: "private.txt",
    declaredMime: "text/plain",
    bytes: new TextEncoder().encode(PRIVATE_TEXT),
    capturedAt: h.clock.now().toISOString(),
    eventTime: null,
    facts: [],
  });
}

async function approvedExport(): Promise<OperationRecord> {
  const draft = await generateDraft(h.ctx, {
    caseId: h.caseId,
    role: "buyer",
    action: "export_refund_request",
  });
  const approval = decideApproval(h.ctx, {
    caseId: h.caseId,
    role: "buyer",
    action: "export_refund_request",
    draftId: draft.id,
    decision: "approved",
  });
  const prepared = prepareOperation(h.ctx, {
    caseId: h.caseId,
    role: "buyer",
    action: "export_refund_request",
    approvalId: approval.id,
  });
  const done = await dispatchOperation(h.ctx, prepared.operation.id);
  expect(done.status).toBe("SUCCEEDED");
  return done;
}

function downloadsOf(opId: string) {
  const op = buildCaseView(h.ctx, h.caseId, "buyer").operations.find((o) => o.id === opId)!;
  expect(op.downloads).not.toBeNull();
  return op.downloads!;
}

describe("recipient downloads of an approved export", () => {
  it("serves the approved message, the recipient pack and each selected attachment, byte for byte", async () => {
    start();
    const priv = addPrivateFile();
    const op = await approvedExport();
    const payload = op.payload as { renderedText: string; attachmentEvidenceIds: string[] };
    expect(payload.attachmentEvidenceIds.length).toBeGreaterThan(0);
    expect(payload.attachmentEvidenceIds).not.toContain(priv.id);

    const downloads = downloadsOf(op.id);
    expect(downloads.unavailable).toBeNull();
    expect(downloads.materials.map((m) => m.label)).toEqual([
      "Message to send",
      "Evidence pack (Markdown)",
      "Evidence pack (JSON)",
    ]);
    expect(downloads.attachments).toHaveLength(payload.attachmentEvidenceIds.length);

    const message = await get(downloads.materials[0]!.href);
    expect(message.status).toBe(200);
    expect(message.headers.get("content-disposition")).toContain("attachment;");
    expect(message.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await message.text()).toBe(payload.renderedText);

    const packJson = await get(downloads.materials[2]!.href);
    expect(packJson.status).toBe(200);
    const packText = await packJson.text();
    const pack = JSON.parse(packText) as { audience: string; packHash: string };
    expect(pack.audience).toBe("recipient");
    expect(pack.packHash).toBe((op.result as { packHash: string }).packHash);
    // Disclosure scope: neither the unselected private file nor the private archive is in it.
    expect(packText).not.toContain(priv.id);
    expect(packText).not.toContain(PRIVATE_TEXT);
    expect(packText).not.toContain("local_archive");

    const packMd = await get(downloads.materials[1]!.href);
    expect(packMd.status).toBe(200);
    expect(await packMd.text()).not.toContain(priv.id);

    for (const item of downloads.attachments) {
      const res = await get(item.href);
      expect(res.status).toBe(200);
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(sha256Hex(bytes)).toBe(item.sha256);
      expect(bytes.length).toBe(item.sizeBytes);
      const evidenceId = decodeURIComponent(item.href.split("attachment=")[1]!);
      expect(payload.attachmentEvidenceIds).toContain(evidenceId);
      const record = evidenceRepo.get(h.ctx.db, evidenceId)!;
      expect(bytes.equals(readEvidenceBytes(h.ctx, record))).toBe(true);
    }
    // The recorded attachment hashes are exactly the ones the approval was bound to.
    expect(downloads.attachments.map((a) => a.sha256).sort()).toEqual(
      [...op.attachmentHashes].sort(),
    );
  });

  it("refuses the other role, a missing session, unselected files and the private archive", async () => {
    start();
    const priv = addPrivateFile();
    const op = await approvedExport();
    const base = `/api/operations/${op.id}/export`;
    const downloads = downloadsOf(op.id);

    const asMerchant = await get(downloads.materials[0]!.href, "merchant");
    expect(asMerchant.status).toBe(404);
    expect(await errorCode(asMerchant)).toBe("EXPORT_NOT_FOUND");
    expect((await get(downloads.attachments[0]!.href, "merchant")).status).toBe(404);
    expect((await get(downloads.materials[0]!.href, null)).status).toBe(401);
    // The merchant's view lists no buyer export at all.
    expect(buildCaseView(h.ctx, h.caseId, "merchant").operations).toHaveLength(0);

    const unselected = await get(`${base}?attachment=${priv.id}`);
    expect(unselected.status).toBe(404);
    expect(await errorCode(unselected)).toBe("EXPORT_ITEM_NOT_FOUND");

    const files = (op.result as { files: { localArchive: string } }).files;
    for (const name of ["localArchive", "archive", files.localArchive, "../cancelcase.sqlite"]) {
      const res = await get(`${base}?file=${encodeURIComponent(name)}`);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("EXPORT_ITEM_NOT_FOUND");
    }
    expect((await get(base)).status).toBe(400);
    expect((await get(`${base}?file=message&attachment=${priv.id}`)).status).toBe(400);
    expect((await get(`/api/operations/fx_op_missing/export?file=message`)).status).toBe(404);
  });

  it("keeps serving what was approved after the draft changes and the approval is long consumed", async () => {
    start();
    const op = await approvedExport();
    const approved = (op.payload as { renderedText: string }).renderedText;
    const before = downloadsOf(op.id);

    // A later version with another subject and no attachments, and a day passing.
    const v2 = editDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      subject: "A different subject written after the export",
      claims: [],
      attachmentEvidenceIds: [],
    });
    expect(v2.content.attachmentEvidenceIds).toEqual([]);
    h.clock.advanceMinutes(60 * 24);

    const after = downloadsOf(op.id);
    expect(after).toEqual(before);
    const message = await get(after.materials[0]!.href);
    expect(message.status).toBe(200);
    const text = await message.text();
    expect(text).toBe(approved);
    expect(text).not.toContain("A different subject written after the export");
    expect((await get(after.attachments[0]!.href)).status).toBe(200);
  });

  it("does not serve a stored file or attachment that no longer matches the approval", async () => {
    start();
    const op = await approvedExport();
    const downloads = downloadsOf(op.id);

    overwriteExportFileForTest(h.ctx, h.caseId, downloads.materials[2]!.filename, "{}");
    const pack = await get(downloads.materials[2]!.href);
    expect(pack.status).toBe(409);
    expect(await errorCode(pack)).toBe("EXPORT_MATERIAL_CHANGED");

    const evidenceId = decodeURIComponent(downloads.attachments[0]!.href.split("attachment=")[1]!);
    overwriteEvidenceBytesForTest(
      h.ctx,
      evidenceRepo.get(h.ctx.db, evidenceId)!,
      new TextEncoder().encode("replaced after approval"),
    );
    const attachment = await get(downloads.attachments[0]!.href);
    expect(attachment.status).toBe(409);
    expect(await errorCode(attachment)).toBe("EXPORT_MATERIAL_CHANGED");
    // The untouched message is still served.
    expect((await get(downloads.materials[0]!.href)).status).toBe(200);
  });

  it("says a download is not available when the record cannot show what was approved", async () => {
    start();
    const op = await approvedExport();
    const result = op.result as Record<string, unknown>;

    // An export recorded before downloads existed: file names, but no hashes.
    const legacy = { ...result };
    delete legacy.recipientMaterials;
    delete legacy.attachments;
    operations.update(h.ctx.db, { ...op, result: legacy });
    const view = downloadsOf(op.id);
    expect(view.materials).toEqual([]);
    expect(view.attachments).toEqual([]);
    expect(view.unavailable).toContain("before download records were kept");
    const res = await get(`/api/operations/${op.id}/export?file=message`);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("EXPORT_MATERIAL_UNAVAILABLE");

    // A record whose attachment list is not the one the approval was bound to is not trusted.
    operations.update(h.ctx.db, { ...op, result: { ...result, attachments: [] } });
    expect(downloadsOf(op.id).unavailable).not.toBeNull();

    // An export that did not complete has nothing to offer.
    operations.update(h.ctx.db, { ...op, status: "FAILED", result: null });
    const failedView = buildCaseView(h.ctx, h.caseId, "buyer").operations.find(
      (o) => o.id === op.id,
    )!;
    expect(failedView.downloads).toBeNull();
    const failed = await get(`/api/operations/${op.id}/export?file=message`);
    expect(failed.status).toBe(409);
    expect(await errorCode(failed)).toBe("EXPORT_NOT_COMPLETED");
  });

  it("on disk: reads only real files inside the case's export folder", async () => {
    start({ onDisk: true });
    const op = await approvedExport();
    const downloads = downloadsOf(op.id);
    const dir = path.join(h.ctx.exportDir, h.caseId);
    const messageName = downloads.materials[0]!.filename;
    expect(fs.existsSync(path.join(dir, messageName))).toBe(true);
    expect((await get(downloads.materials[0]!.href)).status).toBe(200);

    // Names that would leave the folder, and the archive subfolder, are never read.
    const archive = (op.result as { files: { localArchive: string } }).files.localArchive;
    expect(fs.existsSync(path.join(dir, archive))).toBe(true);
    expect(readExportFile(h.ctx, h.caseId, archive)).toBeNull();
    expect(readExportFile(h.ctx, h.caseId, "../../cancelcase.sqlite")).toBeNull();
    expect(readExportFile(h.ctx, h.caseId, "archive")).toBeNull();

    // A link put in place of the file is not followed, even when it points at the same text.
    const outside = path.join(path.dirname(h.ctx.exportDir), "outside.md");
    fs.copyFileSync(path.join(dir, messageName), outside);
    fs.rmSync(path.join(dir, messageName));
    fs.symlinkSync(outside, path.join(dir, messageName));
    expect(readExportFile(h.ctx, h.caseId, messageName)).toBeNull();
    const linked = await get(downloads.materials[0]!.href);
    expect(linked.status).toBe(404);
    expect(await errorCode(linked)).toBe("EXPORT_MATERIAL_UNAVAILABLE");

    // A file that is simply gone is reported as not available, never rebuilt.
    fs.rmSync(path.join(dir, downloads.materials[1]!.filename));
    const gone = await get(downloads.materials[1]!.href);
    expect(gone.status).toBe(404);
    expect(await errorCode(gone)).toBe("EXPORT_MATERIAL_UNAVAILABLE");
  });
});
