// Confluence Cloud API client + HTML cleaner.
// OAuth → api.atlassian.com gateway
//   v1 content endpoints return 410; v2 used for page bodies
//   v1 /search CQL used for descendant discovery (traverses folders transparently)
// API token → direct instance URL → v1 works fine

type ConfluenceCreds =
  | { type: "oauth"; accessToken: string; cloudId: string }
  | { type: "apitoken" };

// Builds v1 API base URL.
// OAuth → routes through api.atlassian.com gateway (some v1 endpoints return 410 here)
// API token → hits horizontal.atlassian.net directly (all v1 endpoints work)
function v1Base(creds: ConfluenceCreds): string {
  if (creds.type === "oauth") {
    return `https://api.atlassian.com/ex/confluence/${creds.cloudId}/wiki/rest/api`;
  }
  return `${process.env.CONFLUENCE_BASE_URL}/wiki/rest/api`;
}

// Builds v2 API base URL. Always routes through api.atlassian.com gateway.
// Only used for OAuth — v2 endpoints don't have the 410 deprecation issue.
function v2Base(creds: ConfluenceCreds): string {
  return `https://api.atlassian.com/ex/confluence/${(creds as { cloudId: string }).cloudId}/wiki/api/v2`;
}

// Builds the Authorization header.
// OAuth → Bearer token (from confluence_tokens table)
// API token → Basic base64(email:token) (from env vars)
function authHeader(creds: ConfluenceCreds): string {
  if (creds.type === "oauth") return `Bearer ${creds.accessToken}`;
  return `Basic ${Buffer.from(`${process.env.CONFLUENCE_EMAIL}:${process.env.CONFLUENCE_TOKEN}`).toString("base64")}`;
}

// Shared HTTP fetch helper used by all functions.
// Attaches auth header and throws a clear error on non-200 responses.
async function cfetch(creds: ConfluenceCreds, url: string) {
  const res = await fetch(url, {
    headers: { Authorization: authHeader(creds), Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Confluence API ${res.status}: ${await res.text()}`);
  return res.json();
}

export type ConfluencePage = { id: string; title: string; text: string };

// Entry point — called by the sync route.
// Detects the URL type (page / folder / space) and routes to the right function.
// Automatically picks OAuth vs API token path based on creds type.
export async function fetchPagesFromUrl(
  confluenceUrl: string,
  creds: ConfluenceCreds,
): Promise<ConfluencePage[]> {
  const pageMatch = confluenceUrl.match(/\/pages\/(\d+)/);
  if (pageMatch) {
    return creds.type === "oauth"
      ? fetchPageWithDescendantsOAuth(pageMatch[1], creds)
      : fetchPageWithDescendantsV1(pageMatch[1], creds);
  }

  // /folder/ID — use same CQL ancestor traversal as pages
  const folderMatch = confluenceUrl.match(/\/folder\/(\d+)/);
  if (folderMatch) {
    return creds.type === "oauth"
      ? fetchDescendantsOfIdOAuth(folderMatch[1], creds)
      : fetchPageWithDescendantsV1(folderMatch[1], creds);
  }

  const spaceMatch = confluenceUrl.match(/\/spaces\/([^/?#]+)/i);
  if (spaceMatch) {
    return creds.type === "oauth"
      ? fetchSpacePagesOAuth(spaceMatch[1], creds)
      : fetchSpacePagesV1(spaceMatch[1], creds);
  }

  throw new Error("Invalid Confluence URL — paste a space, page, or folder URL");
}

// ── OAuth path ────────────────────────────────────────────────────────────────
// Strategy: use v1 /search?cql=ancestor=X to discover ALL descendants
// (CQL traverses folders transparently). Fetch each page body via v2.

// Fetch multiple page bodies concurrently — 8 at a time to stay under
// Confluence's ~10 req/s rate limit.
const FETCH_CONCURRENCY = 8;

async function fetchPageBodiesOAuth(ids: string[], creds: ConfluenceCreds): Promise<ConfluencePage[]> {
  const pages: ConfluencePage[] = [];
  const queue = [...ids];

  // Sliding window — spawn FETCH_CONCURRENCY workers, each pulls from the queue
  // until empty. A slot opens the moment any request finishes, not at batch end.
  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift()!;
      try {
        const page = await cfetch(creds, `${v2Base(creds)}/pages/${id}?body-format=storage`);
        const text = cleanHtml(page.body?.storage?.value ?? "");
        if (text.length >= 50) pages.push({ id: page.id, title: page.title, text });
      } catch (e) {
        console.warn(`[confluence] skipping page ${id}:`, e);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, ids.length) }, worker)
  );
  return pages;
}

// OAuth + folder URL.
// Folders have no body — skips the root, fetches all pages inside via CQL.
async function fetchDescendantsOfIdOAuth(id: string, creds: ConfluenceCreds): Promise<ConfluencePage[]> {
  const ids = await fetchDescendantIdsViaCql(id, creds);
  return fetchPageBodiesOAuth(ids, creds);
}

// OAuth + page URL.
// Fetches root page body via v2, then all descendants via CQL, each body via v2.
async function fetchPageWithDescendantsOAuth(pageId: string, creds: ConfluenceCreds): Promise<ConfluencePage[]> {
  const pages: ConfluencePage[] = [];

  // Root page body via v2
  const root = await cfetch(creds, `${v2Base(creds)}/pages/${pageId}?body-format=storage`);
  const rootText = cleanHtml(root.body?.storage?.value ?? "");
  if (rootText.length >= 50) pages.push({ id: root.id, title: root.title, text: rootText });

  // All descendants via v1 CQL — fetch bodies in parallel batches
  const ids = await fetchDescendantIdsViaCql(pageId, creds);
  const descendants = await fetchPageBodiesOAuth(ids, creds);
  return [...pages, ...descendants];
}

// CQL search to find ALL descendant page IDs under a page or folder.
// Uses v1 /search which still works on the OAuth gateway (not deprecated).
// CQL ancestor=X traverses the full tree including pages inside folders.
// Returns only IDs — bodies are fetched separately via v2 to avoid 410.
async function fetchDescendantIdsViaCql(pageId: string, creds: ConfluenceCreds): Promise<string[]> {
  const base = v1Base(creds);
  const ids: string[] = [];
  let start = 0;

  while (true) {
    const cql = encodeURIComponent(`ancestor = ${pageId} AND type = page`);
    const json = await cfetch(creds, `${base}/search?cql=${cql}&limit=50&start=${start}`);
    for (const r of json.results ?? []) {
      const id = r.content?.id ?? r.id;
      if (id) ids.push(id);
    }
    if (!json._links?.next) break;
    start += 50;
  }

  return ids;
}

// OAuth + space URL.
// CQL space=KEY finds all pages in the space, fetches each body via v2.
async function fetchSpacePagesOAuth(spaceKey: string, creds: ConfluenceCreds): Promise<ConfluencePage[]> {
  const base = v1Base(creds);
  const ids: string[] = [];
  let start = 0;

  // First collect all page IDs via CQL pagination
  while (true) {
    const cql = encodeURIComponent(`space = "${spaceKey}" AND type = page`);
    const json = await cfetch(creds, `${base}/search?cql=${cql}&limit=50&start=${start}`);
    for (const r of json.results ?? []) {
      const id = r.content?.id ?? r.id;
      if (id) ids.push(id);
    }
    if (!json._links?.next) break;
    start += 50;
  }

  // Then fetch all bodies in parallel batches
  return fetchPageBodiesOAuth(ids, creds);
}

// ── API token: v1 API ─────────────────────────────────────────────────────────

// API token + page or folder URL.
// v1 works fine on direct instance URL — body returned inline with expand=body.storage,
// no need for a separate v2 fetch per page.
async function fetchPageWithDescendantsV1(pageId: string, creds: ConfluenceCreds): Promise<ConfluencePage[]> {
  const base = v1Base(creds);
  const pages: ConfluencePage[] = [];

  const root = await cfetch(creds, `${base}/content/${pageId}?expand=body.storage`);
  const rootText = cleanHtml(root.body?.storage?.value ?? "");
  if (rootText.length >= 50) pages.push({ id: root.id, title: root.title, text: rootText });

  let start = 0;
  while (true) {
    const cql = encodeURIComponent(`ancestor = ${pageId} AND type = page`);
    const json = await cfetch(creds, `${base}/search?cql=${cql}&expand=body.storage&limit=50&start=${start}`);
    for (const r of json.results ?? []) {
      const page = r.content ?? r;
      const text = cleanHtml(page.body?.storage?.value ?? "");
      if (text.length >= 50) pages.push({ id: page.id, title: page.title, text });
    }
    if (!json._links?.next) break;
    start += 50;
  }

  return pages;
}

// API token + space URL.
// GET /content?spaceKey=KEY returns all pages with body inline.
async function fetchSpacePagesV1(spaceKey: string, creds: ConfluenceCreds): Promise<ConfluencePage[]> {
  const base = v1Base(creds);
  const pages: ConfluencePage[] = [];
  let start = 0;

  while (true) {
    const json = await cfetch(creds, `${base}/content?spaceKey=${spaceKey}&type=page&expand=body.storage&limit=50&start=${start}`);
    for (const page of json.results ?? []) {
      const text = cleanHtml(page.body?.storage?.value ?? "");
      if (text.length > 50) pages.push({ id: page.id, title: page.title, text });
    }
    if (!json._links?.next) break;
    start += 50;
  }

  return pages;
}

// ── HTML cleaner ──────────────────────────────────────────────────────────────

// Converts Confluence storage-format HTML to plain text for chunking.
// Strips Atlassian-specific tags (ac:, ri:), decodes HTML entities,
// preserves paragraph structure as newlines.
export function cleanHtml(html: string): string {
  let t = html;
  t = t.replace(/<ac:structured-macro[\s\S]*?<\/ac:structured-macro>/gi, " ");
  t = t.replace(/<\/?ac:[^>]*>/gi, " ");
  t = t.replace(/<\/?ri:[^>]*>/gi, " ");
  t = t.replace(/<\/(p|h[1-6]|li|tr|div|td|th)>/gi, "\n");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<[^>]+>/g, " ");
  t = t
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  t = t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}
