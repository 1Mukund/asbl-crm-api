/**
 * Site crawler — fetches asbl.in/<project> + internal sub-pages,
 * extracts plain text, caches in Supabase site_cache table.
 *
 * Strict scope:
 *   - Only domain: asbl.in
 *   - Only paths starting with /<project> (e.g. /loft, /loft/anything)
 *   - Max depth: 2
 *   - Max pages per project: 15
 *   - Skip PDFs/images/binary
 */
import axios from "axios";
import * as cheerio from "cheerio";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

const PROJECT_URLS: Record<string, string> = {
  LOFT:     "https://asbl.in/loft",
  SPECTRA:  "https://asbl.in/spectra",
  BROADWAY: "https://asbl.in/broadway",
  LANDMARK: "https://asbl.in/landmark",
};

const MAX_DEPTH = 2;
const MAX_PAGES_PER_PROJECT = 15;
const FETCH_TIMEOUT_MS = 15000;

// ── Extract clean text from HTML ──────────────────────────────────────────────
function extractText(html: string): string {
  const $ = cheerio.load(html);
  // Remove non-content elements
  $("script, style, nav, footer, header, noscript, iframe, svg, link[rel=stylesheet]").remove();
  // Get visible text
  const text = $("body").text() || $.root().text();
  // Collapse whitespace
  return text.replace(/\s+/g, " ").trim();
}

// ── Extract internal links scoped to project path ─────────────────────────────
function extractInternalLinks(html: string, projectPath: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const links = new Set<string>();
  const projectPrefix = projectPath.endsWith("/") ? projectPath : projectPath + "/";

  $("a[href]").each((_, el) => {
    let href = ($(el).attr("href") || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) return;

    // Resolve relative URL
    let absUrl: URL;
    try {
      absUrl = new URL(href, baseUrl);
    } catch { return; }

    // Strict scope: only asbl.in, only project subpath
    if (absUrl.hostname !== "asbl.in") return;
    if (absUrl.pathname !== projectPath && !absUrl.pathname.startsWith(projectPrefix)) return;

    // Skip binary/asset files
    const lower = absUrl.pathname.toLowerCase();
    if (/\.(pdf|jpg|jpeg|png|gif|svg|webp|mp4|mp3|zip|css|js)$/i.test(lower)) return;

    // Strip hash and trailing slash variants for dedup
    absUrl.hash = "";
    links.add(absUrl.toString());
  });

  return Array.from(links);
}

// ── BFS crawl one project ─────────────────────────────────────────────────────
async function crawlProject(project: string): Promise<{ text: string; urls: string[]; pageCount: number; error?: string }> {
  const startUrl = PROJECT_URLS[project];
  if (!startUrl) return { text: "", urls: [], pageCount: 0, error: `No URL configured for ${project}` };

  const startPath = new URL(startUrl).pathname;
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  const collected: Array<{ url: string; text: string }> = [];

  while (queue.length > 0 && visited.size < MAX_PAGES_PER_PROJECT) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const r = await axios.get(url, {
        timeout: FETCH_TIMEOUT_MS,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ASBL-Bot/1.0)",
          "Accept": "text/html,application/xhtml+xml",
        },
        maxRedirects: 3,
        validateStatus: (s) => s >= 200 && s < 400,
      });

      const html = String(r.data || "");
      const text = extractText(html);

      if (text.length > 50) {
        collected.push({ url, text });
      }

      // Enqueue child links (within scope)
      if (depth < MAX_DEPTH) {
        const links = extractInternalLinks(html, startPath, url);
        for (const link of links) {
          if (!visited.has(link)) {
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      }
    } catch (err: any) {
      console.error(`[Crawler] Failed ${url}: ${err.message}`);
    }
  }

  if (collected.length === 0) {
    return { text: "", urls: [], pageCount: 0, error: "No pages successfully crawled" };
  }

  // Concat with page boundaries for LLM clarity
  const combined = collected
    .map((p) => `=== ${p.url} ===\n${p.text}`)
    .join("\n\n");

  return {
    text: combined,
    urls: collected.map((p) => p.url),
    pageCount: collected.length,
  };
}

// ── Update site_cache row in Supabase ─────────────────────────────────────────
async function updateCache(project: string, content: string, urls: string[], pageCount: number, error: string | null): Promise<void> {
  const body = {
    content_text: content,
    urls_crawled: urls,
    page_count: pageCount,
    fetched_at: new Date().toISOString(),
    error,
  };

  const r = await fetch(`${SUPABASE_URL}/rest/v1/site_cache?project=eq.${project}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`site_cache update ${r.status}: ${t}`);
  }
}

// ── Public: refresh all projects ──────────────────────────────────────────────
export async function refreshAllSites(): Promise<Array<{ project: string; pageCount: number; bytes: number; error?: string }>> {
  const results: Array<{ project: string; pageCount: number; bytes: number; error?: string }> = [];

  for (const project of Object.keys(PROJECT_URLS)) {
    console.log(`[Crawler] Refreshing ${project}...`);
    const result = await crawlProject(project);
    try {
      await updateCache(project, result.text, result.urls, result.pageCount, result.error || null);
    } catch (err: any) {
      console.error(`[Crawler] Cache update failed for ${project}: ${err.message}`);
    }
    results.push({
      project,
      pageCount: result.pageCount,
      bytes: result.text.length,
      error: result.error,
    });
  }

  return results;
}

// ── Public: read cached content for project ──────────────────────────────────
export async function getCachedContent(project: string): Promise<{ text: string; fetchedAt: string | null; stale: boolean }> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/site_cache?project=eq.${project}&select=content_text,fetched_at`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await r.json();
  const row = rows?.[0];
  if (!row || !row.content_text) {
    return { text: "", fetchedAt: null, stale: true };
  }
  // Stale if > 14 days old (weekly cron + buffer)
  const fetchedMs = new Date(row.fetched_at).getTime();
  const stale = Date.now() - fetchedMs > 14 * 24 * 60 * 60 * 1000;
  return { text: row.content_text, fetchedAt: row.fetched_at, stale };
}

// ── Lazy refresh for single project (when cache empty/very stale) ────────────
export async function refreshSingleProject(project: string): Promise<void> {
  if (!PROJECT_URLS[project]) return;
  const result = await crawlProject(project);
  await updateCache(project, result.text, result.urls, result.pageCount, result.error || null);
}
