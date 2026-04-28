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

// ── Walk ALL elements and extract own-text (not descendant text) ─────────────
// asbl.in is an Angular SPA — pricing/specs live inside <div>/<span> blocks
// (not just h/p/li). We walk every element and pull only its DIRECT text
// nodes so a parent doesn't duplicate the text of its children.
function extractBodyText($: cheerio.CheerioAPI, scope: cheerio.Cheerio<any>): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  scope.find("body *, body").each((_, el) => {
    const tag = ((el as any).tagName || (el as any).name || "").toLowerCase();
    if (["script", "style", "noscript"].includes(tag)) return;

    // Own text only (direct text nodes, not nested elements' text)
    const ownText = $(el)
      .contents()
      .filter((_, n: any) => n.type === "text")
      .map((_, n: any) => $(n).text())
      .get()
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!ownText || ownText.length < 2) return;
    if (seen.has(ownText)) return;
    seen.add(ownText);

    const hMatch = tag.match(/^h(\d)$/);
    if (hMatch) {
      const lvl = Math.min(parseInt(hMatch[1], 10), 6);
      lines.push("\n" + "#".repeat(lvl) + " " + ownText);
    } else {
      lines.push(ownText);
    }
  });

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Extract nav structure (pages + sections) from home HTML ──────────────────
function extractNavStructure(
  html: string,
  projectPath: string,
): { pages: Array<{ url: string; label: string }>; sectionsByPage: Record<string, string[]> } {
  const $ = cheerio.load(html);
  const projectPrefix = projectPath.endsWith("/") ? projectPath : projectPath + "/";
  const pages = new Map<string, string>(); // pathname → label
  const sectionsByPage: Record<string, Set<string>> = {};

  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const label = $(el).text().replace(/\s+/g, " ").trim();
    if (!href || !label || label.length < 2) return;

    let url: URL;
    try { url = new URL(href, "https://asbl.in"); } catch { return; }
    if (url.hostname !== "asbl.in") return;
    if (url.pathname !== projectPath && !url.pathname.startsWith(projectPrefix)) return;

    const scroll = url.searchParams.get("scroll");
    if (scroll) {
      const parent = url.pathname;
      if (!sectionsByPage[parent]) sectionsByPage[parent] = new Set();
      sectionsByPage[parent].add(label);
    } else {
      // Page-level link
      if (!pages.has(url.pathname) || pages.get(url.pathname)!.length < label.length) {
        pages.set(url.pathname, label);
      }
    }
  });

  return {
    pages: Array.from(pages.entries()).map(([url, label]) => ({ url, label })),
    sectionsByPage: Object.fromEntries(
      Object.entries(sectionsByPage).map(([k, v]) => [k, Array.from(v)]),
    ),
  };
}

// ── Build structured project content from a single home-page fetch ──────────
function buildStructuredContent(html: string, project: string, projectPath: string): string {
  const $ = cheerio.load(html);

  // Meta extraction
  const title = $("title").first().text().trim();
  const description =
    $("meta[name='description']").attr("content") ||
    $("meta[property='og:description']").attr("content") ||
    "";
  const ogTitle = $("meta[property='og:title']").attr("content") || "";
  const keywords = $("meta[name='keywords']").attr("content") || "";

  const nav = extractNavStructure(html, projectPath);

  // Strip noise before body extraction
  $("script, style, noscript, iframe, svg, link, meta, button, form, [aria-hidden='true']").remove();
  $(".nav, .navbar, .menu, .footer, .header, .sidebar, .cookie, .modal, .breadcrumb").remove();

  const body = extractBodyText($, $.root());

  const sections: string[] = [];

  sections.push(`# PROJECT: ${project}`);

  sections.push(`\n## Meta`);
  if (title) sections.push(`Title: ${title}`);
  if (ogTitle && ogTitle !== title) sections.push(`OG Title: ${ogTitle.trim()}`);
  if (description) sections.push(`Description: ${description.trim()}`);
  if (keywords) sections.push(`Keywords: ${keywords.trim()}`);

  if (nav.pages.length > 0) {
    sections.push(`\n## Pages on this project's site`);
    for (const p of nav.pages) {
      sections.push(`- ${p.label}  (${p.url})`);
    }
  }

  const sectionEntries = Object.entries(nav.sectionsByPage);
  if (sectionEntries.length > 0) {
    sections.push(`\n## Named sections within each page (from in-page anchors)`);
    for (const [page, labels] of sectionEntries) {
      sections.push(`### ${page}`);
      for (const l of labels) sections.push(`- ${l}`);
    }
  }

  if (body) {
    sections.push(`\n## Body Content (extracted from home page; same shell for all sub-pages on this Angular SPA)`);
    sections.push(body);
  }

  return sections.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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

    const lower = absUrl.pathname.toLowerCase();
    absUrl.hash = "";

    // Document: PDF/DOC on asbl.in OR any *.asbl.in subdomain (e.g. media.asbl.in)
    const isAsblHost = absUrl.hostname === "asbl.in" || absUrl.hostname.endsWith(".asbl.in");
    if (isAsblHost && /\.(pdf|doc|docx)(\?|$)/i.test(lower)) {
      docLinks.add(absUrl.toString());
      return;
    }

    // HTML page: strict — only asbl.in (no subdomains) AND under project subpath
    if (absUrl.hostname !== "asbl.in") return;
    if (absUrl.pathname !== projectPath && !absUrl.pathname.startsWith(projectPrefix)) return;
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

// ── Crawl one project — single fetch, structured output ─────────────────────
// Since asbl.in is an Angular SPA returning identical HTML for every URL
// under /<project>/*, we fetch the home page ONCE and extract:
//   - meta tags
//   - nav-derived page list
//   - in-page section labels (from ?scroll=xxx-section anchors)
//   - body text (own-text walk to capture pricing in divs/spans)
//   - all PDF/doc links anywhere on asbl.in / *.asbl.in
async function crawlProject(project: string): Promise<{ text: string; urls: string[]; pageCount: number; docsFound: number; error?: string }> {
  const startUrl = PROJECT_URLS[project];
  if (!startUrl) return { text: "", urls: [], pageCount: 0, docsFound: 0, error: `No URL configured for ${project}` };

  const startPath = new URL(startUrl).pathname;

  let html = "";
  try {
    const r = await axios.get(startUrl, {
      timeout: FETCH_TIMEOUT_MS,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ASBL-Bot/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
      maxRedirects: 3,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    html = String(r.data || "");
  } catch (err: any) {
    return { text: "", urls: [], pageCount: 0, docsFound: 0, error: `Fetch failed: ${err.message}` };
  }

  if (!html || html.length < 200) {
    return { text: "", urls: [], pageCount: 0, docsFound: 0, error: "Empty or too-small HTML" };
  }

  // Build structured content from this single fetch
  const structured = buildStructuredContent(html, project, startPath);

  // Discover documents (PDFs/DOCs anywhere on asbl.in / *.asbl.in)
  const { docs } = extractAllLinks(html, startPath, startUrl);
  const docsFound = await saveDocuments(project, docs);

  // List of nav page URLs (for dashboard reference; we don't refetch them)
  const nav = extractNavStructure(html, startPath);
  const urlsCrawled = [startUrl, ...nav.pages.map((p) => "https://asbl.in" + p.url)].filter(
    (v, i, arr) => arr.indexOf(v) === i,
  );

  return {
    text: structured,
    urls: urlsCrawled,
    pageCount: 1, // we only fetch once; the SPA serves identical HTML for sub-paths
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
