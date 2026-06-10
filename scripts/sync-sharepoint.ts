// SharePoint → knowledge-base sync (Microsoft Graph, app-only auth).
// Pulls PDFs from designated SharePoint folders and ingests them into the
// mapped KB, reusing the same extract→chunk→embed pipeline as local ingest.
// Delete-before-reinsert per file; folder→KB mapping below.
//
//   npm run sync:sharepoint
//
// Requires .env.local:
//   SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET   (from the Azure app registration)
//   SP_SITE_URL   e.g. https://horizontal.sharepoint.com/sites/CompanyKnowledgeBase
//   SP_LIBRARY    (optional) document library display name, default "Documents"
//   + the usual SUPABASE_SERVICE_ROLE_KEY, HF_TOKEN
//
// Azure prerequisite (IT): App registration + Microsoft Graph application
// permission Sites.Selected (or Sites.Read.All) with admin consent; if
// Sites.Selected, grant the app read on the target site.

import { config } from "dotenv";
config({ path: ".env.local" });

import { extractText, getDocumentProxy } from "unpdf";
import { createAdminClient } from "../lib/supabase/admin";
import { chunkText } from "../lib/chunking";
import { embed } from "../lib/embeddings";

// ── Folder → KB mapping (the 2-folder pilot) ────────────────────────────────
const FOLDER_MAP = [
  { folder: "HR Policies & Procedures", kbSlug: "hr", kbType: "hr", kbName: "HR" },
  { folder: "IT Guide", kbSlug: "it", kbType: "it", kbName: "IT" },
];

const GRAPH = "https://graph.microsoft.com/v1.0";
const BATCH = 32;

function requireEnv(keys: string[]) {
  const missing = keys.filter((k) => !process.env[k] || process.env[k]!.includes("PASTE"));
  if (missing.length) {
    console.error("❌ Missing SharePoint credentials in .env.local:", missing.join(", "));
    console.error(
      "\nHand this to IT: register an Azure app, grant Microsoft Graph 'Sites.Selected'\n" +
        "(or Sites.Read.All) with admin consent, then provide SP_TENANT_ID, SP_CLIENT_ID,\n" +
        "SP_CLIENT_SECRET, and the SP_SITE_URL.",
    );
    process.exit(1);
  }
}

async function getToken(): Promise<string> {
  const tenant = process.env.SP_TENANT_ID!;
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.SP_CLIENT_ID!,
      client_secret: process.env.SP_CLIENT_SECRET!,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Token error ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token as string;
}

async function graph(token: string, path: string) {
  const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Graph ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

async function resolveDrive(token: string): Promise<string> {
  const u = new URL(process.env.SP_SITE_URL!);
  const sitePath = `${u.hostname}:${u.pathname}`; // host:/sites/Name
  const site = await graph(token, `/sites/${sitePath}`);
  const drives = await graph(token, `/sites/${site.id}/drives`);
  const wanted = process.env.SP_LIBRARY || "Documents";
  const drive = drives.value.find((d: { name: string }) => d.name === wanted) ?? drives.value[0];
  if (!drive) throw new Error(`No document library found (looked for "${wanted}")`);
  return drive.id;
}

// List all PDF files in a folder (handles pagination).
async function listPdfs(token: string, driveId: string, folder: string) {
  const enc = folder.split("/").map(encodeURIComponent).join("/");
  let url = `${GRAPH}/drives/${driveId}/root:/${enc}:/children?$select=id,name,file,lastModifiedDateTime`;
  const files: { id: string; name: string }[] = [];
  while (url) {
    const page = await graph(token, url);
    for (const item of page.value ?? []) {
      if (item.file && item.name.toLowerCase().endsWith(".pdf")) {
        files.push({ id: item.id, name: item.name });
      }
    }
    url = page["@odata.nextLink"] ?? "";
  }
  return files;
}

async function download(token: string, driveId: string, itemId: string): Promise<Buffer> {
  const res = await fetch(`${GRAPH}/drives/${driveId}/items/${itemId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function ingest(
  db: ReturnType<typeof createAdminClient>,
  kbId: string,
  fileName: string,
  buf: Buffer,
) {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  if (pages.join("").trim().length === 0) {
    await db.from("documents").insert({ kb_id: kbId, source: fileName, title: fileName, status: "failed" });
    console.log(`    ⚠️  ${fileName}: 0 chars (scanned) — failed`);
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
        metadata: { source_file: fileName, page_number: r.page, origin: "sharepoint" },
      })),
    );
    if (e) throw e;
  }
  await db.from("documents").update({ status: "ready" }).eq("id", doc.id);
  return rows.length;
}

async function main() {
  requireEnv(["SP_TENANT_ID", "SP_CLIENT_ID", "SP_CLIENT_SECRET", "SP_SITE_URL"]);
  const db = createAdminClient();
  const token = await getToken();
  const driveId = await resolveDrive(token);
  console.log(`Connected to SharePoint library (drive ${driveId.slice(0, 8)}…).`);

  for (const map of FOLDER_MAP) {
    const { data: kb, error } = await db
      .from("knowledge_bases")
      .upsert({ type: map.kbType, name: map.kbName, slug: map.kbSlug }, { onConflict: "slug" })
      .select()
      .single();
    if (error) throw error;

    const files = await listPdfs(token, driveId, map.folder);
    console.log(`\n[${map.folder}] → ${map.kbName}: ${files.length} PDF(s)`);

    const seenSources: string[] = [];
    for (const f of files) {
      try {
        const buf = await download(token, driveId, f.id);
        const n = await ingest(db, kb.id, f.name, buf);
        seenSources.push(f.name);
        console.log(`    ✅ ${f.name}: ${n} chunks`);
      } catch (e) {
        console.error(`    ❌ ${f.name}: ${e}`);
      }
    }

    // Prune KB docs not in the folder. OFF by default — it deletes ANY doc in
    // the KB that isn't in this SharePoint folder, which would wipe manually
    // ingested docs. Only enable (SP_PRUNE=true) once SharePoint is the SOLE
    // source for this KB.
    if (process.env.SP_PRUNE === "true") {
      const { data: existing } = await db
        .from("documents")
        .select("id, source")
        .eq("kb_id", kb.id);
      const stale = (existing ?? []).filter(
        (d: { source: string }) => !seenSources.includes(d.source) && d.source !== "stage0-seed",
      );
      for (const d of stale) {
        await db.from("documents").delete().eq("id", d.id);
        console.log(`    🗑️  pruned (gone from SharePoint): ${d.source}`);
      }
    }
  }
  console.log("\n✅ SharePoint sync complete.");
}

main().catch((e) => {
  console.error("sync-sharepoint error:", e);
  process.exit(1);
});
