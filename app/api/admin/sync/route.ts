import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchPagesFromUrl } from "@/lib/confluence";
import { chunkText } from "@/lib/chunking";
import { embed } from "@/lib/embeddings";

export const maxDuration = 60;

const ADMIN_ROLES = ["super_admin", "project_admin"];
const EMBED_BATCH = 64;  // larger global batch = fewer HF round trips

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

function sse(controller: ReadableStreamDefaultController, data: object) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
}

export async function POST(req: Request) {
  const admin = await assertAdmin();
  if (!admin) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { kb_id, space_url } = await req.json();
  if (!kb_id || !space_url) {
    return Response.json({ error: "kb_id and space_url required" }, { status: 400 });
  }

  const db = createAdminClient();

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

  const { data: tokenRow } = await db
    .from("confluence_tokens")
    .select("access_token, cloud_id")
    .eq("user_id", admin.user.id)
    .single();

  const creds = tokenRow
    ? { type: "oauth" as const, accessToken: tokenRow.access_token, cloudId: tokenRow.cloud_id }
    : { type: "apitoken" as const };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        sse(controller, { type: "status", message: "Fetching pages from Confluence..." });

        let pages;
        try {
          pages = await fetchPagesFromUrl(space_url, creds);
        } catch (e) {
          sse(controller, { type: "error", message: `Confluence fetch failed: ${String(e)}` });
          controller.close();
          return;
        }

        if (pages.length === 0) {
          sse(controller, { type: "done", pages: 0, chunks: 0, message: "No pages found." });
          controller.close();
          return;
        }

        sse(controller, { type: "count", total: pages.length, message: `Found ${pages.length} pages. Chunking...` });

        // Phase 1: chunk all pages + insert document rows (no HF calls yet)
        type WorkItem = { pageId: string; title: string; docId: string; chunks: string[] };
        const work: WorkItem[] = [];

        for (const page of pages) {
          try {
            await db.from("documents").delete().eq("kb_id", kb_id).eq("source", page.title);
            const { data: doc, error: docErr } = await db
              .from("documents")
              .insert({ kb_id, source: page.title, title: page.title, status: "processing", is_current: true })
              .select()
              .single();
            if (docErr) throw docErr;
            const chunks = await chunkText(page.text);
            if (chunks.length > 0) work.push({ pageId: page.id, title: page.title, docId: doc.id, chunks });
            else await db.from("documents").update({ status: "ready" }).eq("id", doc.id);
          } catch (e) {
            console.error(`Chunk phase failed for "${page.title}":`, e);
          }
        }

        // Phase 2: embed ALL chunks globally in large batches — far fewer HF round trips
        const allChunks = work.flatMap((w) => w.chunks);
        const allVecs: number[][] = [];

        sse(controller, { type: "status", message: `Embedding ${allChunks.length} chunks across ${work.length} pages...` });

        for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
          sse(controller, {
            type: "progress",
            current: Math.min(i + EMBED_BATCH, allChunks.length),
            total: allChunks.length,
            message: `Embedding ${Math.min(i + EMBED_BATCH, allChunks.length)}/${allChunks.length} chunks...`,
          });
          const vecs = await embed(allChunks.slice(i, i + EMBED_BATCH));
          allVecs.push(...vecs);
        }

        // Phase 3: insert chunks per page using the pre-computed embeddings
        let totalChunks = 0;
        let vecOffset = 0;

        for (const w of work) {
          try {
            const vecs = allVecs.slice(vecOffset, vecOffset + w.chunks.length);
            vecOffset += w.chunks.length;
            const { error: chunkErr } = await db.from("chunks").insert(
              w.chunks.map((content, k) => ({
                document_id: w.docId,
                kb_id,
                content,
                embedding: vecs[k],
                metadata: { source_file: w.title, page_number: null, confluence_page_id: w.pageId, origin: "confluence" },
              })),
            );
            if (chunkErr) throw chunkErr;
            await db.from("documents").update({ status: "ready" }).eq("id", w.docId);
            totalChunks += w.chunks.length;
          } catch (e) {
            await db.from("documents").update({ status: "failed" }).eq("id", w.docId);
            console.error(`Insert phase failed for "${w.title}":`, e);
          }
        }

        sse(controller, {
          type: "done",
          pages: pages.length,
          chunks: totalChunks,
          message: `Synced ${pages.length} pages, ${totalChunks} chunks.`,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
