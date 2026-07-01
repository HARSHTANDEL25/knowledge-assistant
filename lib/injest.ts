import { extractText, getDocumentProxy } from "unpdf";
import { createAdminClient } from "./supabase/admin";
import { chunkText } from "./chunking";
import { embed } from "./embeddings";

export async function ingest(
  db: ReturnType<typeof createAdminClient>,
  kbId: string,
  fileName: string,
  buf: Buffer,
  SourceUrl: string | null,
  origin: string,
): Promise<number> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  const BATCH = 32;
  if (pages.join("").trim().length === 0) {
    await db.from("documents").insert({ kb_id: kbId, source: fileName, title: fileName, status: "failed" });
    return 0;
  }
  await db.from("documents").delete().eq("kb_id", kbId).eq("source", fileName);
  const { data: doc, error } = await db
    .from("documents")
    .insert({ kb_id: kbId, source: fileName, title: fileName, status: "processing", is_current: true })
    .select()
    .single();
  if (error) throw error;

  const rows: { content: string; page: number }[] = [];
  for (let p = 0; p < pages.length; p++) {
    for (const c of await chunkText(pages[p])) rows.push({ content: c, page: p + 1 });
  }
  for (let i = 0; i < rows.length; i += BATCH) {
    const b = rows.slice(i, i + BATCH);
    const vecs = await embed(b.map((r) => r.content));
    const { error: e } = await db.from("chunks").insert(
      b.map((r, j) => ({
        document_id: doc.id,
        kb_id: kbId,
        content: r.content,
        embedding: vecs[j],
        metadata: { source_file: fileName, page_number: r.page, origin, source_url: SourceUrl },
      })),
    );
    if (e) throw e;
  }
  await db.from("documents").update({ status: "ready" }).eq("id", doc.id);
  return rows.length;
}
