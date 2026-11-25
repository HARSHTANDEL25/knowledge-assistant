import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // transformers.js loads onnxruntime-node's native binary at runtime, so both
  // must stay as real node_modules rather than being bundled.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "sharp"],

  // onnxruntime-node picks its binary with a computed require path
  // (bin/napi-v6/${platform}/${arch}), which file tracing cannot follow — so
  // include Vercel's linux-x64 binary explicitly for the routes that embed.
  outputFileTracingIncludes: {
    "/api/chat": ["node_modules/onnxruntime-node/bin/napi-v*/linux/x64/**"],
    "/api/admin/**": ["node_modules/onnxruntime-node/bin/napi-v*/linux/x64/**"],
  },

  // onnxruntime-node ships binaries for every OS (~290 MB total). Vercel runs
  // linux-x64 and caps a function at 250 MB, so trace only that one.
  outputFileTracingExcludes: {
    "/*": [
      "node_modules/onnxruntime-node/bin/napi-v*/darwin/**",
      "node_modules/onnxruntime-node/bin/napi-v*/win32/**",
      "node_modules/onnxruntime-node/bin/napi-v*/linux/arm64/**",
      "node_modules/@img/sharp-*darwin*/**",
      "node_modules/@img/sharp-*win32*/**",
    ],
  },
};

export default nextConfig;
