// Confluence Cloud API client + HTML cleaner.
// OAuth → api.atlassian.com gateway
//   v1 content endpoints return 410; v2 used for page bodies
//   v1 /search CQL used for descendant discovery (traverses folders transparently)
// API token → direct instance URL → v1 works fine

type ConfluenceCreds =
  | { type: "oauth"; accessToken: string; cloudId: string }
  | { type: "apitoken" };

function v1Base(creds: ConfluenceCreds): string {
  if (creds.type === "oauth") {
    return `https://api.atlassian.com/ex/confluence/${creds.cloudId}/wiki/rest/api`;
  }
  return `${process.env.CONFLUENCE_BASE_URL}/wiki/rest/api`;
}

function v2Base(creds: ConfluenceCreds): string {
  return `https://api.atlassian.com/ex/confluence/${(creds as { cloudId: string }).cloudId}/wiki/api/v2`;
}

function authHeader(creds: ConfluenceCreds): string {
  if (creds.type === "oauth") return `Bearer ${creds.accessToken}`;
  return `Basic ${Buffer.from(`${process.env.CONFLUENCE_EMAIL}:${process.env.CONFLUENCE_TOKEN}`).toString("base64")}`;
}

async function cfetch(creds: ConfluenceCreds, url: string) {
  const res = await fetch(url, {
    headers: { Authorization: authHeader(creds), Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Confluence API ${res.status}: ${await res.text()}`);
  return res.json();
}

export type ConfluencePage = { id: string; title: string; text: string };

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

async function fetchDescendantsOfIdOAuth(id: string, creds: ConfluenceCreds): Promise<ConfluencePage[]> {
  const pages: ConfluencePage[] = [];
  const ids = await fetchDescendantIdsViaCql(id, creds);
  for (const pid of ids) {
    try {
      const page = await cfetch(creds, `${v2Base(creds)}/pages/${pid}?body-format=storage`);
      const text = cleanHtml(page.body?.storage?.value ?? "");
      if (text.length >= 50) pages.push({ id: page.id, title: page.title, text });
    } catch (e) {
      console.warn(`[confluence] skipping page ${pid}:`, e);
    }
  }
  return pages;
}

async function fetchPageWithDescendantsOAuth(pageId: string, creds: ConfluenceCreds): Promise<ConfluencePage[]> {
  const pages: ConfluencePage[] = [];

  // Root page body via v2
  const root = await cfetch(creds, `${v2Base(creds)}/pages/${pageId}?body-format=storage`);
  const rootText = cleanHtml(root.body?.storage?.value ?? "");
  if (rootText.length >= 50) pages.push({ id: root.id, title: root.title, text: rootText });

  // All descendants via v1 CQL — ancestor query sees through folders
  const ids = await fetchDescendantIdsViaCql(pageId, creds);
  for (const id of ids) {
    try {
      const page = await cfetch(creds, `${v2Base(creds)}/pages/${id}?body-format=storage`);
      const text = cleanHtml(page.body?.storage?.value ?? "");
      if (text.length >= 50) pages.push({ id: page.id, title: page.title, text });
    } catch (e) {
      console.warn(`[confluence] skipping page ${id}:`, e);
    }
  }

  return pages;
}

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

async function fetchSpacePagesOAuth(spaceKey: string, creds: ConfluenceCreds): Promise<ConfluencePage[]> {
  const pages: ConfluencePage[] = [];
  const base = v1Base(creds);
  let start = 0;

  while (true) {
    const cql = encodeURIComponent(`space = "${spaceKey}" AND type = page`);
    const json = await cfetch(creds, `${base}/search?cql=${cql}&limit=50&start=${start}`);
    for (const r of json.results ?? []) {
      const id = r.content?.id ?? r.id;
      if (!id) continue;
      try {
        const page = await cfetch(creds, `${v2Base(creds)}/pages/${id}?body-format=storage`);
        const text = cleanHtml(page.body?.storage?.value ?? "");
        if (text.length >= 50) pages.push({ id: page.id, title: page.title, text });
      } catch (e) {
        console.warn(`[confluence] skipping page ${id}:`, e);
      }
    }
    if (!json._links?.next) break;
    start += 50;
  }

  return pages;
}

// ── API token: v1 API ─────────────────────────────────────────────────────────

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
