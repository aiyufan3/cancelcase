import type { NextConfig } from "next";

/**
 * CancelCase runs on loopback only. No image CDN, no telemetry, no external assets.
 * Server-only native/runtime packages stay external so they are never bundled.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: [
    "better-sqlite3",
    "@langchain/langgraph",
    "@langchain/langgraph-checkpoint",
    "@langchain/langgraph-checkpoint-sqlite",
    "@langchain/core",
    "@paypal/agent-toolkit",
    "langsmith",
  ],
  images: {
    // No remote images; the UI only renders local, validated evidence previews.
    remotePatterns: [],
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
