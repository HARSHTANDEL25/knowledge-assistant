// All-JS ingestion runner (Stage 1). Extract (unpdf) -> chunk -> embed -> insert.
// Delete-before-reinsert so re-running never duplicates chunks.
//
//   npm run ingest -- ./path/to/file.pdf <kb-slug>
//
// Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HF_TOKEN

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { createAdminClient } from "../lib/supabase/admin";
import { chunkText } from "../lib/chunking";
import { embed } from "../lib/embeddings";

async function main() {
  const [pdfPath, kbSlug] = process.argv.slice(2);
  if (!pdfPath || !kbSlug) {
    console.error("Usage: npm run ingest -- <path-to-pdf> <kb-slug>");
    process.exit(1);
  }
  const db = createAdminClient();

  // resolve KB
  const { data: kb, error: kbErr } = await db
    .from("knowledge_bases")
    .select("id, name")
    .eq("slug", kbSlug)
    .single();
  if (kbErr || !kb) throw new Error(`KB '${kbSlug}' not found: ${kbErr?.message}`);

  const fileName = basename(pdfPath);

  // extract per-page (keeps page_number for citations)
  const buf = await readFile(pdfPath);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  const totalChars = pages.join("").trim().length;

  if (totalChars === 0) {
    // scanned / image-only PDF guard — never store empty
    await db.from("documents").insert({
      kb_id: kb.id, source: fileName, title: fileName, status: "failed",
    });
    console.error(`❌ 0 chars extracted from ${fileName} — likely scanned/needs OCR. Marked failed.`);
    process.exit(1);
  }

  // delete-before-reinsert: drop prior version of this source
  await db.from("documents").delete().eq("kb_id", kb.id).eq("source", fileName);

  const { data: doc, error: docErr } = await db
    .from("documents")
    .insert({ kb_id: kb.id, source: fileName, title: fileName, status: "processing", is_current: true })
    .select()
    .single();
  if (docErr) throw docErr;

  // chunk each page, tracking page number
  const rows: { content: string; page: number }[] = [];
  for (let p = 0; p < pages.length; p++) {
    for (const c of await chunkText(pages[p])) rows.push({ content: c, page: p + 1 });
  }
  console.log(`Extracted ${pages.length} pages -> ${rows.length} chunks. Embedding...`);

  // embed in batches (HF batch-size friendly) and insert
  const BATCH = 32;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vecs = await embed(batch.map((r) => r.content));
    const { error } = await db.from("chunks").insert(
      batch.map((r, j) => ({
        document_id: doc.id,
        kb_id: kb.id,
        content: r.content,
        embedding: vecs[j],
        metadata: { source_file: fileName, page_number: r.page },
      })),
    );
    if (error) throw error;
    console.log(`  inserted ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }

  await db.from("documents").update({ status: "ready" }).eq("id", doc.id);
  console.log(`✅ Ingested ${fileName} into '${kb.name}' (${rows.length} chunks).`);
}

main().catch((e) => {
  console.error("❌ ingest error:", e);
  process.exit(1);
});
