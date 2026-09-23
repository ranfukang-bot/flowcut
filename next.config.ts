import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Product creation accepts several images in one multipart request.
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;
