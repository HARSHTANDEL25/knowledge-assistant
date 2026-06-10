// Confluence Cloud REST API client + HTML cleaner for the sync connector.
// Uses Basic Auth (email:token) — credentials set once by admin in env vars.

const BASE = process.env.CONFLUENCE_BASE_URL;
const EMAIL = process.env.CONFLUENCE_EMAIL;
const TOKEN = process.env.CONFLUENCE_TOKEN;

function authHeader() {
  const creds = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
  return `Basic ${creds}`;
}

type ConfluencePage = { id: string; title: string; text: string };

function requireEnv() {
  if (!BASE || !EMAIL || !TOKEN) {
    throw new Error("Missing CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, or CONFLUENCE_TOKEN in environment");
  }
}

// Detect URL type and return pages accordingly
export async function fetchPagesFromUrl(confluenceUrl: string): Promise<ConfluencePage[]> {
  requireEnv();

  // Page URL: .../spaces/KEY/pages/PAGE_ID/... → fetch page + all children recursively
  const pageMatch = confluenceUrl.match(/\/pages\/(\d+)/);
  if (pageMatch) {
    return fetchPageWithChildren(pageMatch[1]);
  }

  // Space URL: .../spaces/KEY
  const spaceMatch = confluenceUrl.match(/\/spaces\/([^/?#]+)/i);
  if (spaceMatch) {
    return fetchSpacePages(spaceMatch[1]);
  }

  throw new Error("Invalid Confluence URL — paste a space URL (.../spaces/KEY) or page URL (.../pages/ID/Title)");
}

// Fetch a page + ALL descendants using CQL ancestor query (handles any nesting depth)
async function fetchPageWithChildren(pageId: string): Promise<ConfluencePage[]> {
  const pages: ConfluencePage[] = [];

  // Fetch the root page itself
  const rootRes = await fetch(`${BASE}/wiki/rest/api/content/${pageId}?expand=body.storage`, {
    headers: { Authorization: authHeader(), Accept: "application/json" },
  });
  if (!rootRes.ok) throw new Error(`Confluence API ${rootRes.status}: ${await rootRes.text()}`);
  const root = await rootRes.json();
  const rootText = cleanHtml(root.body?.storage?.value ?? "");
  if (rootText.length >= 50) pages.push({ id: root.id, title: root.title, text: rootText });

  // Fetch ALL descendants at once using CQL — no recursion needed, catches every level
  let start = 0;
  const limit = 25;
  while (true) {
    const cql = encodeURIComponent(`ancestor = ${pageId} AND type = page`);
    const url = `${BASE}/wiki/rest/api/content/search?cql=${cql}&expand=body.storage&limit=${limit}&start=${start}`;
    const res = await fetch(url, {
      headers: { Authorization: authHeader(), Accept: "application/json" },
    });
    if (!res.ok) break;
    const json = await res.json();

    for (const page of json.results ?? []) {
      const text = cleanHtml(page.body?.storage?.value ?? "");
      if (text.length >= 50) pages.push({ id: page.id, title: page.title, text });
    }

    if (!json._links?.next) break;
    start += limit;
  }

  return pages;
}

async function fetchSpacePages(spaceKey: string): Promise<ConfluencePage[]> {
  const pages: ConfluencePage[] = [];
  let start = 0;
  const limit = 25;

  while (true) {
    const url = `${BASE}/wiki/rest/api/content?spaceKey=${spaceKey}&type=page&expand=body.storage&limit=${limit}&start=${start}`;
    const res = await fetch(url, {
      headers: { Authorization: authHeader(), Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Confluence API ${res.status}: ${await res.text()}`);
    const json = await res.json();

    for (const page of json.results ?? []) {
      const text = cleanHtml(page.body?.storage?.value ?? "");
      if (text.length > 50) pages.push({ id: page.id, title: page.title, text });
    }

    if (!json._links?.next) break;
    start += limit;
  }

  return pages;
}

export function cleanHtml(html: string): string {
  let t = html;
  // Drop structured macros entirely (code blocks, panels, status, etc.)
  t = t.replace(/<ac:structured-macro[\s\S]*?<\/ac:structured-macro>/gi, " ");
  // Drop remaining ac: and ri: custom tags
  t = t.replace(/<\/?ac:[^>]*>/gi, " ");
  t = t.replace(/<\/?ri:[^>]*>/gi, " ");
  // Replace block-level closing tags with newlines for readability
  t = t.replace(/<\/(p|h[1-6]|li|tr|div|td|th)>/gi, "\n");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining HTML tags
  t = t.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  t = t
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Normalize whitespace
  t = t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}
