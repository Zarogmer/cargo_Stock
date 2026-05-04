import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `ws` is a Node-only library — keep it external so Next.js doesn't try
  // to bundle it for any non-Node target.
  serverExternalPackages: ["ws"],

  // PWA headers
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
