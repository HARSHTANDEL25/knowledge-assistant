import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchPagesFromUrl } from "@/lib/confluence";
import { chunkText } from "@/lib/chunking";
import { embed } from "@/lib/embeddings";

export const maxDuration = 60;

const ADMIN_ROLES = ["super_admin", "project_admin"];
const BATCH = 32;

async function assertAdmin() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || !ADMIN_ROLES.includes(profile.role)) return null;
  return { user, role: profile.role as string };
}

// POST /api/admin/sync
// Body: { kb_id, space_url }
// Fetches all pages from the Confluence space, chunks + embeds them, stores in the KB.
export async function POST(req: Request) {
  const admin = await assertAdmin();
  if (!admin) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { kb_id, space_url } = await req.json();
  if (!kb_id || !space_url) {
    return Response.json({ error: "kb_id and space_url required" }, { status: 400 });
  }

  const db = createAdminClient();

  // Verify admin owns this KB (project_admin restriction)
  if (admin.role === "project_admin") {
    const { data: kb } = await db
      .from("knowledge_bases")
      .select("created_by")
      .eq("id", kb_id)
      .single();
    if (!kb || kb.created_by !== admin.user.id) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  let pages;
  try {
    pages = await fetchPagesFromUrl(space_url);
  } catch (e) {
    return Response.json({ error: `Confluence fetch failed: ${String(e)}` }, { status: 502 });
  }

  if (pages.length === 0) {
    return Response.json({ pages: 0, chunks: 0, message: "No pages found in this space." });
  }

  let totalChunks = 0;

  for (const page of pages) {
    try {
      // Delete existing document for this page (by source = page title)
      await db.from("documents").delete().eq("kb_id", kb_id).eq("source", page.title);

      const { data: doc, error: docErr } = await db
        .from("documents")
        .insert({
          kb_id,
          source: page.title,
          title: page.title,
          status: "processing",
          is_current: true,
        })
        .select()
        .single();
      if (docErr) throw docErr;

      const chunks = await chunkText(page.text);
      if (chunks.length === 0) continue;

      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        const vecs = await embed(batch);
        const { error: chunkErr } = await db.from("chunks").insert(
          batch.map((content, j) => ({
            document_id: doc.id,
            kb_id,
            content,
            embedding: vecs[j],
            metadata: {
              source_file: page.title,
              page_number: null,
              confluence_page_id: page.id,
              origin: "confluence",
            },
          })),
        );
        if (chunkErr) throw chunkErr;
      }

      await db.from("documents").update({ status: "ready" }).eq("id", doc.id);
      totalChunks += chunks.length;
    } catch (e) {
      await db
        .from("documents")
        .update({ status: "failed" })
        .eq("kb_id", kb_id)
        .eq("source", page.title);
      console.error(`Failed to ingest page "${page.title}":`, e);
    }
  }

  return Response.json({
    pages: pages.length,
    chunks: totalChunks,
    message: `Synced ${pages.length} pages, ${totalChunks} chunks.`,
  });
}
