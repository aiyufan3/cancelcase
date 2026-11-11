import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/context";
import {
  addCaseEvidence,
  decideApproval,
  editDraft,
  generateDraft,
  transferChannel,
} from "@/server/services/case-service";
import { dispatchOperation, prepareOperation } from "@/server/services/operation-service";
import { approvals } from "@/server/db/repos";
import { AppError } from "@/server/services/errors";
import type { Drafter } from "@/llm/drafter";
import type { RoleSnapshot } from "@/domain/types";
import { buildTemplateDraft } from "@/llm/fixture-drafter";
import {
  buildOutwardSnapshot,
  buildRoleSnapshot,
  disclosureScope,
} from "@/server/services/snapshot";
import { requireBundle } from "@/server/services/case-service";

/**
 * Seeing a private source is not consent to send it (independent audit AUD03 and the outward
 * manifest requirement). Recipient-facing drafts, attachments, citations and export packs only
 * contain shared material unless the author explicitly includes a private source, which creates
 * a new version that needs a new approval. The complete role view is a separate local archive.
 */

let h: TestHarness;
afterEach(() => h?.cleanup());

const PRIVATE_TEXT = "AUDIT PRIVATE ATTACHMENT BODY 4471";

function addPrivateFile(harness: TestHarness) {
  return addCaseEvidence(harness.ctx, "buyer", {
    caseId: harness.caseId,
    visibility: "private",
    provenance: "user_attestation",
    kind: "note",
    label: "Private work note",
    filename: "private.txt",
    declaredMime: "text/plain",
    bytes: new TextEncoder().encode(PRIVATE_TEXT),
    capturedAt: harness.clock.now().toISOString(),
    eventTime: null,
    facts: [],
  });
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : String(err);
  }
}

describe("outward disclosure defaults", () => {
  it("AUD03: a role-private file is not attached, cited or sent to the drafter by default", async () => {
    h = createTestHarness();
    const seen: RoleSnapshot[] = [];
    const spy: Drafter = {
      kind: "fixture_template",
      label: "spy",
      async draft(input) {
        seen.push(input.snapshot);
        return {
          ok: true,
          content: buildTemplateDraft(
            input.snapshot,
            input.action,
            input.role,
            input.attachmentEvidenceIds,
          ),
          origin: "fixture_template",
          calls: 0,
          notes: [],
        };
      },
    };
    h.ctx.drafter = spy;
    const priv = addPrivateFile(h);
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    expect(draft.content.attachmentEvidenceIds).not.toContain(priv.id);
    expect(draft.content.attachmentEvidenceIds.length).toBeGreaterThan(0);
    expect(draft.content.privateSourceIdsIncluded).toEqual([]);
    const cited = draft.content.claims.flatMap((c) => c.sourceIds);
    expect(cited).not.toContain(priv.id);
    expect(draft.renderedText).not.toContain("Private work note");
    expect(draft.renderedText).not.toContain("Buyer's private note");
    // The drafter itself never saw the private sources or the private note's facts.
    expect(seen[0]!.sources.every((s) => s.visibility === "shared")).toBe(true);
    expect(JSON.stringify(seen[0])).not.toContain("private note");
  });

  it("the merchant's own private billing log is not disclosed to the reviewer by default", async () => {
    h = createTestHarness();
    // A (simulated) provider case must exist before the merchant has anything to respond to.
    transferChannel(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      channel: "paypal",
      reason: "escalate",
    });
    const buyerDraft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
    });
    const buyerApproval = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      draftId: buyerDraft.id,
      decision: "approved",
    });
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "buyer_create_dispute",
      approvalId: buyerApproval.id,
    });
    expect((await dispatchOperation(h.ctx, operation.id)).status).toBe("SUCCEEDED");
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "merchant",
      action: "merchant_provide_evidence",
    });
    expect(draft.renderedText).not.toContain("billing log");
    expect(draft.content.attachmentEvidenceIds.every((id) => !id.includes("billing"))).toBe(true);
  });
});

describe("explicit, versioned inclusion", () => {
  it("including a private source creates a new version, voids the earlier approval and allows attaching it", async () => {
    h = createTestHarness();
    const priv = addPrivateFile(h);
    const v1 = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    const a1 = decideApproval(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      draftId: v1.id,
      decision: "approved",
    });
    // Attaching without disclosing is refused, as is disclosing another role's source.
    expect(
      codeOf(() =>
        editDraft(h.ctx, {
          caseId: h.caseId,
          role: "buyer",
          action: "export_refund_request",
          claims: [],
          attachmentEvidenceIds: [...v1.content.attachmentEvidenceIds, priv.id],
        }),
      ),
    ).toBe("ATTACHMENT_NOT_DISCLOSED");
    expect(
      codeOf(() =>
        editDraft(h.ctx, {
          caseId: h.caseId,
          role: "merchant",
          action: "merchant_provide_evidence",
          claims: [],
          privateSourceIdsIncluded: [priv.id],
        }),
      ),
    ).not.toBeNull();
    const v2 = editDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      claims: [],
      privateSourceIdsIncluded: [priv.id],
      attachmentEvidenceIds: [...v1.content.attachmentEvidenceIds, priv.id],
    });
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.content.attachmentEvidenceIds).toContain(priv.id);
    expect(approvals.get(h.ctx.db, a1.id)?.revokedReason).toBe("draft_changed");
  });

  it("a claim citing an undisclosed private source is blocked with an explicit reason", async () => {
    h = createTestHarness();
    const priv = addPrivateFile(h);
    const sneaky: Drafter = {
      kind: "fixture_template",
      label: "sneaky",
      async draft(input) {
        const content = buildTemplateDraft(input.snapshot, input.action, input.role, []);
        content.claims[0] = { ...content.claims[0]!, sourceIds: [priv.id] };
        return { ok: true, content, origin: "fixture_template", calls: 0, notes: [] };
      },
    };
    h.ctx.drafter = sneaky;
    const draft = await generateDraft(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
    });
    expect(draft.validation.ok).toBe(false);
    expect(draft.validation.issues.map((i) => i.code)).toContain("UNDISCLOSED_SOURCE");
  });
});

describe("the live-model check follows the same rule", () => {
  it("withholds role-private sources from the model and validates against the outward scope", () => {
    h = createTestHarness();
    const roleSnapshot = buildRoleSnapshot(h.ctx, requireBundle(h.ctx, h.caseId), "buyer");
    const outward = buildOutwardSnapshot(roleSnapshot, []);
    const privateIds = roleSnapshot.sources
      .filter((s) => s.visibility === "private")
      .map((s) => s.id);
    expect(privateIds.length).toBeGreaterThan(0);
    expect(outward.sources.some((s) => s.visibility === "private")).toBe(false);
    expect(Array.from(disclosureScope(roleSnapshot, outward).undisclosedSourceIds)).toEqual(
      expect.arrayContaining(privateIds),
    );
    // Found by the first live run: the check script once sent the full role view.
    const script = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../scripts/llm-check.ts"),
      "utf8",
    );
    expect(script).toContain("buildOutwardSnapshot(roleSnapshot, [])");
    expect(script).toContain(
      "validateDraft(result.content, snapshot, role, scope, referenceScope(bundle))",
    );
  });
});

describe("recipient bundle vs local archive", () => {
  it("the exported recipient files never contain unselected private material; the archive is separate", async () => {
    h = createTestHarness({ onDisk: true });
    addPrivateFile(h);
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
    const { operation } = prepareOperation(h.ctx, {
      caseId: h.caseId,
      role: "buyer",
      action: "export_refund_request",
      approvalId: approval.id,
    });
    const done = await dispatchOperation(h.ctx, operation.id);
    expect(done.status).toBe("SUCCEEDED");
    const result = done.result as {
      files: Record<string, string>;
      recipientFiles: string[];
    };
    const dir = path.join(h.ctx.exportDir, h.caseId);
    expect(result.recipientFiles).not.toContain(result.files.localArchive);
    for (const file of result.recipientFiles) {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      expect(text).not.toContain("Private work note");
      expect(text).not.toContain("Buyer's private note");
      expect(text).not.toContain(PRIVATE_TEXT);
      expect(text).not.toMatch(/fx_appr_|fx_op_/); // no internal approvals or operations
    }
    const pack = JSON.parse(fs.readFileSync(path.join(dir, result.files.packJson!), "utf8"));
    expect(pack.audience).toBe("recipient");
    expect(
      pack.sections["6_source_manifest"].sources.every(
        (s: { visibility: string }) => s.visibility === "shared",
      ),
    ).toBe(true);
    const archive = JSON.parse(fs.readFileSync(path.join(dir, result.files.localArchive!), "utf8"));
    expect(archive.audience).toBe("local_archive");
    expect(JSON.stringify(archive)).toContain("Private work note");
  });
});
