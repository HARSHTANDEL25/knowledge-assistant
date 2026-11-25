// Local embeddings via transformers.js — the same all-MiniLM-L6-v2 model the
// HF Inference API used to serve, run in-process instead of over the network.
//
// Why local: HF Inference Providers stopped serving free accounts (every call
// returned 402 "Purchase pre-paid credits"). Running the model ourselves keeps
// the app on free tiers only: the model weights are downloaded once per cold
// start from the public Hub (free, no inference credits), then cached in /tmp.
//
// Vector compatibility: mean pooling + L2 normalisation is exactly what the
// sentence-transformers pipeline did server-side, so query vectors line up with
// the 384-dim vectors already stored in chunks.embedding — no re-ingest needed.

import { EMBED_DIM, EMBED_MODEL } from "./config";

type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      // Serverless filesystems are read-only except /tmp.
      if (process.env.VERCEL) env.cacheDir = "/tmp/transformers-cache";
      env.allowLocalModels = false;
      const extractor = await pipeline("feature-extraction", EMBED_MODEL, {
        dtype: "fp32", // full precision, to match the vectors already stored
      });
      return extractor as unknown as Extractor;
    })().catch((err) => {
      extractorPromise = null; // let the next request retry a failed load
      throw err;
    });
  }
  return extractorPromise;
}

const BATCH_SIZE = 32;

/**
 * Embed one or more texts. Returns one number[] per input text.
 * Throws on failure so the caller can show "search unavailable, retry".
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const tensor = await extractor(batch, { pooling: "mean", normalize: true });
    out.push(...tensor.tolist());
  }

  if (out[0]?.length !== EMBED_DIM) {
    throw new Error(
      `embedding dim ${out[0]?.length} != expected ${EMBED_DIM} — model/column mismatch`,
    );
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0];
}
