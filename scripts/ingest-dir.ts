// Bulk-ingest every PDF in a folder into a knowledge base.
// Creates the KB if missing, deletes the stage0 seed, and uses
// delete-before-reinsert per file (re-runnable, no duplicates).
//
//   npm run ingest:dir -- "<folder>" <slug> <type> "<name>"
//   e.g. npm run ingest:dir -- "C:/Learnings/rag/data/hr_docs" hr hr "HR"

import { config } from "dotenv";
config({ path: ".env.local" });

import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { createAdminClient } from "../lib/supabase/admin";
import { chunkText } from "../lib/chunking";
import { embed } from "../lib/embeddings";

const BATCH = 32;

async function ingestFile(db: ReturnType<typeof createAdminClient>, kbId: string, path: string) {
  const fileName = basename(path);
  const buf = await readFile(path);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];

  if (pages.join("").trim().length === 0) {
    await db.from("documents").insert({ kb_id: kbId, source: fileName, title: fileName, status: "failed" });
    console.log(`  ⚠️  ${fileName}: 0 chars (scanned/needs OCR) — marked failed, skipped.`);
    return 0;
  }

  // delete-before-reinsert
  await db.from("documents").delete().eq("kb_id", kbId).eq("source", fileName);
  const { data: doc, error: docErr } = await db
    .from("documents")
    .insert({ kb_id: kbId, source: fileName, title: fileName, status: "processing", is_current: true })
    .select()
    .single();
  if (docErr) throw docErr;

  const rows: { content: string; page: number }[] = [];
  for (let p = 0; p < pages.length; p++) {
    for (const c of await chunkText(pages[p])) rows.push({ content: c, page: p + 1 });
  }

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vecs = await embed(batch.map((r) => r.content));
    const { error } = await db.from("chunks").insert(
      batch.map((r, j) => ({
        document_id: doc.id,
        kb_id: kbId,
        content: r.content,
        embedding: vecs[j],
        metadata: { source_file: fileName, page_number: r.page },
      })),
    );
    if (error) throw error;
  }
  await db.from("documents").update({ status: "ready" }).eq("id", doc.id);
  console.log(`  ✅ ${fileName}: ${pages.length} pages -> ${rows.length} chunks`);
  return rows.length;
}

async function main() {
  const [dir, slug, type, name] = process.argv.slice(2);
  if (!dir || !slug || !type || !name) {
    console.error('Usage: npm run ingest:dir -- "<folder>" <slug> <type> "<name>"');
    process.exit(1);
  }
  const db = createAdminClient();

  // ensure KB
  const { data: kb, error: kbErr } = await db
    .from("knowledge_bases")
    .upsert({ type, name, slug }, { onConflict: "slug" })
    .select()
    .single();
  if (kbErr) throw kbErr;

  // remove the fake stage0 seed if present
  const { count } = await db
    .from("documents")
    .delete({ count: "exact" })
    .eq("source", "stage0-seed");
  if (count) console.log(`Removed ${count} stage0 seed doc(s).`);

  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".pdf"));
  console.log(`\nIngesting ${files.length} PDF(s) into '${name}' (${slug})...`);

  let total = 0;
  for (const f of files) {
    try {
      total += await ingestFile(db, kb.id, join(dir, f));
    } catch (e) {
      console.error(`  ❌ ${f}: ${e}`);
    }
  }
  console.log(`\nDone. ${total} chunks into '${name}'.`);
}

main().catch((e) => {
  console.error("ingest-dir error:", e);
  process.exit(1);
});
