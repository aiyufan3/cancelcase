import type { Channel, DraftContent, Role, RoleSnapshot } from "./types";
import { formatCents } from "./money";
import { hashCanonical } from "./canonical";

/**
 * The six project-specific evidence-pack sections. The pack is assembled from a
 * role-filtered snapshot only; empty sections stay empty and are never filled with
 * inferred facts. Hashes establish byte integrity, not truth.
 */

export interface EvidencePackActionRef {
  operationId: string;
  action: string;
  status: string;
  approvalId: string | null;
  at: string;
}

export type EvidencePackAudience = "recipient" | "local_archive";

export interface EvidencePack {
  schema: "cancelcase.evidence-pack/1";
  /** recipient: only disclosed material, safe to send; local_archive: the role's full view */
  audience: EvidencePackAudience;
  generatedAt: string;
  environment: string;
  role: Role;
  caseId: string;
  snapshotVersion: number;
  packHash: string;
  sections: {
    "1_case_context": {
      buyerAlias: string;
      merchantAlias: string;
      subscriptionLabel: string;
      scope: string;
      modeLabel: string;
    };
    "2_cancellation_timeline": {
      events: { at: string | null; label: string; sourceIds: string[]; basis: string | null }[];
      effectiveAt: string | null;
      basis: string | null;
      note: string;
    };
    "3_charge_and_provider_facts": {
      facts: {
        id: string;
        label: string;
        at: string | null;
        amount: string | null;
        text: string;
        sourceIds: string[];
      }[];
      remainingAmount: string | null;
      providerCase: {
        id: string | null;
        status: string | null;
        stage: string | null;
        observedAt: string | null;
        provenance: string | null;
      };
    };
    "4_contact_history": {
      events: { at: string; direction: string; summary: string; sourceIds: string[] }[];
      gaps: string[];
    };
    "5_requested_remedy": {
      channel: Channel;
      requestedAmount: string | null;
      remedy: string;
      disclaimer: string;
    };
    "6_source_manifest": {
      sources: {
        id: string;
        kind: string;
        label: string;
        provenance: string;
        ownerRole: Role | "system";
        visibility: string;
        sha256: string | null;
        capturedAt: string | null;
        eventTime: string | null;
        attached: boolean;
      }[];
      actions: EvidencePackActionRef[];
      draft: { version: number | null; hash: string | null; origin: string | null } | null;
    };
  };
}

export interface EvidencePackInput {
  audience: EvidencePackAudience;
  snapshot: RoleSnapshot;
  /** Sources sent as files with this pack */
  attachedSourceIds?: string[];
  generatedAt: string;
  buyerAlias: string;
  merchantAlias: string;
  subscriptionLabel: string;
  modeLabel: string;
  providerCase: EvidencePack["sections"]["3_charge_and_provider_facts"]["providerCase"];
  actions: EvidencePackActionRef[];
  draft: { version: number; hash: string; origin: string } | null;
  remedyText: string;
}

const RECOVERY_DISCLAIMER =
  "This pack organizes facts for review. Submitting it does not guarantee a refund or any particular decision.";

export function buildEvidencePack(input: EvidencePackInput): EvidencePack {
  const { snapshot } = input;
  const attached = new Set(input.attachedSourceIds ?? []);
  const cancellationFacts = snapshot.facts.filter(
    (f) => f.kind === "cancellation_request" || f.kind === "cancellation_effective",
  );
  const effective = snapshot.facts.find((f) => f.kind === "cancellation_effective") ?? null;
  const chargeFacts = snapshot.facts.filter(
    (f) =>
      f.kind === "charge" ||
      f.kind === "refund" ||
      f.kind === "service_period" ||
      f.kind === "provider_case" ||
      f.kind === "subscription",
  );
  const sections: EvidencePack["sections"] = {
    "1_case_context": {
      buyerAlias: input.buyerAlias,
      merchantAlias: input.merchantAlias,
      subscriptionLabel: input.subscriptionLabel,
      scope: `Charged-after-cancellation review prepared from the ${snapshot.role} perspective.`,
      modeLabel: input.modeLabel,
    },
    "2_cancellation_timeline": {
      events: cancellationFacts.map((f) => ({
        at: f.at,
        label: f.label,
        sourceIds: f.sourceIds,
        basis: f.kind === "cancellation_effective" ? f.text : null,
      })),
      effectiveAt: effective?.at ?? null,
      basis: effective?.text ?? null,
      note:
        cancellationFacts.length === 0
          ? "No cancellation facts are visible to this role."
          : "Request time, confirmation arrival and effective time are recorded separately; a recorded cancellation is not proof that a payment mandate was cancelled.",
    },
    "3_charge_and_provider_facts": {
      facts: chargeFacts.map((f) => ({
        id: f.id,
        label: f.label,
        at: f.at,
        amount: f.cents !== null ? formatCents(f.cents) : null,
        text: f.text,
        sourceIds: f.sourceIds,
      })),
      remainingAmount:
        snapshot.claimableCents !== null ? formatCents(snapshot.claimableCents) : null,
      providerCase: input.providerCase,
    },
    "4_contact_history": {
      events: snapshot.contactHistory.map((c) => ({
        at: c.at,
        direction: c.direction,
        summary: c.summary,
        sourceIds: c.sourceIds,
      })),
      gaps: snapshot.gaps,
    },
    "5_requested_remedy": {
      channel: snapshot.channel,
      requestedAmount:
        snapshot.requestedCents !== null ? formatCents(snapshot.requestedCents) : null,
      remedy: input.remedyText,
      disclaimer: RECOVERY_DISCLAIMER,
    },
    "6_source_manifest": {
      sources: snapshot.sources.map((s) => ({
        id: s.id,
        kind: s.kind,
        label: s.label,
        provenance: s.provenance,
        ownerRole: s.ownerRole,
        visibility: s.visibility,
        sha256: s.sha256,
        capturedAt: s.capturedAt,
        eventTime: s.eventTime,
        attached: attached.has(s.id),
      })),
      // Internal operations and approvals are never part of a recipient-facing pack.
      actions: input.audience === "recipient" ? [] : input.actions,
      draft: input.draft,
    },
  };
  const packHash = hashCanonical({
    audience: input.audience,
    sections,
    role: snapshot.role,
    caseId: snapshot.caseId,
    version: snapshot.version,
  });
  return {
    schema: "cancelcase.evidence-pack/1",
    audience: input.audience,
    generatedAt: input.generatedAt,
    environment: snapshot.environment,
    role: snapshot.role,
    caseId: snapshot.caseId,
    snapshotVersion: snapshot.version,
    packHash,
    sections,
  };
}

export function renderEvidencePackMarkdown(pack: EvidencePack): string {
  const s = pack.sections;
  const lines: string[] = [];
  lines.push(
    pack.audience === "recipient"
      ? `# Evidence pack — case ${pack.caseId}`
      : `# LOCAL ARCHIVE — not for sending — case ${pack.caseId}`,
  );
  lines.push("");
  if (pack.audience === "local_archive") {
    lines.push(
      "_This archive is your complete view of the case, including private sources. Send the recipient pack instead._",
    );
    lines.push("");
  }
  lines.push(
    `Role: **${pack.role}** · Mode: **${s["1_case_context"].modeLabel}** · Snapshot v${pack.snapshotVersion} · Generated ${pack.generatedAt}`,
  );
  lines.push("");
  lines.push("## 1. Case and party context");
  lines.push(`- Buyer: ${s["1_case_context"].buyerAlias}`);
  lines.push(`- Merchant: ${s["1_case_context"].merchantAlias}`);
  lines.push(`- Subscription: ${s["1_case_context"].subscriptionLabel}`);
  lines.push(`- Scope: ${s["1_case_context"].scope}`);
  lines.push("");
  lines.push("## 2. Cancellation timeline and proof");
  if (s["2_cancellation_timeline"].events.length === 0)
    lines.push("_No cancellation facts visible to this role._");
  for (const e of s["2_cancellation_timeline"].events) {
    lines.push(
      `- ${e.at ?? "(time unknown)"} — ${e.label}${e.basis ? ` (${e.basis})` : ""} [${e.sourceIds.join(", ") || "no source"}]`,
    );
  }
  lines.push(`- Effective time: ${s["2_cancellation_timeline"].effectiveAt ?? "unknown"}`);
  lines.push(`- ${s["2_cancellation_timeline"].note}`);
  lines.push("");
  lines.push("## 3. Charge and provider reference facts");
  for (const f of s["3_charge_and_provider_facts"].facts) {
    lines.push(
      `- ${f.label}${f.at ? ` · ${f.at}` : ""}${f.amount ? ` · ${f.amount}` : ""} — ${f.text} [${f.sourceIds.join(", ") || "no source"}]`,
    );
  }
  lines.push(
    `- Remaining amount: ${s["3_charge_and_provider_facts"].remainingAmount ?? "not computable"}`,
  );
  const pc = s["3_charge_and_provider_facts"].providerCase;
  lines.push(
    `- Provider case: ${pc.id ?? "none"} · status ${pc.status ?? "n/a"} · stage ${pc.stage ?? "n/a"} · observed ${pc.observedAt ?? "never"} · provenance ${pc.provenance ?? "n/a"}`,
  );
  lines.push("");
  lines.push("## 4. Contact history and gaps");
  if (s["4_contact_history"].events.length === 0) lines.push("_No contact recorded._");
  for (const c of s["4_contact_history"].events)
    lines.push(
      `- ${c.at} — ${c.direction}: ${c.summary} [${c.sourceIds.join(", ") || "no source"}]`,
    );
  for (const g of s["4_contact_history"].gaps) lines.push(`- Gap: ${g}`);
  lines.push("");
  lines.push("## 5. Requested remedy");
  lines.push(`- Channel: ${s["5_requested_remedy"].channel}`);
  lines.push(`- Requested amount: ${s["5_requested_remedy"].requestedAmount ?? "not set"}`);
  lines.push(`- Remedy: ${s["5_requested_remedy"].remedy}`);
  lines.push(`- ${s["5_requested_remedy"].disclaimer}`);
  lines.push("");
  lines.push("## 6. Source manifest");
  lines.push("| Source | Kind | Provenance | Owner | Visibility | Attached | SHA-256 | Captured |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const src of s["6_source_manifest"].sources) {
    lines.push(
      `| ${src.id} · ${src.label} | ${src.kind} | ${src.provenance} | ${src.ownerRole} | ${src.visibility} | ${src.attached ? "yes" : "no"} | ${src.sha256 ? src.sha256.slice(0, 16) + "…" : "n/a"} | ${src.capturedAt ?? "n/a"} |`,
    );
  }
  if (s["6_source_manifest"].actions.length > 0) {
    lines.push("");
    lines.push("Actions:");
    for (const a of s["6_source_manifest"].actions)
      lines.push(
        `- ${a.at} — ${a.action} · ${a.status} · operation ${a.operationId}${a.approvalId ? ` · approval ${a.approvalId}` : ""}`,
      );
  }
  if (s["6_source_manifest"].draft) {
    lines.push("");
    lines.push(
      `Draft: v${s["6_source_manifest"].draft.version} · ${s["6_source_manifest"].draft.origin} · ${s["6_source_manifest"].draft.hash?.slice(0, 16)}…`,
    );
  }
  lines.push("");
  lines.push(`Pack hash: ${pack.packHash}`);
  return lines.join("\n");
}

/** How a buyer's letter ends when its claims cite the payment record that carries an ID. */
export function transactionReferenceLine(transactionId: string): string {
  return `Transaction ID: ${transactionId}. Please confirm the refund within 7 days.`;
}

/**
 * Render a draft's claims into a readable message with deterministic greeting and closing. A
 * buyer's letter ends with the transaction reference taken from the cited payment record, never
 * from the drafted text; without such a record the line is left out.
 */
export function renderDraftText(
  draft: DraftContent,
  snapshot: RoleSnapshot,
  recipientAlias: string,
  senderAlias: string,
  reference: { transactionId: string } | null = null,
): string {
  const greeting =
    draft.action === "merchant_provide_evidence"
      ? "To the case reviewer,"
      : `Hello ${recipientAlias},`;
  const closingReference =
    reference && draft.action !== "merchant_provide_evidence"
      ? `\n\n${transactionReferenceLine(reference.transactionId)}`
      : "";
  const body = draft.claims.map((c) => c.text.trim()).join("\n\n") + closingReference;
  const closing =
    draft.action === "merchant_provide_evidence"
      ? `Submitted on behalf of ${senderAlias}.`
      : `Thank you,\n${senderAlias}`;
  const labels = new Map(snapshot.sources.map((s) => [s.id, s.label]));
  const citations = draft.claims
    .filter((c) => c.sourceIds.length > 0)
    .map((c) => `[${c.id}] ${c.sourceIds.map((id) => labels.get(id) ?? id).join("; ")}`)
    .join("\n");
  const footer = citations ? `\n\nSources cited:\n${citations}` : "";
  const disclaimer =
    draft.action === "merchant_provide_evidence"
      ? "The provider decides the outcome."
      : "Recovery is not guaranteed.";
  return `Subject: ${draft.subject}\n\n${greeting}\n\n${body}\n\n${closing}${footer}\n\nPrepared with CancelCase (${snapshot.environment} mode). ${disclaimer}`;
}
