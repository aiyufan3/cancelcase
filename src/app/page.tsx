import Link from "next/link";
import { cookies } from "next/headers";
import { Tilt } from "@/components/Tilt";
import { Wordmark } from "@/components/Wordmark";
import { ModePill, Pill, StatePill, formatInstant } from "@/components/ui";
import { Amount } from "@/components/workbench/CaseOverview";
import { getAppContext } from "@/server/context";
import { describeMode } from "@/server/config";
import { listCaseSummaries } from "@/server/services/case-view";
import { ROLE_COOKIE, decodeRoleCookie } from "@/server/http/session";

export const dynamic = "force-dynamic";

const STEPS: [string, string][] = [
  [
    "Record",
    "Write down when the cancellation takes effect and keep the documents that prove it. Recording it does not cancel anything.",
  ],
  [
    "Check",
    "A deterministic check flags a completed charge initiated after that time and explains every reason in plain words.",
  ],
  [
    "Approve, then act",
    "Drafts cite their sources and are validated on the server. Nothing is exported or sent without a fresh approval of the exact version, and every result is read back.",
  ],
];

export default async function HomePage() {
  const ctx = getAppContext();
  const jar = await cookies();
  const role = decodeRoleCookie(ctx, jar.get(ROLE_COOKIE)?.value) ?? "buyer";
  const mode = describeMode(ctx.config.mode);
  const cases = listCaseSummaries(ctx, role);
  const lead = cases[0] ?? null;
  const rest = cases.slice(1);
  return (
    <main id="main" className="mx-auto max-w-[1180px] px-4 pb-24 pt-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Wordmark />
        <ModePill environment={ctx.config.mode} title={mode.description} />
      </header>

      <section className="mt-10 grid items-center gap-10 lg:mt-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="max-w-[34rem]">
          <h1 className="text-[2.6rem] font-extrabold leading-[1.02] tracking-[-0.035em] sm:text-6xl">
            Cancelled, still charged? Prove it. File it. Track it.
          </h1>
          <p className="mt-5 text-lg text-ink-soft">
            Most dispute tooling is built for sellers. CancelCase is for the person who was charged:
            it proves when you cancelled, catches the charge that came after, and prepares the case
            you review word by word before anything leaves this computer.
          </p>
          <p className="mt-3 text-ink-soft">
            Recovery is never guaranteed. The merchant or PayPal decides; CancelCase only makes the
            request precise, traceable and safe to send.
          </p>
          <p className="mt-5 text-sm text-ink-muted">{mode.description}</p>
        </div>

        {lead ? (
          <Tilt>
            <div className="folder px-4 pb-5 pt-6 sm:px-7 sm:pb-7">
              <div className="folder-tab">
                <span>{lead.subscriptionLabel ?? "Subscription"}</span>
              </div>
              <p className="relative text-lg font-extrabold tracking-tight">
                {lead.buyerAlias} and {lead.merchantAlias}
              </p>
              <div className="receipt mt-4 px-5 pb-9 pt-5 sm:px-7">
                <p className="text-sm font-semibold text-ink-muted">
                  {lead.classification === "NO_ANOMALY"
                    ? "Charge amount (nothing under review)"
                    : "Amount under review"}
                </p>
                <div className="mt-2">
                  <Amount
                    cents={lead.amountUnderReviewCents}
                    label={
                      lead.amountUnderReviewCents === null
                        ? "Unknown amount"
                        : `$${(lead.amountUnderReviewCents / 100).toFixed(2)} USD`
                    }
                  />
                </div>
                <p className="mt-4 text-ink-soft">
                  <strong className="text-ink">{lead.classificationTitle}.</strong>{" "}
                  {lead.chargeTime
                    ? `Charge initiated ${formatInstant(lead.chargeTime)}.`
                    : "Charge time unknown."}
                </p>
                <p className="mt-3 flex flex-wrap gap-2">
                  <StatePill state={lead.roleState} />
                  <Pill tone="neutral">{lead.channel.replace(/_/g, " ")}</Pill>
                </p>
              </div>
              <p className="mt-5 flex flex-wrap items-center gap-3">
                <Link
                  href={`/cases/${lead.id}`}
                  className="btn btn-primary px-6 text-base"
                  aria-describedby="lead-case-note"
                >
                  Open case
                </Link>
                <span id="lead-case-note" className="text-sm text-ink-soft">
                  {role === "buyer" ? "Buyer" : "Merchant"} view, case{" "}
                  <span className="mono">{lead.id}</span>
                </span>
              </p>
            </div>
          </Tilt>
        ) : (
          <div className="folder px-6 pb-7 pt-6">
            <div className="folder-tab">
              <span>No cases yet</span>
            </div>
            <p className="relative text-lg font-bold">The folder is empty.</p>
            <p className="relative mt-2 text-ink-soft">
              Run <code className="mono">pnpm demo</code> to seed the synthetic fixture case, then
              reload this page.
            </p>
          </div>
        )}
      </section>

      {rest.length > 0 && (
        <section className="section mt-16" aria-labelledby="cases-title">
          <div className="section-head">
            <h2 id="cases-title" className="section-title">
              Other cases ({role} view)
            </h2>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {rest.map((c) => (
              <li
                key={c.id}
                className="sheet flex flex-wrap items-center justify-between gap-3 p-4"
              >
                <span className="min-w-0">
                  <span className="block font-bold">
                    {c.buyerAlias} and {c.merchantAlias}
                  </span>
                  <span className="text-sm text-ink-muted">
                    {c.classificationTitle}
                    {c.claimableText ? `, ${c.claimableText} under review` : ""}
                  </span>
                </span>
                <Link href={`/cases/${c.id}`} className="btn btn-secondary">
                  Open case<span className="sr-only"> for {c.buyerAlias}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="section mt-16" aria-labelledby="how-title">
        <div className="section-head">
          <h2 id="how-title" className="section-title">
            How a case moves
          </h2>
        </div>
        <ol className="grid gap-6 sm:grid-cols-3">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="flex gap-4">
              <span
                aria-hidden="true"
                className="keycap flex h-11 w-11 shrink-0 items-center justify-center text-lg font-extrabold"
              >
                {i + 1}
              </span>
              <span>
                <span className="block font-extrabold">{title}</span>
                <span className="mt-1 block text-sm text-ink-soft">{body}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
