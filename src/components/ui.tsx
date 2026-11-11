import type { ReactNode } from "react";
import { formatUtc } from "@/domain/time";

export function Pill({
  tone = "neutral",
  children,
  title,
}: {
  tone?: "neutral" | "accent" | "review" | "block" | "info";
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  );
}

/**
 * The data mode, always in view: synthetic demo data offline, or a live link to PayPal Sandbox.
 * Derived from the configured mode; the description stays available as the tooltip.
 */
export function ModePill({
  environment,
  title,
}: {
  /** The configured environment: "fixture" or "sandbox". */
  environment: string;
  title?: string;
}) {
  const connected = environment === "sandbox";
  return (
    <span
      className={`mode-pill ${connected ? "mode-pill-sandbox" : "mode-pill-demo"}`}
      title={title}
    >
      {connected ? "Connected to PayPal Sandbox" : "PayPal Sandbox · demo data"}
    </span>
  );
}

export function ProvenancePill({ provenance }: { provenance: string | null | undefined }) {
  if (!provenance) return null;
  const map: Record<
    string,
    { label: string; tone: "neutral" | "accent" | "review" | "block" | "info" }
  > = {
    synthetic: { label: "synthetic fixture", tone: "neutral" },
    sandbox_api: { label: "Sandbox API observation", tone: "info" },
    user_attestation: { label: "user attestation", tone: "review" },
    merchant_confirmation_document: { label: "merchant confirmation document", tone: "accent" },
    provider_api_observation: { label: "provider API observation", tone: "info" },
  };
  const entry = map[provenance] ?? { label: provenance, tone: "neutral" as const };
  return <Pill tone={entry.tone}>{entry.label}</Pill>;
}

export function StatePill({ state }: { state: string }) {
  const tone =
    state === "SYNCED"
      ? "accent"
      : state === "BLOCKED" || state === "REJECTED"
        ? "block"
        : state === "UNKNOWN" || state === "AWAITING_APPROVAL" || state === "NEEDS_REVIEW"
          ? "review"
          : state === "EXECUTING"
            ? "info"
            : "neutral";
  return <Pill tone={tone}>{state.replace(/_/g, " ")}</Pill>;
}

/** A workspace section: a ruled heading over content, not a floating card. */
export function Card({
  title,
  subtitle,
  children,
  actions,
  id,
  className = "",
  fold,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  id?: string;
  className?: string;
  /**
   * Makes the section foldable. Folded, it is one row: the title and a one-line summary of what
   * is inside. The content stays mounted, so nothing typed into it is lost.
   */
  fold?: { open: boolean; onToggle: () => void; summary?: ReactNode; reveal?: boolean };
}) {
  const open = fold ? fold.open : true;
  return (
    <section
      className={`section ${className}`}
      aria-labelledby={id ? `${id}-title` : undefined}
      id={id}
      data-open={fold ? (open ? "true" : "false") : undefined}
      data-reveal={fold?.reveal ? "true" : undefined}
    >
      <header className="section-head">
        <div className={`min-w-0 ${open ? "max-w-[62ch]" : "flex-1"}`}>
          <h2 id={id ? `${id}-title` : undefined} className="section-title">
            {fold ? (
              <button
                type="button"
                className="fold-toggle"
                aria-expanded={open}
                aria-controls={id ? `${id}-body` : undefined}
                onClick={fold.onToggle}
              >
                <span>{title}</span>
                <svg aria-hidden="true" viewBox="0 0 16 16" className="fold-chevron">
                  <path
                    d="M4 6l4 4 4-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : (
              title
            )}
          </h2>
          {open
            ? subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>
            : fold?.summary && <p className="fold-summary">{fold.summary}</p>}
        </div>
        {open && actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div id={id ? `${id}-body` : undefined} className="section-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

export function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5">
      <dt className="text-[0.8125rem] font-semibold text-ink-muted">{label}</dt>
      <dd className={`text-sm text-ink ${mono ? "mono break-all" : ""}`}>
        {value ?? <span className="text-ink-muted">—</span>}
      </dd>
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "review" | "block" | "accent";
  children: ReactNode;
}) {
  const bg =
    tone === "info"
      ? "bg-info-soft text-info"
      : tone === "review"
        ? "bg-review-soft text-review"
        : tone === "block"
          ? "bg-block-soft text-block"
          : "bg-signal-soft text-ink";
  const edge =
    tone === "info"
      ? "border-info"
      : tone === "review"
        ? "border-review-fill"
        : tone === "block"
          ? "border-block"
          : "border-ink";
  return (
    <div
      role={tone === "block" ? "alert" : "status"}
      className={`rounded-xl border-l-4 px-4 py-3 text-sm ${bg} ${edge}`}
    >
      {children}
    </div>
  );
}

/** An event time for the views: "Nov 10, 2026 at 4:31 PM UTC". Raw text when it is not an instant. */
export function formatInstant(iso: string | null | undefined): string {
  if (!iso) return "—";
  return formatUtc(iso, { time: true }) ?? iso;
}

/** The time of day alone, for a line under the day: "4:31 PM UTC". */
export function formatClock(iso: string | null | undefined): string {
  return formatUtc(iso, { time: true })?.split(" at ")[1] ?? "";
}

/** A calendar day for the views, where the time adds nothing: "Nov 10, 2026". */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  return formatUtc(iso) ?? iso;
}
