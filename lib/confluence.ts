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

// Upper bound on any single Confluence request. The sync route runs with
// maxDuration = 60, so one wedged request must not silently eat the whole
// budget and get killed with no error. Generous on purpose — a body-expanded
// batch of large pages is legitimately slow, and this is a hang guard, not a
// performance knob.
const REQUEST_TIMEOUT_MS = 25_000;

// Shared HTTP fetch helper used by all functions.
// Attaches auth header and throws a clear error on non-200 responses.
async function cfetch(creds: ConfluenceCreds, url: string) {
  const res = await fetch(url, {
    headers: { Authorization: authHeader(creds), Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Confluence API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Bounded-concurrency map. Sliding window: a slot opens the moment any task
// finishes, not at batch end.
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Progress reporting so the caller can stream something during the fetch.
// Without this the whole fetch is one opaque await and the UI looks hung.
export type FetchProgress = (info: { done: number; total?: number; message: string }) => void;

export type ConfluencePage = { id: string; title: string; text: string; url: string };

// Build an absolute, user-facing page URL from the API response _links.
// Prefer base+webui (clean URL incl. the title slug); fall back to the pageId
// redirect when _links is unavailable. Used to make citations click-through.
function buildPageUrl(links: { base?: string; webui?: string } | undefined, id: string): string {
  if (links?.base && links?.webui) return `${links.base}${links.webui}`;
  const root = (process.env.CONFLUENCE_BASE_URL ?? "").replace(/\/+$/, "");
  if (links?.webui && root) return `${root}/wiki${links.webui}`;
  return root ? `${root}/wiki/pages/viewpage.action?pageId=${id}` : "";
}

// Entry point — called by the sync route.
// Detects the URL type (page / folder / space) and routes to the right function.
// Automatically picks OAuth vs API token path based on creds type.
export async function fetchPagesFromUrl(
  confluenceUrl: string,
  creds: ConfluenceCreds,
  onProgress?: FetchProgress,
): Promise<ConfluencePage[]> {
  const pageMatch = confluenceUrl.match(/\/pages\/(\d+)/);
  if (pageMatch) {
    return creds.type === "oauth"
      ? fetchPageWithDescendantsOAuth(pageMatch[1], creds, onProgress)
      : fetchPageWithDescendantsV1(pageMatch[1], creds, onProgress);
  }

  // /folder/ID — use same CQL ancestor traversal as pages
  const folderMatch = confluenceUrl.match(/\/folder\/(\d+)/);
  if (folderMatch) {
    return creds.type === "oauth"
      ? fetchDescendantsOfIdOAuth(folderMatch[1], creds, onProgress)
      : fetchPageWithDescendantsV1(folderMatch[1], creds, onProgress);
  }

  const spaceMatch = confluenceUrl.match(/\/spaces\/([^/?#]+)/i);
  if (spaceMatch) {
    return creds.type === "oauth"
      ? fetchSpacePagesOAuth(spaceMatch[1], creds, onProgress)
      : fetchSpacePagesV1(spaceMatch[1], creds, onProgress);
  }

  throw new Error("Invalid Confluence URL — paste a space, page, or folder URL");
}

// ── OAuth path ────────────────────────────────────────────────────────────────
// Strategy: use v1 /search?cql=ancestor=X to discover ALL descendants
// (CQL traverses folders transparently). Fetch each page body via v2.

// Fetch multiple page bodies concurrently — 8 at a time to stay under
// Confluence's ~10 req/s rate limit.
const FETCH_CONCURRENCY = 8;

async function fetchPageBodiesOAuth(
  ids: string[],
  creds: ConfluenceCreds,
  onProgress?: FetchProgress,
): Promise<ConfluencePage[]> {
  const pages: ConfluencePage[] = [];
  let done = 0;

  await mapWithConcurrency(ids, FETCH_CONCURRENCY, async (id) => {
    try {
      const page = await cfetch(creds, `${v2Base(creds)}/pages/${id}?body-format=storage`);
      const text = cleanHtml(await resolveUserMentions(page.body?.storage?.value ?? "", creds));
      if (text.length >= 50) pages.push({ id: page.id, title: page.title, text, url: buildPageUrl(page._links, page.id) });
    } catch (e) {
      console.warn(`[confluence] skipping page ${id}:`, e);
    } finally {
      done++;
      onProgress?.({ done, total: ids.length, message: `Fetched ${done}/${ids.length} pages from Confluence...` });
    }
  });

  return pages;
}

// OAuth + folder URL.
// Folders have no body — skips the root, fetches all pages inside via CQL.
async function fetchDescendantsOfIdOAuth(
  id: string,
  creds: ConfluenceCreds,
  onProgress?: FetchProgress,
): Promise<ConfluencePage[]> {
  const ids = await fetchDescendantIdsViaCql(id, creds, onProgress);
  return fetchPageBodiesOAuth(ids, creds, onProgress);
}

// OAuth + page URL.
// Fetches root page body via v2, then all descendants via CQL, each body via v2.
async function fetchPageWithDescendantsOAuth(
  pageId: string,
  creds: ConfluenceCreds,
  onProgress?: FetchProgress,
): Promise<ConfluencePage[]> {
  const pages: ConfluencePage[] = [];

  onProgress?.({ done: 0, message: "Fetching root page from Confluence..." });

  // Root page body via v2
  const root = await cfetch(creds, `${v2Base(creds)}/pages/${pageId}?body-format=storage`);
  const rootText = cleanHtml(await resolveUserMentions(root.body?.storage?.value ?? "", creds));
  if (rootText.length >= 50) pages.push({ id: root.id, title: root.title, text: rootText, url: buildPageUrl(root._links, root.id) });

  // All descendants via v1 CQL — fetch bodies in parallel batches
  const ids = await fetchDescendantIdsViaCql(pageId, creds, onProgress);
  const descendants = await fetchPageBodiesOAuth(ids, creds, onProgress);
  return [...pages, ...descendants];
}

// CQL search to find ALL descendant page IDs under a page or folder.
// Uses v1 /search which still works on the OAuth gateway (not deprecated).
// CQL ancestor=X traverses the full tree including pages inside folders.
// Returns only IDs — bodies are fetched separately via v2 to avoid 410.
async function fetchDescendantIdsViaCql(
  pageId: string,
  creds: ConfluenceCreds,
  onProgress?: FetchProgress,
): Promise<string[]> {
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
    onProgress?.({ done: ids.length, message: `Discovered ${ids.length} pages in Confluence tree...` });
    if (!json._links?.next) break;
    start += 50;
  }

  return ids;
}

// OAuth + space URL.
// CQL space=KEY finds all pages in the space, fetches each body via v2.
async function fetchSpacePagesOAuth(
  spaceKey: string,
  creds: ConfluenceCreds,
  onProgress?: FetchProgress,
): Promise<ConfluencePage[]> {
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
    onProgress?.({ done: ids.length, message: `Discovered ${ids.length} pages in space...` });
    if (!json._links?.next) break;
    start += 50;
  }

  // Then fetch all bodies in parallel batches
  return fetchPageBodiesOAuth(ids, creds, onProgress);
}

// ── API token: v1 API ─────────────────────────────────────────────────────────

// API token + page or folder URL.
// v1 works fine on direct instance URL — body returned inline with expand=body.storage,
// no need for a separate v2 fetch per page.
async function fetchPageWithDescendantsV1(
  pageId: string,
  creds: ConfluenceCreds,
  onProgress?: FetchProgress,
): Promise<ConfluencePage[]> {
  const base = v1Base(creds);
  const pages: ConfluencePage[] = [];

  onProgress?.({ done: 0, message: "Fetching root page from Confluence..." });

  const root = await cfetch(creds, `${base}/content/${pageId}?expand=body.storage`);
  const rootText = cleanHtml(await resolveUserMentions(root.body?.storage?.value ?? "", creds));
  if (rootText.length >= 50) pages.push({ id: root.id, title: root.title, text: rootText, url: buildPageUrl(root._links, root.id) });

  let start = 0;
  while (true) {
    const cql = encodeURIComponent(`ancestor = ${pageId} AND type = page`);
    const json = await cfetch(creds, `${base}/search?cql=${cql}&expand=body.storage&limit=50&start=${start}`);
    const results = json.results ?? [];

    // Resolve every @mention in this batch up front, then the per-page loop
    // below hits a warm cache instead of a round trip per page.
    await warmUserCache(
      results.map((r: { content?: { body?: { storage?: { value?: string } } }; body?: { storage?: { value?: string } } }) =>
        (r.content ?? r).body?.storage?.value ?? "",
      ),
      creds,
    );

    for (const r of results) {
      const page = r.content ?? r;
      const text = cleanHtml(await resolveUserMentions(page.body?.storage?.value ?? "", creds));
      if (text.length >= 50) pages.push({ id: page.id, title: page.title, text, url: buildPageUrl(page._links, page.id) });
    }
    onProgress?.({ done: pages.length, message: `Fetched ${pages.length} pages from Confluence...` });
    if (!json._links?.next) break;
    start += 50;
  }

  return pages;
}

// API token + space URL.
// GET /content?spaceKey=KEY returns all pages with body inline.
async function fetchSpacePagesV1(
  spaceKey: string,
  creds: ConfluenceCreds,
  onProgress?: FetchProgress,
): Promise<ConfluencePage[]> {
  const base = v1Base(creds);
  const pages: ConfluencePage[] = [];
  let start = 0;

  while (true) {
    const json = await cfetch(creds, `${base}/content?spaceKey=${spaceKey}&type=page&expand=body.storage&limit=50&start=${start}`);
    const results = json.results ?? [];

    // Same batch warm-up as the page path — one concurrent pass instead of a
    // serialized round trip per page.
    await warmUserCache(
      results.map((p: { body?: { storage?: { value?: string } } }) => p.body?.storage?.value ?? ""),
      creds,
    );

    for (const page of results) {
      const text = cleanHtml(await resolveUserMentions(page.body?.storage?.value ?? "", creds));
      if (text.length > 50) pages.push({ id: page.id, title: page.title, text, url: buildPageUrl(page._links, page.id) });
    }
    onProgress?.({ done: pages.length, message: `Fetched ${pages.length} pages from space...` });
    if (!json._links?.next) break;
    start += 50;
  }

  return pages;
}

// ── User-mention resolution ─────────────────────────────────────────────────
// Confluence stores @mentions as <ri:user ri:account-id="..."/> with NO inline
// text — the display name is resolved at render time. cleanHtml strips the tag,
// so tables of people (e.g. the certification lists) lost every name. Resolve
// account-ids to display names via the user API; cache across the whole sync run.
const userNameCache = new Map<string, string>();

const USER_MENTION_RE = /<ri:user\b[^>]*ri:account-id="([^"]+)"[^>]*\/?>/gi;
const USER_LOOKUP_CONCURRENCY = 8;

// Resolve every @mention in a whole BATCH of page bodies before touching any of
// them individually. Previously each page was awaited in turn inside a for loop,
// so a tree of N pages cost N serialized round trips — and the same person
// mentioned across 40 pages was looked up 40 times in a row before the cache
// caught up. Deduping across the batch first collapses that to one bounded,
// concurrent pass; resolveUserMentions() then finds everything cached and its
// internal Promise.all resolves with nothing to fetch.
async function warmUserCache(htmls: string[], creds: ConfluenceCreds): Promise<void> {
  const ids = new Set<string>();
  for (const html of htmls) {
    for (const m of html.matchAll(USER_MENTION_RE)) {
      if (!userNameCache.has(m[1])) ids.add(m[1]);
    }
  }
  if (ids.size === 0) return;

  await mapWithConcurrency([...ids], USER_LOOKUP_CONCURRENCY, async (id) => {
    try {
      const u = await cfetch(creds, `${v1Base(creds)}/user?accountId=${encodeURIComponent(id)}`);
      userNameCache.set(id, u.displayName ?? u.publicName ?? "");
    } catch {
      userNameCache.set(id, ""); // leave blank rather than emit a raw account-id
    }
  });
}

export async function resolveUserMentions(html: string, creds: ConfluenceCreds): Promise<string> {
  const re = /<ri:user\b[^>]*ri:account-id="([^"]+)"[^>]*\/?>/gi;
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  if (ids.size === 0) return html;

  await Promise.all(
    [...ids]
      .filter((id) => !userNameCache.has(id))
      .map(async (id) => {
        try {
          const u = await cfetch(creds, `${v1Base(creds)}/user?accountId=${encodeURIComponent(id)}`);
          userNameCache.set(id, u.displayName ?? u.publicName ?? "");
        } catch {
          userNameCache.set(id, ""); // leave blank rather than emit a raw account-id
        }
      }),
  );

  return html.replace(re, (_full, id) => ` ${userNameCache.get(id) ?? ""} `);
}

// ── HTML cleaner ──────────────────────────────────────────────────────────────

// Convert HTML tables to pipe-delimited rows so each record stays on ONE line.
// The old behaviour (</td> and </tr> both -> "\n") shredded every cell onto its
// own line, destroying row associations AND scattering the data across chunks
// that contain none of the table's topical words — which is exactly why
// "list of <X>" table lookups returned nothing. Runs before generic tag stripping.
function tablesToMarkdown(html: string): string {
  return html.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    const rows: string[] = [];
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr: RegExpExecArray | null;
    while ((tr = trRe.exec(table)) !== null) {
      const cells: string[] = [];
      const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let cell: RegExpExecArray | null;
      while ((cell = cellRe.exec(tr[1])) !== null) {
        cells.push(cell[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      }
      if (cells.length) rows.push(`| ${cells.join(" | ")} |`);
    }
    return `\n${rows.join("\n")}\n`;
  });
}

// Converts Confluence storage-format HTML to plain text for chunking.
// Strips Atlassian-specific tags (ac:, ri:), decodes HTML entities,
// preserves paragraph structure as newlines.
export function cleanHtml(html: string): string {
  // Confluence date elements store the date in an attribute, not as text.
  // Extract it BEFORE any tag stripping (incl. table-cell flattening) or it's lost.
  let t = html.replace(/<time\b[^>]*\bdatetime="([^"]+)"[^>]*\/?>/gi, " $1 ");
  t = tablesToMarkdown(t);
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
