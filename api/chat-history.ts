import type { VercelRequest, VercelResponse } from "@vercel/node";

const LAZYBOT_URL = process.env.LAZYBOT_URL || "https://lazybot-whatsapp-crm.onrender.com";
const LAZYBOT_API_KEY = process.env.LAZYBOT_API_KEY || "";
const LAZYBOT_SESSION_ID = process.env.LAZYBOT_SESSION_ID || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

// ── Helper: Supabase REST GET ────────────────────────────────────────────────
async function sb(path: string): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) return [];
  return r.json();
}

// ── Helper: HTML escape ──────────────────────────────────────────────────────
function esc(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Helper: format relative time ─────────────────────────────────────────────
function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

// ── Compute next cron run from a known schedule ─────────────────────────────
function nextCronRun(schedule: string): string {
  // Hardcoded for the two schedules we use:
  //   "30 4 * * *"   → daily 04:30 UTC = 10:00 IST every day
  //   "30 22 * * 6"  → Saturday 22:30 UTC = Sunday 04:00 IST every week
  const now = new Date();
  if (schedule === "30 4 * * *") {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 30));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }
  if (schedule === "30 22 * * 6") {
    // next Saturday 22:30 UTC
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22, 30));
    const dow = next.getUTCDay(); // 0=Sun..6=Sat
    let daysAhead = (6 - dow + 7) % 7;
    if (daysAhead === 0 && next.getTime() <= now.getTime()) daysAhead = 7;
    next.setUTCDate(next.getUTCDate() + daysAhead);
    return next.toISOString();
  }
  return "—";
}

// ── Render dashboard HTML ────────────────────────────────────────────────────
async function renderDashboard(): Promise<string> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [siteRows, msgs24h, intentRows, cronRows, docRows] = await Promise.all([
    sb(`site_cache?select=project,page_count,fetched_at,error,content_text,urls_crawled&order=project.asc`),
    sb(`whatsapp_messages?created_at=gte.${since24h}&select=phone,direction,message,project,intent,sender,created_at&order=created_at.desc&limit=300`),
    sb(`whatsapp_messages?created_at=gte.${since24h}&direction=eq.inbound&intent=not.is.null&select=intent,project`),
    sb(`cron_log?select=task,ran_at,duration_ms,result,error&order=ran_at.desc&limit=20`),
    sb(`project_documents?select=project,doc_type,filename,url,fetched_at&order=fetched_at.desc&limit=50`),
  ]);

  // ── Section 1: Crawled data summary ────────────────────────────────────
  const siteHtml = siteRows
    .map((r: any) => {
      const bytes = (r.content_text || "").length;
      const status = r.error
        ? `<span style="color:#c00">${esc(r.error)}</span>`
        : `<span style="color:#080">ok</span>`;
      return `<tr>
        <td>${esc(r.project)}</td>
        <td>${esc(r.page_count || 0)}</td>
        <td>${(bytes / 1024).toFixed(1)} KB</td>
        <td>${esc(r.fetched_at ? new Date(r.fetched_at).toLocaleString("en-IN") : "—")}</td>
        <td>${timeAgo(r.fetched_at)}</td>
        <td>${status}</td>
        <td><a href="#content-${esc(r.project)}">view ↓</a></td>
      </tr>`;
    })
    .join("");

  // ── Section 1b: Per-project stored content + structure stats ──────────
  function parseStructure(content: string): { metaCount: number; headings: string[]; lineCount: number; uniqueLines: number; navLine: string | null } {
    if (!content) return { metaCount: 0, headings: [], lineCount: 0, uniqueLines: 0, navLine: null };
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    const metaCount = lines.filter((l) => /^(Description|OG Title|Keywords):/.test(l)).length;
    const headings = lines.filter((l) => /^#{1,6}\s+/.test(l)).map((l) => l.replace(/^#+\s*/, "").trim());
    const navLine = lines.find((l) => l.startsWith("Site sections / linked pages:")) || null;
    const uniqueLines = new Set(lines).size;
    return { metaCount, headings, lineCount: lines.length, uniqueLines, navLine };
  }

  const contentSectionsHtml = siteRows
    .map((r: any) => {
      const content = r.content_text || "";
      const stats = parseStructure(content);
      const headingPreview = stats.headings.slice(0, 12).map((h) => esc(h)).join(", ") + (stats.headings.length > 12 ? `, …${stats.headings.length - 12} more` : "");
      const navPreview = stats.navLine
        ? esc(stats.navLine.replace("Site sections / linked pages:", "").trim().slice(0, 400)) + (stats.navLine.length > 400 ? "…" : "")
        : "—";
      const fetched = r.fetched_at ? new Date(r.fetched_at).toLocaleString("en-IN") : "never";
      return `<details id="content-${esc(r.project)}" class="proj-content">
        <summary><strong>${esc(r.project)}</strong> — ${(content.length / 1024).toFixed(1)} KB · ${stats.lineCount} lines (${stats.uniqueLines} unique) · ${stats.headings.length} headings · ${stats.metaCount} meta blocks · fetched ${esc(fetched)}</summary>
        <div class="proj-stats">
          <div><b>Sample headings:</b> ${headingPreview || "—"}</div>
          <div style="margin-top:6px"><b>Linked sections (nav):</b> <span style="color:#555">${navPreview}</span></div>
          <div style="margin-top:6px"><b>Source URLs crawled:</b> ${(r.urls_crawled || []).slice(0, 8).map((u: string) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace("https://asbl.in", ""))}</a>`).join(" · ") || "—"}${(r.urls_crawled || []).length > 8 ? ` · …${(r.urls_crawled || []).length - 8} more` : ""}</div>
        </div>
        <pre class="proj-text">${esc(content) || "(no content stored yet)"}</pre>
      </details>`;
    })
    .join("");

  // ── Section 2: Daily chats (last 24h) ──────────────────────────────────
  const phoneMap = new Map<string, { phone: string; lastMsg: string; project: string | null; intent: string | null; count: number; lastTime: string }>();
  for (const m of msgs24h) {
    const key = m.phone;
    if (!phoneMap.has(key)) {
      phoneMap.set(key, { phone: key, lastMsg: m.message, project: m.project, intent: m.intent, count: 1, lastTime: m.created_at });
    } else {
      const cur = phoneMap.get(key)!;
      cur.count++;
      if (!cur.project && m.project) cur.project = m.project;
      if (!cur.intent && m.intent) cur.intent = m.intent;
    }
  }
  const chatHtml = Array.from(phoneMap.values())
    .sort((a, b) => new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime())
    .slice(0, 30)
    .map((c) => `<tr>
      <td><code>${esc(c.phone)}</code></td>
      <td>${esc(c.project) || "—"}</td>
      <td>${esc(c.intent) || "—"}</td>
      <td>${c.count}</td>
      <td title="${esc(c.lastMsg)}">${esc((c.lastMsg || "").slice(0, 60))}${(c.lastMsg || "").length > 60 ? "..." : ""}</td>
      <td>${timeAgo(c.lastTime)}</td>
    </tr>`)
    .join("");

  // ── Section 3: Intent classification (last 24h) ─────────────────────────
  const intentCounts: Record<string, number> = {};
  const intentByProject: Record<string, Record<string, number>> = {};
  for (const r of intentRows) {
    const intent = r.intent || "(none)";
    intentCounts[intent] = (intentCounts[intent] || 0) + 1;
    const proj = r.project || "(no project)";
    if (!intentByProject[proj]) intentByProject[proj] = {};
    intentByProject[proj][intent] = (intentByProject[proj][intent] || 0) + 1;
  }
  const intentTotal = Object.values(intentCounts).reduce((a, b) => a + b, 0);
  const intentHtml = Object.entries(intentCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([intent, count]) => {
      const pct = intentTotal ? ((count / intentTotal) * 100).toFixed(0) : "0";
      return `<tr>
        <td><span class="badge">${esc(intent)}</span></td>
        <td>${count}</td>
        <td>${pct}%</td>
        <td><div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div></td>
      </tr>`;
    })
    .join("");

  const intentByProjHtml = Object.entries(intentByProject)
    .map(([proj, counts]) => {
      const list = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${esc(k)}: ${v}`)
        .join(" · ");
      return `<tr><td>${esc(proj)}</td><td>${list}</td></tr>`;
    })
    .join("");

  // ── Section 4: Cron details ─────────────────────────────────────────────
  const lastByTask = new Map<string, any>();
  for (const r of cronRows) {
    if (!lastByTask.has(r.task)) lastByTask.set(r.task, r);
  }
  const cronTasks = [
    { name: "followup",       schedule: "30 4 * * *",   label: "Daily 10:00 IST" },
    { name: "refresh-sites",  schedule: "30 22 * * 6",  label: "Sun 04:00 IST"   },
  ];
  const cronHtml = cronTasks
    .map((t) => {
      const last = lastByTask.get(t.name);
      const lastRan = last?.ran_at ? new Date(last.ran_at).toLocaleString("en-IN") : "never";
      const ago = last?.ran_at ? timeAgo(last.ran_at) : "—";
      const dur = last?.duration_ms ? `${(last.duration_ms / 1000).toFixed(1)}s` : "—";
      const status = last?.error
        ? `<span style="color:#c00">error</span>`
        : last?.ran_at
        ? `<span style="color:#080">ok</span>`
        : `<span style="color:#888">never run</span>`;
      const next = new Date(nextCronRun(t.schedule)).toLocaleString("en-IN");
      return `<tr>
        <td><code>${esc(t.name)}</code></td>
        <td>${esc(t.label)}</td>
        <td>${esc(lastRan)} <span style="color:#888">(${ago})</span></td>
        <td>${dur}</td>
        <td>${status}</td>
        <td>${esc(next)}</td>
      </tr>`;
    })
    .join("");

  // ── Section 5: Project documents ────────────────────────────────────────
  const docHtml = docRows
    .map((d: any) => `<tr>
      <td>${esc(d.project)}</td>
      <td><span class="badge">${esc(d.doc_type)}</span></td>
      <td>${esc(d.filename || "—")}</td>
      <td><a href="${esc(d.url)}" target="_blank" rel="noopener">open</a></td>
    </tr>`)
    .join("");

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<title>ASBL CRM Dashboard</title>
<style>
* { box-sizing: border-box; }
body { font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f7; color: #1d1d1f; margin: 0; padding: 24px; }
h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
.sub { color: #666; font-size: 13px; margin-bottom: 24px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } }
.card { background: white; border-radius: 12px; padding: 18px 20px; border: 1px solid #e5e5ea; }
.card h2 { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #666; margin: 0 0 12px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 500; color: #666; padding: 6px 8px; border-bottom: 1px solid #e5e5ea; }
td { padding: 8px; border-bottom: 1px solid #f0f0f3; vertical-align: top; }
tr:hover td { background: #fafbfc; }
code { background: #f0f0f3; padding: 2px 5px; border-radius: 4px; font-size: 12px; }
.badge { background: #007aff14; color: #007aff; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
.bar { width: 100%; height: 8px; background: #f0f0f3; border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; background: #007aff; }
.full { grid-column: span 2; }
@media (max-width: 1100px) { .full { grid-column: span 1; } }
.empty { color: #888; font-style: italic; padding: 12px 0; }
.proj-content { border: 1px solid #e5e5ea; border-radius: 8px; margin: 8px 0; padding: 0; }
.proj-content summary { cursor: pointer; padding: 12px 14px; font-size: 13px; user-select: none; }
.proj-content summary:hover { background: #fafbfc; }
.proj-content[open] summary { border-bottom: 1px solid #e5e5ea; background: #fafbfc; }
.proj-stats { padding: 10px 14px; background: #f9fafb; font-size: 12px; color: #444; border-bottom: 1px solid #e5e5ea; }
.proj-stats a { color: #007aff; text-decoration: none; }
.proj-stats a:hover { text-decoration: underline; }
.proj-text { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px; line-height: 1.45; padding: 14px; background: #fcfcfd; max-height: 480px; overflow: auto; margin: 0; white-space: pre-wrap; word-break: break-word; }
.proj-help { font-size: 12.5px; color: #555; margin-bottom: 12px; line-height: 1.5; padding: 10px 12px; background: #fafbfc; border-left: 3px solid #007aff; border-radius: 4px; }
.proj-help code { background: #e5e5ea; padding: 1px 6px; border-radius: 3px; font-size: 11.5px; }
</style>
</head><body>
<h1>ASBL CRM Dashboard</h1>
<div class="sub">Last refresh: ${new Date().toLocaleString("en-IN")} · Auto-refresh every 30s</div>

<div class="grid">

  <div class="card full">
    <h2>1. Crawled Data Summary (per project)</h2>
    ${siteRows.length ? `<table>
      <tr><th>Project</th><th>Pages</th><th>Size</th><th>Last fetched</th><th>Age</th><th>Status</th><th>Content</th></tr>
      ${siteHtml}
    </table>` : `<div class="empty">No crawl data yet.</div>`}
  </div>

  <div class="card full">
    <h2>1b. Stored Crawl Content (full structure per project)</h2>
    <div class="proj-help">
      Each project below shows what is actually stored in <code>site_cache.content_text</code>: meta tags
      (Title / Description / OG Title / Keywords) + nav labels + h1..h6 headings + paragraph text in
      document order. The LLM sees this exact text as <code>&lt;PROJECT_CONTEXT&gt;</code> on every reply.
    </div>
    ${contentSectionsHtml || `<div class="empty">No content cached yet.</div>`}
  </div>

  <div class="card full">
    <h2>2. Daily Chats — Last 24 Hours (${msgs24h.length} messages, ${phoneMap.size} unique users)</h2>
    ${chatHtml ? `<table>
      <tr><th>Phone</th><th>Project</th><th>Intent</th><th>Msgs</th><th>Last message</th><th>When</th></tr>
      ${chatHtml}
    </table>` : `<div class="empty">No chat activity in last 24 hours.</div>`}
  </div>

  <div class="card">
    <h2>3a. Intent Classification (24h)</h2>
    ${intentHtml ? `<table>
      <tr><th>Intent</th><th>Count</th><th>%</th><th>Distribution</th></tr>
      ${intentHtml}
    </table>` : `<div class="empty">No intents tagged yet.</div>`}
  </div>

  <div class="card">
    <h2>3b. Intent × Project (24h)</h2>
    ${intentByProjHtml ? `<table>
      <tr><th>Project</th><th>Intent breakdown</th></tr>
      ${intentByProjHtml}
    </table>` : `<div class="empty">No project-tagged intents yet.</div>`}
  </div>

  <div class="card full">
    <h2>4. Cron Schedule</h2>
    <table>
      <tr><th>Task</th><th>Schedule</th><th>Last run</th><th>Duration</th><th>Status</th><th>Next run</th></tr>
      ${cronHtml}
    </table>
  </div>

  <div class="card full">
    <h2>5. Project Documents (auto-discovered from crawl)</h2>
    ${docHtml ? `<table>
      <tr><th>Project</th><th>Type</th><th>Filename</th><th>Link</th></tr>
      ${docHtml}
    </table>` : `<div class="empty">No documents found yet. The crawler picks up PDFs on next refresh.</div>`}
  </div>

</div>
</body></html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Allow iframe embedding from Zoho
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Dashboard view (HTML) — separate from chat history retrieval
  if (req.method === "GET" && req.query.view === "dashboard") {
    try {
      const html = await renderDashboard();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(html);
    } catch (err: any) {
      return res.status(500).send(`<pre>Dashboard error: ${err.message}</pre>`);
    }
  }

  if (req.method === "GET") {
    const phone = req.query.phone as string;
    if (!phone) return res.status(400).json({ error: "phone required" });

    // source=supabase → fetch from Supabase whatsapp_messages table
    if (req.query.source === "supabase") {
      const rawPhone = phone.replace(/\D/g, "");
      if (rawPhone.length < 10) return res.status(400).json({ error: "invalid phone" });
      try {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/whatsapp_messages?phone=eq.${rawPhone}&order=created_at.asc&limit=200`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        if (!r.ok) throw new Error(`Supabase error ${r.status}: ${await r.text()}`);
        const messages = await r.json();
        return res.status(200).json({ phone: rawPhone, messages });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }

    // Default → fetch from Lazybot
    try {
      const url = `${LAZYBOT_URL}/api/v1/messages/by-phone?phone=${phone}&sessionId=${LAZYBOT_SESSION_ID}&limit=100`;
      const r = await fetch(url, { headers: { "X-API-Key": LAZYBOT_API_KEY } });
      const data = await r.json();
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    // Send a message via Lazybot
    const { phone, message } = req.body as { phone: string; message: string };
    if (!phone || !message) return res.status(400).json({ error: "phone and message required" });

    try {
      const r = await fetch(`${LAZYBOT_URL}/api/v1/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": LAZYBOT_API_KEY },
        body: JSON.stringify({ sessionId: LAZYBOT_SESSION_ID, phone, message }),
      });
      const data = await r.json();
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
