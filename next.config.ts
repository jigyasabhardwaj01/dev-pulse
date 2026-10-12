import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The earlier Team Review and Monday Pack pages were folded into Explore & Decide and the Weekly Action Plan.
  async redirects() {
    return [
      { source: "/review", destination: "/explore", permanent: false },
      { source: "/pack", destination: "/plan", permanent: false },
    ];
  },
};

export default nextConfig;
