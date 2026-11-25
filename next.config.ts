import type { NextConfig } from "next";

const ONNX_LINUX_CPU = [
  "node_modules/onnxruntime-node/bin/napi-v*/linux/x64/onnxruntime_binding.node",
  "node_modules/onnxruntime-node/bin/napi-v*/linux/x64/libonnxruntime.so.1",
];

const nextConfig: NextConfig = {
  // transformers.js loads onnxruntime-node's native binary at runtime, so both
  // must stay as real node_modules rather than being bundled.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "sharp"],

  // onnxruntime-node picks its binary with a computed require path
  // (bin/napi-v6/${platform}/${arch}), which file tracing cannot follow — so
  // include Vercel's linux-x64 binary explicitly for the routes that embed.
  // Only the CPU binding + core lib: on Linux the onnxruntime-node install
  // script also downloads GPU providers (CUDA/TensorRT, hundreds of MB) that a
  // CPU-only function never loads and that push it past the 250 MB limit.
  outputFileTracingIncludes: {
    "/api/chat": ONNX_LINUX_CPU,
    "/api/admin/**": ONNX_LINUX_CPU,
  },

  // onnxruntime-node ships binaries for every OS (~290 MB total). Vercel runs
  // linux-x64 and caps a function at 250 MB, so trace only that one.
  outputFileTracingExcludes: {
    "/*": [
      "node_modules/onnxruntime-node/bin/napi-v*/darwin/**",
      "node_modules/onnxruntime-node/bin/napi-v*/win32/**",
      "node_modules/onnxruntime-node/bin/napi-v*/linux/arm64/**",
      "node_modules/onnxruntime-node/bin/napi-v*/linux/x64/libonnxruntime_providers_*",
      "node_modules/@img/sharp-*darwin*/**",
      "node_modules/@img/sharp-*win32*/**",
    ],
  },
};

export default nextConfig;
