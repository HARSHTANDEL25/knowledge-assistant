// Single source of truth for the RAG pipeline params.
// Imported by BOTH scripts/ingest.ts and the query path so ingest and query
// can never drift (eng-review DRY finding). Changing EMBED_MODEL/EMBED_DIM is a
// re-embed migration, not a config flip — the pgvector column is vector(384).

export const EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
export const EMBED_DIM = 384;

export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 200;
export const SEPARATORS = ["\n\n", "\n", " ", ""];

export const RETRIEVAL_TOP_K = 8;

// Groq fallback chain. On ANY failure (rate limit, decommissioned, 5xx) the
// chat route advances to the next model. Each model has its OWN daily token
// quota, and mixing families (llama / gpt-oss / qwen) spreads load across
// separate rate-limit buckets — so a TPD exhaustion on one still leaves the
// rest available. Verify ids against `npx tsx scripts/test-models.ts`;
// gemma2-9b-it and mixtral-8x7b-32768 were decommissioned by Groq.
export const FALLBACK_MODELS = [
  "llama-3.3-70b-versatile", // primary — most capable
  "llama-3.1-8b-instant",    // separate quota, fast
  "openai/gpt-oss-120b",     // different family → separate bucket, strong
  "qwen/qwen3-32b",          // last-resort, separate bucket
];

// HF moved off the old api-inference.huggingface.co host (now dead in DNS).
// Current endpoint is the router + hf-inference provider.
export const HF_FEATURE_EXTRACTION_URL =
  `https://router.huggingface.co/hf-inference/models/${EMBED_MODEL}/pipeline/feature-extraction`;
