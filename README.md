# Knowledge Assistant

An internal AI chat assistant for Horizontal Digital employees to ask questions against company knowledge bases (HR, IT, and per-project docs) and get grounded answers with citations back to the source documents.

Built with Next.js (App Router), Supabase (Postgres + pgvector), and Groq-hosted LLMs, using hybrid (semantic + keyword) retrieval over ingested documents.

## Features

- **Multi-knowledge-base chat** — HR and IT knowledge bases are open to all authenticated employees; project knowledge bases are access-restricted per user via Supabase Row Level Security (RLS).
- **Hybrid retrieval** — combines pgvector semantic search (via `all-MiniLM-L6-v2` embeddings, 384 dims) with Postgres full-text search, fused with Reciprocal Rank Fusion (RRF).
- **Cited answers** — responses reference the source document(s) and page numbers/URLs they were grounded in.
- **Follow-up aware** — recent conversation turns are used to contextualize vague follow-up questions before retrieval.
- **Multi-model fallback** — chat requests fall back across multiple Groq models (`llama-3.3-70b-versatile` → `llama-3.1-8b-instant` → `openai/gpt-oss-120b` → `qwen/qwen3-32b`) on rate limits or provider errors, so a single provider hiccup doesn't take the assistant down.
- **Multiple ingestion sources** — Google Drive (service account, no Workspace admin required), Confluence, and direct file upload via the admin panel.
- **Admin panel** — manage knowledge bases, per-project user access, and trigger/monitor document sync.
- **Company-restricted signup** — new accounts are limited to `@horizontal.com` email addresses, enforced at the database trigger level (not just client-side).

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19 |
| Database | Supabase (Postgres + `pgvector` + RLS) |
| LLM | Groq (`@ai-sdk/groq` via Vercel AI SDK), streaming responses |
| Embeddings | `all-MiniLM-L6-v2` run in-process with transformers.js (free, no API key) |
| Chunking | `@langchain/textsplitters` |
| PDF parsing | `unpdf` |
| Styling | Tailwind CSS |
| Ingestion sources | Google Drive, Confluence, direct upload |

## Getting Started

### Prerequisites

- Node.js 20+
- A Supabase project (Postgres with the `vector` extension available)
- A Groq API key
- (Optional) Google Cloud service account for Drive sync, and/or Confluence OAuth app for Confluence sync

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.local.example` (or create `.env.local`) with the following keys:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=       # ingestion only — never used on the user request path
NEXT_PUBLIC_APP_URL=

GROQ_API_KEY=

# Google Drive sync (service account — no Workspace admin needed)
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=
DRIVE_HR_FOLDER_ID=
DRIVE_IT_FOLDER_ID=

# Confluence sync
CONFLUENCE_BASE_URL=
CONFLUENCE_CLIENT_ID=
CONFLUENCE_CLIENT_SECRET=
CONFLUENCE_EMAIL=
CONFLUENCE_TOKEN=
```

### 3. Apply database migrations

Run the SQL files under `supabase/migrations/` (in order) against your Supabase project — via the Supabase SQL editor or the Supabase CLI.

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Ingesting Documents

```bash
npm run ingest          # ingest a single file
npm run ingest:dir      # ingest a directory of files
npm run sync:gdrive     # sync from configured Google Drive folders
npm run sync:sharepoint # sync from SharePoint (legacy — see CLAUDE.md)
npm run parity          # compare source vs. ingested state
npm run verify:stage0   # environment / config sanity check
```

## Project Structure

```
app/
  api/
    chat/            → RAG chat endpoint (auth-gated, streaming)
    admin/           → KB + user + sync management endpoints
    auth/confluence/  → Confluence OAuth callback
  admin/             → Admin panel UI
  login/, signup/    → Auth pages
lib/
  config.ts          → single source of truth for RAG params (embed model, chunk size, retrieval top-k, model fallback chain)
  retrieval.ts        → hybrid search + citation assembly
  embeddings.ts       → HF embedding calls
  chunking.ts         → document chunking
  gdrive.ts, confluence.ts → ingestion source integrations
  groq.ts             → Groq client setup
scripts/              → CLI ingestion/sync/verification scripts
supabase/migrations/   → schema, RLS policies, hybrid_search() SQL function
utils/supabase/        → Supabase client factories (browser/server/middleware)
```

## Security Model

- All chat/retrieval requests run under the **user's JWT** — RLS on `chunks`/`documents`/`knowledge_bases` enforces what each user can see, including for project-restricted knowledge bases.
- The **service-role key is used only during ingestion** (server-side scripts/admin routes), never on the request path a browser session drives.
- `hybrid_search()` is `SECURITY INVOKER` by design (RLS applies to it); a migration-time assertion fails the migration if this is ever changed to `SECURITY DEFINER`, since that would bypass RLS and leak restricted content.

See `CLAUDE.md` for deeper architectural context, known constraints, and in-progress work.
