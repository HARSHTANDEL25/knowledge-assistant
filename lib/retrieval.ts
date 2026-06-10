// Hybrid retrieval for the chat path. Embeds the question, calls hybrid_search
// (RLS-enforced under whatever client is passed — user-JWT or anon), and returns
// the context string + de-duplicated citations.

import { embedOne } from "./embeddings";
import { RETRIEVAL_TOP_K } from "./config";

export type Source = { source_file: string; page_number: number | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = any;

export async function retrieve(supabase: Supa, kbSlug: string, question: string) {
  const { data: kb } = await supabase
    .from("knowledge_bases")
    .select("id, name")
    .eq("slug", kbSlug)
    .single();
  if (!kb) return { kbName: kbSlug, context: "", citations: [] as Source[] };

  const queryEmbedding = await embedOne(question);
  const { data: chunks, error } = await supabase.rpc("hybrid_search", {
    query_text: question,
    query_embedding: queryEmbedding,
    filter_kb_id: kb.id,
    match_count: RETRIEVAL_TOP_K,
  });
  if (error) throw error;

  const docs = chunks ?? [];
  const context = docs.map((d: { content: string }) => d.content).join("\n\n");

  const seen = new Set<string>();
  const citations: Source[] = [];
  for (const d of docs) {
    const sf: string = d.metadata?.source_file ?? "unknown";
    const pg: number | null = d.metadata?.page_number ?? null;
    const key = `${sf}|${pg}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({ source_file: sf, page_number: pg });
    }
  }
  return { kbName: kb.name as string, context, citations };
}
