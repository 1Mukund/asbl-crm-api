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

// ── Extract STRUCTURED text from HTML (preserves heading hierarchy) ─────────
function extractText(html: string): string {
  const $ = cheerio.load(html);

  // Strip non-content elements aggressively
  $("script, style, nav, footer, header, noscript, iframe, svg, link, meta, button, form, [aria-hidden='true']").remove();
  $(".nav, .navbar, .menu, .footer, .header, .sidebar, .cookie, .modal, .breadcrumb").remove();

  // Find content scope (prefer semantic landmarks)
  const candidates = [$("main").first(), $("article").first(), $("[role=main]").first()];
  const scope = candidates.find((c) => c.length > 0) || $("body");

  const lines: string[] = [];
  const seen = new Set<string>();

  scope.find("h1, h2, h3, h4, h5, h6, p, li").each((_, el) => {
    const tag = ((el as any).tagName || (el as any).name || "").toLowerCase();
    const raw = $(el).text().replace(/\s+/g, " ").trim();

    if (!raw || raw.length < 3) return;
    if (seen.has(raw)) return;     // dedup nested duplicates (e.g. <li><p>x</p></li>)
    seen.add(raw);

    const headingMatch = tag.match(/^h(\d)$/);
    if (headingMatch) {
      const level = Math.min(parseInt(headingMatch[1], 10), 6);
      lines.push("\n" + "#".repeat(level) + " " + raw);
    } else {
      lines.push(raw);
    }
  });

  if (lines.length === 0) {
    // Fallback: body text collapsed
    return scope.text().replace(/\s+/g, " ").trim();
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Extract internal links — split into HTML-pages-to-crawl vs documents ──
function extractAllLinks(html: string, projectPath: string, baseUrl: string): { html: string[]; docs: string[] } {
  const $ = cheerio.load(html);
  const htmlLinks = new Set<string>();
  const docLinks  = new Set<string>();
  const projectPrefix = projectPath.endsWith("/") ? projectPath : projectPath + "/";

  $("a[href]").each((_, el) => {
    let href = ($(el).attr("href") || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) return;

    let absUrl: URL;
    try { absUrl = new URL(href, baseUrl); } catch { return; }

    // Domain whitelist: only asbl.in (PDFs hosted on cdn/storage subdomains
    // could be relaxed later, but for now strict-same-domain)
    if (absUrl.hostname !== "asbl.in") return;

    const lower = absUrl.pathname.toLowerCase();
    absUrl.hash = "";

    // Document: PDF or DOC anywhere on asbl.in (project-tagged via heuristic later)
    if (/\.(pdf|doc|docx)(\?|$)/i.test(lower)) {
      docLinks.add(absUrl.toString());
      return;
    }

    // HTML page: must be under project subpath
    if (absUrl.pathname !== projectPath && !absUrl.pathname.startsWith(projectPrefix)) return;
    // Skip image/media files
    if (/\.(jpg|jpeg|png|gif|svg|webp|mp4|mp3|zip|css|js)$/i.test(lower)) return;

    htmlLinks.add(absUrl.toString());
  });

  return { html: Array.from(htmlLinks), docs: Array.from(docLinks) };
}

// ── Categorize a document URL by filename heuristic ─────────────────────────
function categorizeDoc(url: string): string {
  const filename = (url.split("/").pop() || "").split("?")[0].toLowerCase();
  if (/(brochure|brouchure|brochur)/.test(filename)) return "brochure";
  if (/(price|costsheet|cost-sheet|cost_sheet|pricelist|price-list|price_list)/.test(filename)) return "price_sheet";
  if (/(payment|paymentschedule|payment-schedule|payment_schedule|paymentplan|payment-plan)/.test(filename)) return "payment_structure";
  if (/(floor|plan|layout)/.test(filename)) return "floor_plan";
  return "other";
}

// ── Save discovered documents to project_documents table ────────────────────
async function saveDocuments(project: string, urls: string[]): Promise<number> {
  if (urls.length === 0) return 0;

  const docs = urls.map((url) => {
    const filename = (url.split("/").pop() || "").split("?")[0];
    return {
      project,
      doc_type: categorizeDoc(url),
      filename,
      url,
    };
  });

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/project_documents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify(docs),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error(`[Crawler] saveDocuments failed ${r.status}: ${t}`);
    }
  } catch (err: any) {
    console.error(`[Crawler] saveDocuments threw: ${err.message}`);
  }

  return docs.length;
}

// ── BFS crawl one project ─────────────────────────────────────────────────────
async function crawlProject(project: string): Promise<{ text: string; urls: string[]; pageCount: number; docsFound: number; error?: string }> {
  const startUrl = PROJECT_URLS[project];
  if (!startUrl) return { text: "", urls: [], pageCount: 0, docsFound: 0, error: `No URL configured for ${project}` };

  const startPath = new URL(startUrl).pathname;
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  const collected: Array<{ url: string; text: string }> = [];
  const allDocLinks = new Set<string>();

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

      // Extract both HTML pages and document links
      const { html: htmlLinks, docs: docLinks } = extractAllLinks(html, startPath, url);

      // Track docs (don't visit, just record)
      for (const doc of docLinks) allDocLinks.add(doc);

      // Enqueue child HTML pages within depth budget
      if (depth < MAX_DEPTH) {
        for (const link of htmlLinks) {
          if (!visited.has(link)) {
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      }
    } catch (err: any) {
      console.error(`[Crawler] Failed ${url}: ${err.message}`);
    }
  }

  // Save discovered documents to project_documents table
  const docsArr = Array.from(allDocLinks);
  const docsFound = await saveDocuments(project, docsArr);

  if (collected.length === 0) {
    return { text: "", urls: [], pageCount: 0, docsFound, error: "No pages successfully crawled" };
  }

  const combined = collected
    .map((p) => `=== ${p.url} ===\n${p.text}`)
    .join("\n\n");

  return {
    text: combined,
    urls: collected.map((p) => p.url),
    pageCount: collected.length,
    docsFound,
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
export async function refreshAllSites(): Promise<Array<{ project: string; pageCount: number; bytes: number; docsFound: number; error?: string }>> {
  const results: Array<{ project: string; pageCount: number; bytes: number; docsFound: number; error?: string }> = [];

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
      docsFound: result.docsFound,
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
