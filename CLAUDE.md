# CLAUDE.md — Project Context for Knowledge Assistant

This file gives Claude (and future contributors) the context needed to work in this codebase without re-deriving it from scratch each session.

## What this is

An internal RAG (Retrieval-Augmented Generation) chat assistant for Horizontal Digital employees. Users authenticate with an `@horizontal.com` account and can ask questions against **HR**, **IT**, and per-**project** knowledge bases. Answers are grounded in ingested documents and cite the source file/page.

This is part of a broader "Knowledge Assistant Platform" effort — enterprise RAG covering HR/IT/Project domains, built on Next.js + Supabase + RLS. Feature work here is gated by internal `gstack` architecture reviews before implementation — check for review sign-off before starting large structural changes, not just before merging.

## Architecture at a glance

```
User → Next.js app (RLS-authenticated) → /api/chat
                                            │
                                            ├─ lib/retrieval.ts → hybrid_search() RPC (Postgres, RLS-enforced)
                                            │     ├─ semantic leg: pgvector cosine search (384-dim embeddings)
                                            │     └─ keyword leg: Postgres full-text search (tsvector)
                                            │     → fused via Reciprocal Rank Fusion (RRF)
                                            │
                                            └─ Groq LLM (streaming), with fallback across 4 models
                                                  on rate limit / decommission / 5xx
```

Ingestion (separate path, service-role key, bypasses RLS by design):

```
Google Drive / Confluence / direct upload → scripts/ingest*.ts → lib/chunking.ts → lib/embeddings.ts (HF) → Supabase `chunks` table
```

## Key invariants — do not violate silently

1. **`lib/config.ts` is the single source of truth for RAG parameters** (embed model, embed dim, chunk size/overlap, retrieval top-k, model fallback chain). It's imported by *both* the ingest scripts and the query path specifically so they can't drift. If you change `EMBED_MODEL` or `EMBED_DIM`, that's a **re-embed migration** (the `chunks.embedding` column is `vector(384)`), not a config flip — existing embeddings become incompatible.

2. **The chat/retrieval path must use the user-JWT Supabase client, never the service-role key.** RLS is what enforces per-user knowledge-base access (open for hr/it, granted per-user for project KBs via `project_access`). The service-role key is for ingestion only. `/api/chat` explicitly requires an authenticated session — it is intentionally *not* public, because `middleware.ts` skips gating for `/api/*` routes.

3. **`hybrid_search()` must remain `SECURITY INVOKER`, never `SECURITY DEFINER`.** `SECURITY INVOKER` is what makes RLS apply to both the vector and keyword legs of the query. Migration `0001_init.sql` includes a `do $$ ... raise exception ... $$` assertion that fails the migration outright if this function is ever changed to `SECURITY DEFINER` — treat that as a hard security gate, not a bug to work around.

4. **Company email allowlist is enforced at the database trigger level** (`handle_new_user()` in `0001_init.sql`), not just client-side in the signup form. A non-`@horizontal.com` signup raises inside the trigger, which rolls back the `auth.users` insert. Don't rely on client-side validation alone if you touch signup.

## Retrieval details worth knowing

- Queries are stripped of conversational filler (`lib/retrieval.ts` → `coreQuery()`) before embedding *and* before the keyword leg — filler words like "can you tell me about" dilute the 384-dim embedding and become spurious required AND-terms in `websearch_to_tsquery`.
- Follow-up questions are contextualized by prepending the previous user turn to the search text (`searchText` param), so vague follow-ups like "how much is it?" still retrieve relevant chunks — this does not affect what's shown to the LLM as conversation history, only what's used for retrieval.
- Citations are grouped by source file (not per-chunk) so a single PDF surfaces as one citation card with all cited pages merged.
- `documents.is_current` gates retrieval — only the current version of a document is searchable. Content-hash based dedup (`0002_content_hash.sql`) lets re-ingestion recognize identical content arriving under a different filename and skip re-embedding.

## LLM fallback chain

`FALLBACK_MODELS` in `lib/config.ts` — currently `llama-3.3-70b-versatile → llama-3.1-8b-instant → openai/gpt-oss-120b → qwen/qwen3-32b`. Deliberately spans multiple model *families* (not just multiple models from one provider tier) so a daily token-quota exhaustion on one family still leaves the others available — each family has its own quota bucket on Groq. `/api/chat` advances to the next model on **any** failure (rate limit, decommission, 5xx), not just 429s, because `streamText`'s `onError` swallows streaming errors rather than throwing them — the route captures that via a closured `streamErr` variable to make fallback actually work.

If you need to verify current Groq model IDs are still valid (models get decommissioned — `gemma2-9b-it` and `mixtral-8x7b-32768` already were), there's a `scripts/test-models.ts` reference mentioned in code comments — check whether it exists before assuming.

## Ingestion sources

- **Google Drive** (`lib/gdrive.ts`, `scripts/sync-gdrive.ts`) — primary sync source. Uses a service-account JWT (RS256, minted manually via `node:crypto`, no extra OAuth library) so it works without Google Workspace admin access — the service account just needs the target folder explicitly shared with its email.
- **SharePoint** (`scripts/sync-sharepoint.ts`) — present in `package.json` scripts, but SharePoint/OneDrive sync was blocked historically due to lack of M365 admin access. Verify this script is still the intended path before relying on it; Google Drive is the confirmed working alternative.
- **Confluence** (`lib/confluence.ts`, `app/api/auth/confluence/*`) — OAuth-based sync.
- **Direct upload** — via the admin panel (`app/admin/page.tsx`, `app/api/admin/upload/route.ts`).

## Environment variables

See `README.md` for the full list with setup instructions. Notable ones:
- `SUPABASE_SERVICE_ROLE_KEY` — ingestion/admin only, never on the user-facing request path.
- `GOOGLE_PRIVATE_KEY` — tolerate values pasted with wrapping quotes (Vercel doesn't strip them like dotenv does) and literal `\n` sequences — see `getDriveToken()` in `lib/gdrive.ts` for the normalization logic if you touch this.

## Known constraints / things to check before assuming they're solved

- No Google Workspace admin access — Drive sync relies on a service account with folders explicitly shared to it, not domain-wide delegation.
- No Microsoft 365 admin access — SharePoint/OneDrive ingestion was blocked for this reason; confirm current status before building on `sync-sharepoint.ts`.
- Large structural or cross-cutting changes should go through a `gstack` review before implementation, per the org's process for this platform.

## Scripts reference

```bash
npm run dev              # local dev server
npm run ingest            # ingest a single file
npm run ingest:dir         # ingest a directory
npm run sync:gdrive        # pull from configured Google Drive folders
npm run sync:sharepoint    # SharePoint sync (verify current status — see above)
npm run parity             # compare source vs. ingested state
npm run verify:stage0      # environment/config sanity check
npm run lint               # eslint
```

## Where to look for more context

- `supabase/migrations/*.sql` — schema, RLS policies, and inline comments explain *why*, not just *what* (e.g. the `hybrid_search` security-invoker assertion).
- Inline comments throughout `lib/` and `app/api/` tend to record the *reason* for non-obvious decisions (e.g. why `/api/chat` requires auth, why filler-stripping matters for embeddings) — read them before refactoring, they usually encode a past incident or review finding.
