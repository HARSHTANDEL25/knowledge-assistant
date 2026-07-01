import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingest } from "@/lib/injest";

export const runtime = "nodejs";
export const maxDuration = 300;

const ADMIN_ROLES = ["super_admin", "project_admin"];

async function assertAdmin() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || !ADMIN_ROLES.includes(profile.role)) return null;
  return { user, role: profile.role as string };
}

// POST /api/admin/upload — multipart/form-data: kb_id, file (one or more)
// Manual PDF upload for project KBs that don't have a Confluence space to sync.
export async function POST(req: Request) {
  const admin = await assertAdmin();
  if (!admin) return Response.json({ error: "Forbidden" }, { status: 403 });

  const form = await req.formData();
  const kbId = form.get("kb_id");
  const files = form.getAll("file").filter((f): f is File => f instanceof File);

  if (typeof kbId !== "string" || !kbId) {
    return Response.json({ error: "kb_id required" }, { status: 400 });
  }
  if (files.length === 0) {
    return Response.json({ error: "No file provided" }, { status: 400 });
  }
  const notPdf = files.filter((f) => !f.name.toLowerCase().endsWith(".pdf"));
  if (notPdf.length > 0) {
    return Response.json({ error: `Only PDF files are supported: ${notPdf.map((f) => f.name).join(", ")}` }, { status: 400 });
  }

  const db = createAdminClient();

  const { data: kb } = await db.from("knowledge_bases").select("id, created_by").eq("id", kbId).single();
  if (!kb) return Response.json({ error: "Knowledge base not found" }, { status: 404 });
  if (admin.role === "project_admin" && kb.created_by !== admin.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let totalChunks = 0;
  const failures: string[] = [];

  for (const file of files) {
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      totalChunks += await ingest(db, kbId, file.name, buf, null, "upload");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${file.name}: ${msg}`);
    }
  }

  if (failures.length > 0 && totalChunks === 0) {
    return Response.json({ error: failures.join("; ") }, { status: 500 });
  }

  return Response.json({
    chunks: totalChunks,
    failures: failures.length,
    message:
      `Uploaded ${files.length - failures.length}/${files.length} file(s), ${totalChunks} chunks.` +
      (failures.length ? ` Failed: ${failures.join("; ")}` : ""),
  });
}
