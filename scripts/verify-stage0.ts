// Stage 0 acceptance check.
// Seeds one document + chunk into an open (hr) KB, then runs hybrid_search and
// prints the result — proving pgvector + full-text + RRF + embeddings work
// end to end. Re-runnable (deletes its own seed first).
//
//   npm run verify:stage0
//
// Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HF_TOKEN
// and the 0001_init.sql migration already applied.

import { config } from "dotenv";
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { embedOne } from "../lib/embeddings";
import { RETRIEVAL_TOP_K } from "../lib/config";

const SEED_CONTENT =
  "Employees are entitled to 25 days of paid annual leave per calendar year. " +
  "Unused leave does not roll over. Requests must be approved by your manager.";
const QUERY = "how many vacation days do staff get each year?";

async function main() {
  const db = createAdminClient();

  // 1. open (hr) KB
  const { data: kb, error: kbErr } = await db
    .from("knowledge_bases")
    .upsert({ type: "hr", name: "HR", slug: "hr" }, { onConflict: "slug" })
    .select()
    .single();
  if (kbErr) throw kbErr;

  // 2. clear any prior seed (re-runnable)
  await db.from("documents").delete().eq("source", "stage0-seed");

  // 3. seed document (current version, ready)
  const { data: doc, error: docErr } = await db
    .from("documents")
    .insert({
      kb_id: kb.id,
      source: "stage0-seed",
      title: "Leave Policy (seed)",
      status: "ready",
      is_current: true,
    })
    .select()
    .single();
  if (docErr) throw docErr;

  // 4. embed + insert one chunk
  console.log("Embedding seed chunk via HF...");
  const embedding = await embedOne(SEED_CONTENT);
  const { error: chErr } = await db.from("chunks").insert({
    document_id: doc.id,
    kb_id: kb.id,
    content: SEED_CONTENT,
    embedding,
    metadata: { source_file: "leave-policy.pdf", page_number: 1 },
  });
  if (chErr) throw chErr;

  // 5. run hybrid_search
  console.log(`\nQuery: "${QUERY}"`);
  const queryEmbedding = await embedOne(QUERY);
  const { data: results, error: searchErr } = await db.rpc("hybrid_search", {
    query_text: QUERY,
    query_embedding: queryEmbedding,
    filter_kb_id: kb.id,
    match_count: RETRIEVAL_TOP_K,
  });
  if (searchErr) throw searchErr;

  console.log(`\nhybrid_search returned ${results?.length ?? 0} row(s):`);
  for (const r of results ?? []) {
    console.log(`  • ${r.content.slice(0, 80)}...`);
  }

  if ((results?.length ?? 0) > 0) {
    console.log("\n✅ STAGE 0 PASS — vector + keyword + RRF retrieval works.");
  } else {
    console.log("\n❌ STAGE 0 FAIL — no rows returned. Check the migration ran.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\n❌ verify-stage0 error:", e);
  process.exit(1);
});
