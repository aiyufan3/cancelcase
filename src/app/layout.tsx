import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CancelCase — the buyer's side of a PayPal dispute",
  description:
    "Cancelled, still charged? Prove it. File it. Track it. CancelCase proves when you cancelled, flags a charge that came after, drafts a case in which every fact is cited, and sends only what a person approved. Recovery is never guaranteed.",
  applicationName: "CancelCase",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f1eee7",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-signal focus:px-4 focus:py-2 focus:text-ink"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
