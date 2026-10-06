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
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=()",
          },
        ],
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
