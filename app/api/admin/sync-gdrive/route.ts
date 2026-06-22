import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { chunkText } from "@/lib/chunking";
import { embed } from "@/lib/embeddings";
import { getDriveToken, listPdfs, downloadFile , extractFolderId } from "@/lib/gdrive";
import { extractText, getDocumentProxy } from "unpdf";

export const runtime = "nodejs";
export const maxDuration = 300;

// HR/IT are global KBs, so Drive sync is a super-admin action.
const FOLDER_MAP = [
  { folderEnv: "DRIVE_HR_FOLDER_ID", kbSlug: "hr", kbType: "hr", kbName: "HR" },
  { folderEnv: "DRIVE_IT_FOLDER_ID", kbSlug: "it", kbType: "it", kbName: "IT" },
];
const BATCH = 32;

async function assertSuperAdmin() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || profile.role !== "super_admin") return null;
  return { user };
}

function sse(controller: ReadableStreamDefaultController, data: object) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
}

async function ingest(
  db: ReturnType<typeof createAdminClient>,
  kbId: string,
  fileName: string,
  buf: Buffer,
  SourceUrl: string | null,
): Promise<number> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
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
        metadata: { source_file: fileName, page_number: r.page, origin: "gdrive" , source_url: SourceUrl },
      })),
    );
    if (e) throw e;
  }
  await db.from("documents").update({ status: "ready" }).eq("id", doc.id);
  return rows.length;
}

// GET /api/admin/sync-gdrive — drift status: compare each Drive folder against
// what's ingested in Supabase, so the UI can flag new/unsynced PDFs.
export async function GET() {
  const admin = await assertSuperAdmin();
  if (!admin) return Response.json({ error: "Forbidden" }, { status: 403 });

  const missing = ["GOOGLE_CLIENT_EMAIL", "GOOGLE_PRIVATE_KEY", "DRIVE_HR_FOLDER_ID", "DRIVE_IT_FOLDER_ID"].filter(
    (k) => !process.env[k],
  );
  if (missing.length) return Response.json({ configured: false, missing });

  const db = createAdminClient();
  try {
    const token = await getDriveToken();
    const folders = [];
    for (const map of FOLDER_MAP) {
      const driveFiles = await listPdfs(token, process.env[map.folderEnv]!);
      const driveIds= extractFolderId(process.env[map.folderEnv]!);
      const driveNames = driveFiles.map((f) => f.name);

      const { data: kb } = await db.from("knowledge_bases").select("id").eq("slug", map.kbSlug).single();
      const { data: docs } = kb
        ? await db.from("documents").select("source, status").eq("kb_id", kb.id)
        : { data: [] };
      const rows = (docs ?? []).filter((d: { source: string }) => d.source !== "stage0-seed");
      const ready = new Set(rows.filter((d) => d.status === "ready").map((d) => d.source));
      const failedSet = new Set(rows.filter((d) => d.status === "failed").map((d) => d.source));
      const allDbNames = new Set(rows.map((d) => d.source));

      const unsynced = driveNames.filter((n) => !allDbNames.has(n)); // no doc row at all = new
      const failed = driveNames.filter((n) => failedSet.has(n)); // ingest failed (e.g. image PDF, 0 text)
      const stale = [...allDbNames].filter((n) => !driveNames.includes(n)); // gone from Drive
      folders.push({
        name: map.kbName,
        url: `https://drive.google.com/drive/folders/${driveIds}`,
        driveCount: driveNames.length,
        synced: driveNames.filter((n) => ready.has(n)).length,
        unsynced,
        failed,
        stale,
      });
    }
    return Response.json({ configured: true, folders });
  } catch (e) {
    return Response.json({ configured: true, error: String(e) }, { status: 200 });
  }
}

// POST body: { scope?: "hr" | "it" | "all", full?: boolean }
//   scope — which folder(s) to sync (default "all")
//   full  — true: re-ingest every PDF; false (default): only ingest PDFs not
//           already in the KB (incremental — the common case after one upload)
export async function POST(req: Request) {
  const admin = await assertSuperAdmin();
  if (!admin) return Response.json({ error: "Forbidden" }, { status: 403 });

  const missing = ["GOOGLE_CLIENT_EMAIL", "GOOGLE_PRIVATE_KEY", "DRIVE_HR_FOLDER_ID", "DRIVE_IT_FOLDER_ID"].filter(
    (k) => !process.env[k],
  );
  if (missing.length) {
    return Response.json({ error: `Missing env: ${missing.join(", ")}` }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const scope: string = body.scope ?? "all";
  const full: boolean = body.full === true;
  const targets = FOLDER_MAP.filter((m) => scope === "all" || m.kbSlug === scope);

  const db = createAdminClient();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        sse(controller, { type: "status", message: "Connecting to Google Drive..." });

        let token: string;
        try {
          token = await getDriveToken();
        } catch (e) {
          sse(controller, { type: "error", message: `Drive auth failed: ${String(e)}` });
          return;
        }

        let totalFiles = 0;
        let totalChunks = 0;
        const failures: string[] = [];

        for (const map of targets) {
          const folderRaw = process.env[map.folderEnv]!;
          const { data: kb, error } = await db
            .from("knowledge_bases")
            .upsert({ type: map.kbType, name: map.kbName, slug: map.kbSlug }, { onConflict: "slug" })
            .select()
            .single();
          if (error || !kb) {
            sse(controller, { type: "error", message: `KB upsert failed for ${map.kbName}: ${error?.message}` });
            continue;
          }

          let files;
          try {
            files = await listPdfs(token, folderRaw);
          } catch (e) {
            sse(controller, { type: "error", message: `Could not list ${map.kbName} folder: ${String(e)}` });
            continue;
          }

          // Incremental: skip PDFs already ingested. Full: re-ingest everything.
          let queue = files;
          if (!full) {
            const { data: docs } = await db.from("documents").select("source").eq("kb_id", kb.id);
            const have = new Set((docs ?? []).map((d: { source: string }) => d.source));
            queue = files.filter((f) => !have.has(f.name));
          }

          sse(controller, {
            type: "status",
            message: `${map.kbName}: ${queue.length} ${full ? "" : "new "}PDF(s) to sync${
              full ? "" : ` (of ${files.length} in Drive)`
            }`,
          });

          for (let i = 0; i < queue.length; i++) {
            const f = queue[i];
            try {
              const buf = await downloadFile(token, f.id);
              const n = await ingest(db, kb.id, f.name, buf, f.webViewLink);
              totalFiles++;
              totalChunks += n;
              sse(controller, {
                type: "progress",
                message: `${map.kbName} ${i + 1}/${queue.length}: ${f.name} → ${n} chunks`,
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : JSON.stringify(e);
              failures.push(`${f.name}: ${msg}`);
              sse(controller, { type: "progress", message: `⚠️ ${f.name} failed (${msg}) — will retry on next sync` });
            }
          }
        }

        sse(controller, {
          type: "done",
          files: totalFiles,
          chunks: totalChunks,
          failures: failures.length,
          message:
            (totalFiles === 0 && failures.length === 0
              ? "Already up to date — nothing new to sync."
              : `Synced ${totalFiles} file(s), ${totalChunks} chunks.`) +
            (failures.length ? ` ${failures.length} failed — re-run to retry.` : ""),
        });
      } catch (e) {
        sse(controller, { type: "error", message: `Sync error: ${String(e)}` });
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
