// HuggingFace Inference API embeddings (ports EmbeddingManager from app.py).
// HF embeds BOTH ingestion AND every live query, so this is on the user-facing
// path — retry-with-backoff here, and the caller surfaces a visible error
// instead of a silent empty result (eng-review SPOF finding).

import { EMBED_DIM, HF_FEATURE_EXTRACTION_URL } from "./config";

const MAX_RETRIES = 4;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Embed one or more texts. Returns one number[] per input text.
 * Throws after MAX_RETRIES so the caller can show "search unavailable, retry".
 */
export async function embed(texts: string[]): Promise<number[][]> {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error("HF_TOKEN is not set");
  if (texts.length === 0) return [];

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(HF_FEATURE_EXTRACTION_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: texts,
          options: { wait_for_model: true },
        }),
      });

      // 503 = model cold-starting; 429 = rate limit. Both are retryable.
      if (res.status === 503 || res.status === 429) {
        throw new Error(`HF transient ${res.status}`);
      }
      if (!res.ok) {
        throw new Error(`HF error ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as number[][];
      if (!Array.isArray(data) || !Array.isArray(data[0])) {
        throw new Error("HF returned unexpected shape");
      }
      if (data[0].length !== EMBED_DIM) {
        throw new Error(
          `HF dim ${data[0].length} != expected ${EMBED_DIM} — model/column mismatch`,
        );
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES - 1) await sleep(1000 * 2 ** attempt); // 1s,2s,4s
    }
  }
  throw new Error(`Embedding failed after ${MAX_RETRIES} attempts: ${lastErr}`);
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0];
}
