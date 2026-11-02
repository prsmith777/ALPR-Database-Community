/** @type {import('next').NextConfig} */

const nextConfig = {
  output: "standalone",
  serverExternalPackages: ["openvino-node"],
  // NFT is the build-time file tracer. Its compiled copy embeds braces and
  // must not be shipped in the Windows or Linux standalone runtime.
  outputFileTracingExcludes: {
    "**": ["**/node_modules/next/dist/compiled/@vercel/nft/**"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=()",
          },
        ],
      },
      {
        // Only the dedicated display supplies its own exact-origin CSP policy.
        source: "/((?!embed/home-assistant/[0-9a-fA-F-]{36}$).*)",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
    ];
  },
  outputFileTracingIncludes: {
    "/**": [
      "/.next",
      "/public",
      "/app",
      "/lib",
      "/components",
      "/config",
      "/middleware.js",
      "/hooks",
      "/auth",
      "/models/visual-search",
      "/package.json",
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb",
    },
  },
};

module.exports = nextConfig;
