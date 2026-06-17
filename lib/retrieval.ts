// Hybrid retrieval for the chat path. Embeds the question, calls hybrid_search
// (RLS-enforced under whatever client is passed — user-JWT or anon), and returns
// the context string + de-duplicated citations.

import { embedOne } from "./embeddings";
import { RETRIEVAL_TOP_K } from "./config";

// Strips conversational filler so the embedding captures semantic intent rather
// than averaging over stop-phrase tokens ("can i get the info about" → "").
// all-MiniLM-L6-v2 at 384 dims is sensitive to token dilution.
const FILLER_RE =
  /^(can\s+(you|i)\s+|could\s+you\s+|please\s+|i\s+want\s+to\s+know\s+|tell\s+me\s+(about\s+)?|what\s+is\s+(the\s+)?|how\s+to\s+|give\s+me\s+(the\s+)?info(\s+about)?\s+|get\s+(the\s+)?info(\s+about)?\s+|info\s+about\s+|the\s+info\s+about\s+)/i;

function coreQuery(q: string): string {
  let s = q.trim();
  let prev = "";
  while (s !== prev) { prev = s; s = s.replace(FILLER_RE, "").trim(); }
  return s || q;
}

export type Source = { source_file: string; page_number: number | null; source_url?: string | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = any;

export async function retrieve(supabase: Supa, kbSlug: string, question: string) {
  const { data: kb } = await supabase
    .from("knowledge_bases")
    .select("id, name")
    .eq("slug", kbSlug)
    .single();
  if (!kb) return { kbName: kbSlug, context: "", citations: [] as Source[] };

  // Strip filler for BOTH legs: the keyword leg is hurt by filler words that
  // become required AND-terms in websearch_to_tsquery ("info" in "get the info
  // about figma" would exclude docs that don't contain "info").
  const core = coreQuery(question);
  const queryEmbedding = await embedOne(core);
  const { data: chunks, error } = await supabase.rpc("hybrid_search", {
    query_text: core,
    query_embedding: queryEmbedding,
    filter_kb_id: kb.id,
    match_count: RETRIEVAL_TOP_K,
    full_text_weight: 1.5,
    semantic_weight: 1.0,
  });
  if (error) throw error;

  const docs = chunks ?? [];
  const context = docs.map((d: { content: string }) => d.content).join("\n\n");

  // Confluence base used to synthesize a click-through URL for chunks ingested
  // before source_url was stored (they still carry confluence_page_id).
  const cfBase = (process.env.CONFLUENCE_BASE_URL ?? "").replace(/\/+$/, "");

  const seen = new Set<string>();
  const citations: Source[] = [];
  for (const d of docs) {
    const sf: string = d.metadata?.source_file ?? "unknown";
    const pg: number | null = d.metadata?.page_number ?? null;
    const pid: string | null = d.metadata?.confluence_page_id ?? null;
    const url: string | null =
      d.metadata?.source_url ??
      (pid && cfBase ? `${cfBase}/wiki/pages/viewpage.action?pageId=${pid}` : null);
    const key = `${sf}|${pg}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({ source_file: sf, page_number: pg, source_url: url });
    }
  }
  return { kbName: kb.name as string, context, citations };
}
