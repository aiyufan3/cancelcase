import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";

/**
 * Landing page for the PayPal Sandbox return and cancel URLs of the operator setup. It is static:
 * it never reads or echoes query parameters (they can carry tokens), and it never treats the
 * redirect itself as proof of anything — only a provider read-back counts.
 */
export function SandboxReturn({ kind }: { kind: "approved" | "cancelled" | "consent" }) {
  if (kind === "consent") return <ConsentReturn />;
  const approved = kind === "approved";
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 pb-24 pt-8 sm:px-6">
      <header>
        <Wordmark />
      </header>
      <section className="card mt-10 p-6" aria-labelledby="return-title">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          PayPal Sandbox · operator setup
        </p>
        <h1 id="return-title" className="mt-2 text-3xl font-extrabold tracking-tight">
          {approved ? "You came back from PayPal." : "You left the PayPal approval."}
        </h1>
        <p className="mt-4 text-ink-soft">
          {approved
            ? "Returning to this page does not prove that the subscription was approved or that any payment happened. CancelCase only records what it reads back from PayPal."
            : "Nothing was recorded from this page. The subscription may still be waiting for approval; PayPal is the only source of its current status."}
        </p>
        <p className="mt-4 text-ink-soft">Next, in your terminal:</p>
        <pre className="mono mt-2 overflow-x-auto rounded-xl border border-line bg-paper px-4 py-3 text-sm">
          pnpm sandbox:setup --resume
        </pre>
        <p className="mt-3 text-sm text-ink-muted">
          It reads the subscription and its transactions back. A connected case is created only when
          PayPal reports the subscription as active.
        </p>
        <p className="mt-6">
          <Link href="/" className="font-semibold underline underline-offset-4">
            Back to cases
          </Link>
        </p>
      </section>
    </main>
  );
}

/**
 * Return URL of the Sandbox buyer consent (Log in with PayPal). The redirect carries an
 * authorization code in its query; the proxy drops it before this page renders, and the page
 * never claims that consent took effect — only the buyer assertion probe can show that.
 */
function ConsentReturn() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 pb-24 pt-8 sm:px-6">
      <header>
        <Wordmark />
      </header>
      <section className="card mt-10 p-6" aria-labelledby="return-title">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          PayPal Sandbox · buyer consent
        </p>
        <h1 id="return-title" className="mt-2 text-3xl font-extrabold tracking-tight">
          You came back from the PayPal consent page.
        </h1>
        <p className="mt-4 text-ink-soft">
          Returning to this page does not prove that consent was granted. CancelCase keeps nothing
          from this redirect; the buyer assertion probe is the check.
        </p>
        <p className="mt-4 text-ink-soft">Next, in your terminal:</p>
        <pre className="mono mt-2 overflow-x-auto rounded-xl border border-line bg-paper px-4 py-3 text-sm">
          pnpm sandbox:check
        </pre>
        <p className="mt-6">
          <Link href="/" className="font-semibold underline underline-offset-4">
            Back to cases
          </Link>
        </p>
      </section>
    </main>
  );
}
