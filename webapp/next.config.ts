import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The runtime image (node:24-alpine, webapp/Dockerfile) doesn't install
  // `sharp` -- next/image's optimization pipeline needs it in production.
  // The logo is a small local asset with no need for responsive variants,
  // so serving it unoptimized avoids that dependency entirely.
  images: { unoptimized: true },
};

export default nextConfig;
