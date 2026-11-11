"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { CaseView } from "@/server/services/case-view";
import { apiPost, apiUpload } from "@/lib/client-api";
import { Pill, ProvenancePill, formatInstant } from "../ui";
import { FoldCard, LocalStatus, useWorkbench } from "./shared";

const KIND_LABEL: Record<string, string> = {
  communication: "Message",
  receipt: "Receipt",
  cancellation_confirmation: "Cancellation confirmation",
  charge_record: "Charge record",
  screenshot: "Screenshot",
  merchant_record: "Merchant record",
  note: "Note",
  other: "Document",
};

/** Evidence as a pile of readable documents. A new document settles in only once it is stored. */
export function EvidenceStack({ className = "" }: { className?: string }) {
  const { view, role, focusedEvidenceId, peekEvidenceId } = useWorkbench();
  const known = useRef<Set<string> | null>(null);
  useLayoutEffect(() => {
    const ids = view.evidence.map((e) => e.id);
    if (known.current) {
      for (const id of ids)
        if (!known.current.has(id)) document.getElementById(`doc-${id}`)?.classList.add("settle");
    }
    known.current = new Set(ids);
  }, [view.evidence]);

  return (
    <FoldCard
      className={className}
      id="evidence"
      summary={`${view.evidence.length} document${view.evidence.length === 1 ? "" : "s"}.`}
      title={`Evidence visible to the ${role}`}
      subtitle={`${view.evidence.length} document${view.evidence.length === 1 ? "" : "s"}. Private documents stay with you: they never reach the other role, a model or a recipient unless you include them in a draft.`}
    >
      <ul className="doc-stack flex flex-col gap-3 pt-1">
        {view.evidence.map((e) => (
          <li key={e.id}>
            <article
              id={`doc-${e.id}`}
              tabIndex={-1}
              className="doc p-4"
              data-focused={focusedEvidenceId === e.id ? "true" : "false"}
              data-peek={peekEvidenceId === e.id ? "true" : "false"}
              aria-labelledby={`doc-${e.id}-title`}
            >
              <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-xs font-semibold text-ink-muted">
                  {KIND_LABEL[e.kind] ?? e.kind.replace(/_/g, " ")}
                  {e.eventTime ? `, ${formatInstant(e.eventTime)}` : ""}
                </p>
                <span className="flex flex-wrap gap-1.5">
                  <Pill tone={e.visibility === "shared" ? "info" : "neutral"}>
                    {e.visibility === "shared" ? "shared" : `${e.ownerRole} private`}
                  </Pill>
                  <ProvenancePill provenance={e.provenance} />
                </span>
              </header>
              <h3 id={`doc-${e.id}-title`} className="mt-1 font-bold leading-snug">
                {e.label}
              </h3>
              {e.textExcerpt && (
                <p className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap border-l-2 border-line pl-3 text-sm text-ink-soft">
                  {e.textExcerpt}
                </p>
              )}
              {e.hasFile && e.mime?.startsWith("image/") && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/evidence/${e.id}?inline=1`}
                  alt={e.label}
                  className="mt-2 max-h-40 rounded-lg border border-line"
                />
              )}
              <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
                <span>
                  {e.mime ?? "no file"}
                  {e.sizeBytes ? `, ${(e.sizeBytes / 1024).toFixed(1)} KB` : ""}
                  {e.sha256Short ? (
                    <span className="mono">
                      {" "}
                      sha256 {e.sha256Short}… (byte integrity, not truth)
                    </span>
                  ) : null}
                </span>
                {e.hasFile && (
                  <a className="link text-sm" href={`/api/evidence/${e.id}`}>
                    Download
                  </a>
                )}
              </footer>
            </article>
          </li>
        ))}
      </ul>
      <p className="mt-4 flex flex-wrap gap-2">
        <a className="btn btn-secondary" href={`/api/cases/${view.case.id}/export?format=md`}>
          Download local archive (Markdown)
        </a>
        <a className="btn btn-secondary" href={`/api/cases/${view.case.id}/export?format=json`}>
          JSON
        </a>
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        The local archive holds everything this view can see. It is for you, not for sending.
      </p>
      <AddEvidence view={view} />
      <ContactHistory view={view} />
    </FoldCard>
  );
}

function AddEvidence({ view }: { view: CaseView }) {
  const { role, run } = useWorkbench();
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("communication");
  const [visibility, setVisibility] = useState<"private" | "shared">("private");
  const [label, setLabel] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const upload = () =>
    run(
      "Storing evidence",
      async () => {
        if (!file) throw new Error("Choose a file first.");
        const form = new FormData();
        form.append("file", file);
        form.append("kind", kind);
        form.append("visibility", visibility);
        form.append("label", label || file.name);
        return apiUpload<{ view: CaseView }>(`/api/cases/${view.case.id}/evidence`, form);
      },
      "Evidence stored on this computer with its hash. Open approvals were invalidated.",
      "evidence-add",
    ).then((ok) => {
      if (!ok) return;
      setFile(null);
      setLabel("");
      setInputKey((k) => k + 1);
    });
  return (
    <details className="mt-5 border-t border-line pt-2">
      <summary>Add a document</summary>
      <form
        className="mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          void upload();
        }}
      >
        <p className="text-xs text-ink-muted">
          PDF, PNG, JPEG or UTF-8 text, up to {view.evidenceLimits.maxFileBytes / 1024 / 1024} MB
          per file and {view.evidenceLimits.maxFilesPerPack} files per submission. Content is
          checked; file names are not trusted.
        </p>
        <label className="mt-3 block">
          <span className="label">File</span>
          <input
            key={inputKey}
            className="field"
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.txt,application/pdf,image/png,image/jpeg,text/plain"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">Kind</span>
            <select className="field" value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABEL).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Who can see it</span>
            <select
              className="field"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as typeof visibility)}
            >
              <option value="private">Only the {role}</option>
              <option value="shared">Shared with the other role</option>
            </select>
          </label>
        </div>
        <label className="mt-3 block">
          <span className="label">Label</span>
          <input
            className="field"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What is this document?"
          />
        </label>
        <button type="submit" className="btn btn-primary mt-3" disabled={!file}>
          Store evidence
        </button>
        <LocalStatus scope="evidence-add" />
      </form>
    </details>
  );
}

function ContactHistory({ view }: { view: CaseView }) {
  const { role, run } = useWorkbench();
  const [summary, setSummary] = useState("");
  const [at, setAt] = useState("");
  return (
    <div className="mt-2 border-t border-line pt-2">
      {view.contactHistory.length > 0 && (
        <ul className="mb-2 space-y-1 text-sm">
          {view.contactHistory.map((c) => (
            <li key={c.id}>
              <span className="mono text-ink-muted">{formatInstant(c.at)}</span>{" "}
              {c.direction.replace(/_/g, " ")}: {c.summary}{" "}
              {c.shared && <Pill tone="info">shared</Pill>}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>Record contact history</summary>
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              "Recording contact",
              () =>
                apiPost<CaseView>(`/api/cases/${view.case.id}/contact`, {
                  at,
                  direction: role === "buyer" ? "buyer_to_merchant" : "merchant_to_buyer",
                  summary,
                  shared: true,
                }),
              "Contact recorded as a user attestation.",
              "contact",
            ).then((ok) => {
              if (!ok) return;
              setSummary("");
              setAt("");
            });
          }}
        >
          <p className="text-xs text-ink-muted">
            Only what actually happened. An empty history stays empty; it is never filled in for
            you.
          </p>
          <label className="mt-3 block">
            <span className="label">When (ISO, with offset)</span>
            <input
              className="field mono"
              value={at}
              onChange={(e) => setAt(e.target.value)}
              placeholder="2026-11-08T14:00:00Z"
            />
          </label>
          <label className="mt-3 block">
            <span className="label">What was said</span>
            <textarea
              className="field"
              rows={3}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="e.g. Emailed support asking for a refund of the November charge."
            />
          </label>
          <button
            type="submit"
            className="btn btn-secondary mt-3"
            disabled={!summary.trim() || !at.trim()}
          >
            Save contact
          </button>
          <LocalStatus scope="contact" />
        </form>
      </details>
    </div>
  );
}
