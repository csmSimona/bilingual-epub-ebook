import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["jszip", "fast-xml-parser", "htmlparser2"]
};

export default nextConfig;
