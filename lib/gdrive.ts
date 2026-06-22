// Google Drive helpers (service-account auth) shared by the CLI sync script
// (scripts/sync-gdrive.ts) and the admin "Sync now" route. No Workspace admin
// needed: a service account reads any folder explicitly shared with its email.
import { createSign } from "node:crypto";

const DRIVE = "https://www.googleapis.com/drive/v3";

// Accept either a raw folder ID or a full Drive URL pasted into .env.local.
export function extractFolderId(raw: string): string {
  const m = raw.match(/\/folders\/([^/?#]+)/);
  return (m ? m[1] : raw).trim();
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Mint a service-account access token via a signed JWT (RS256) — no extra deps.
export async function getDriveToken(): Promise<string> {
  const email = process.env.GOOGLE_CLIENT_EMAIL!;
  const key = process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = b64url(createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key));
  const assertion = `${header}.${claims}.${signature}`;

  //Exchange JWT for an access token 
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Token error ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token as string;
}

async function driveGet(token: string, path: string) {
  const res = await fetch(path.startsWith("http") ? path : `${DRIVE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

// List all PDF files directly inside a folder (handles pagination).
export async function listPdfs(token: string, folderRaw: string) {
  const id = extractFolderId(folderRaw);
  const q = `'${id}' in parents and mimeType = 'application/pdf' and trashed = false`;
  const base =
    `${DRIVE}/files?q=${encodeURIComponent(q)}` +
    `&fields=nextPageToken,files(id,name,modifiedTime,webViewLink)&pageSize=1000` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const files: { id: string; name: string; webViewLink: string }[] = [];
  let url = base;
  while (url) {
    const page = await driveGet(token, url);
    for (const f of page.files ?? []) files.push({ id: f.id, name: f.name, webViewLink: f.webViewLink });
    url = page.nextPageToken ? `${base}&pageToken=${page.nextPageToken}` : "";
  }
  return files;
}

export async function downloadFile(token: string, fileId: string): Promise<Buffer> {
  const res = await fetch(`${DRIVE}/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
