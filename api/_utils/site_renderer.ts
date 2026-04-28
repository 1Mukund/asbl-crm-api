/**
 * JS-rendered HTML fetcher using Puppeteer + @sparticuz/chromium
 *
 * asbl.in is an Angular SPA — content is rendered client-side. Plain
 * `axios.get` returns only the bootstrap shell. We use a headless
 * Chromium to actually run the JS, wait for content, and dump the
 * rendered HTML.
 *
 * Used by the weekly cron only — not on the request-handling path,
 * so the Chromium cold start (~5-10 s) is paid once per week.
 */

const NAV_TIMEOUT_MS = 30_000;
const SETTLE_MS = 5_000;            // extra time after networkidle for late-firing JS / pricing hydration

const REAL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

let cachedBrowser: any = null;

async function getBrowser(): Promise<any> {
  if (cachedBrowser) return cachedBrowser;

  // Lazy import so dev environments without these packages installed
  // don't blow up at module load time.
  const puppeteer = await import("puppeteer-core");
  const chromiumMod: any = await import("@sparticuz/chromium");
  const chromium = chromiumMod.default || chromiumMod;

  const executablePath = await chromium.executablePath();
  const launched = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1366, height: 900 },
    executablePath,
    headless: true,
  });
  cachedBrowser = launched;
  return cachedBrowser;
}

export async function closeBrowser(): Promise<void> {
  if (cachedBrowser) {
    try { await cachedBrowser.close(); } catch { /* ignore */ }
    cachedBrowser = null;
  }
}

export async function renderPage(url: string): Promise<string> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(REAL_UA);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    });

    // Light evasion: hide webdriver flag that bot-detect scripts often check
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });

    // Allow late-firing component code (pricing, dynamic specs) to hydrate
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // Scroll to bottom to trigger lazy-loaded sections
    try {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await new Promise((r) => setTimeout(r, 1000));
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((r) => setTimeout(r, 500));
    } catch { /* ignore */ }

    const html = await page.content();
    return html;
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
}
