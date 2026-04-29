import type { VercelRequest, VercelResponse } from "@vercel/node";
import { listAllProjectFacts, getProjectFacts, saveProjectFacts, KNOWN_PROJECTS } from "./_utils/project_facts";

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

  const [factsRows, msgs24h, intentRows, cronRows, docRows] = await Promise.all([
    listAllProjectFacts(),
    sb(`whatsapp_messages?created_at=gte.${since24h}&select=phone,direction,message,project,intent,sender,created_at&order=created_at.desc&limit=300`),
    sb(`whatsapp_messages?created_at=gte.${since24h}&direction=eq.inbound&intent=not.is.null&select=intent,project`),
    sb(`cron_log?select=task,ran_at,duration_ms,result,error&order=ran_at.desc&limit=20`),
    sb(`project_documents?select=project,doc_type,filename,url,fetched_at&order=fetched_at.desc&limit=50`),
  ]);

  // Pad facts list with empty rows for any missing known project
  const factsByProject = new Map<string, { project: string; facts_text: string; updated_at: string | null }>();
  for (const f of factsRows) factsByProject.set(f.project, f);
  for (const p of KNOWN_PROJECTS) {
    if (!factsByProject.has(p)) {
      factsByProject.set(p, { project: p, facts_text: "", updated_at: null });
    }
  }
  const allFacts = Array.from(factsByProject.values()).sort((a, b) => a.project.localeCompare(b.project));

  // ── Section 1: KB Status (per project) ────────────────────────────────
  const kbStatusHtml = allFacts
    .map((r) => {
      const bytes = (r.facts_text || "").length;
      const lineCount = (r.facts_text || "").split("\n").filter((l) => l.trim()).length;
      const status = bytes > 100
        ? `<span style="color:#080">uploaded</span>`
        : `<span style="color:#c80">empty</span>`;
      return `<tr>
        <td><strong>${esc(r.project)}</strong></td>
        <td>${(bytes / 1024).toFixed(1)} KB</td>
        <td>${lineCount}</td>
        <td>${esc(r.updated_at ? new Date(r.updated_at).toLocaleString("en-IN") : "never")}</td>
        <td>${timeAgo(r.updated_at)}</td>
        <td>${status}</td>
        <td>
          <a href="#kb-${esc(r.project)}">view ↓</a>
          ·
          <a href="?view=edit-facts&project=${esc(r.project)}">edit ✎</a>
        </td>
      </tr>`;
    })
    .join("");

  // ── Section 1b: KB content viewer per project ─────────────────────────
  const kbContentHtml = allFacts
    .map((r) => {
      const content = r.facts_text || "";
      const updated = r.updated_at ? new Date(r.updated_at).toLocaleString("en-IN") : "never uploaded";
      const sizeKb = (content.length / 1024).toFixed(1);
      const lines = content.split("\n").filter((l) => l.trim()).length;
      return `<details id="kb-${esc(r.project)}" class="proj-content">
        <summary><strong>${esc(r.project)}</strong> — ${sizeKb} KB · ${lines} lines · last updated ${esc(updated)} · <a href="?view=edit-facts&project=${esc(r.project)}" style="color:#007aff">edit ✎</a></summary>
        <pre class="proj-text">${esc(content) || "(no KB uploaded — click 'edit ✎' to add one)"}</pre>
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
    { name: "followup", schedule: "30 4 * * *", label: "Daily 10:00 IST" },
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
    <h2>1. Knowledge Base Status (per project)</h2>
    <div class="proj-help">
      Each project's KB is the <strong>single source of truth</strong> the bot uses as
      <code>&lt;PROJECT_CONTEXT&gt;</code> on every reply. Click <strong>edit ✎</strong> to upload or update
      a project's KB (paste the full text). Larger / richer KB = more accurate, less hallucinated answers.
    </div>
    <table>
      <tr><th>Project</th><th>Size</th><th>Lines</th><th>Last updated</th><th>Age</th><th>Status</th><th>Actions</th></tr>
      ${kbStatusHtml}
    </table>
  </div>

  <div class="card full">
    <h2>1b. Knowledge Base Content (what the bot sees per project)</h2>
    ${kbContentHtml || `<div class="empty">No KBs yet.</div>`}
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

// ── Render edit-facts form ────────────────────────────────────────────────
async function renderEditForm(project: string, message: string = ""): Promise<string> {
  const facts = await getProjectFacts(project);
  const text = facts?.facts_text || "";
  const updated = facts?.updated_at ? new Date(facts.updated_at).toLocaleString("en-IN") : "never";

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Edit ${esc(project)} KB — ASBL CRM</title>
<style>
* { box-sizing: border-box; }
body { font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f7; color: #1d1d1f; margin: 0; padding: 24px; max-width: 1100px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
.sub { color: #666; font-size: 13px; margin-bottom: 20px; }
.card { background: white; border-radius: 12px; padding: 24px; border: 1px solid #e5e5ea; }
.help { font-size: 12.5px; color: #555; margin-bottom: 16px; line-height: 1.5; padding: 12px 14px; background: #fafbfc; border-left: 3px solid #007aff; border-radius: 4px; }
label { display: block; font-weight: 600; margin: 12px 0 6px; font-size: 13px; }
textarea { width: 100%; min-height: 600px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; line-height: 1.5; padding: 14px; border: 1px solid #d1d1d6; border-radius: 8px; resize: vertical; }
.actions { margin-top: 16px; display: flex; gap: 12px; align-items: center; }
button { background: #007aff; color: white; border: none; padding: 10px 22px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; }
button:hover { background: #0066d6; }
.btn-secondary { background: white; color: #1d1d1f; border: 1px solid #d1d1d6; }
.btn-secondary:hover { background: #f5f5f7; }
.flash { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
.flash-success { background: #34c75914; color: #1f6f3a; border: 1px solid #34c75940; }
.flash-error { background: #ff3b3014; color: #b71c1c; border: 1px solid #ff3b3040; }
a { color: #007aff; text-decoration: none; }
a:hover { text-decoration: underline; }
.meta { font-size: 12px; color: #888; margin-top: 8px; }
code { background: #f0f0f3; padding: 2px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head><body>
<h1>Edit Knowledge Base — ${esc(project)}</h1>
<div class="sub">
  <a href="?view=dashboard">← back to dashboard</a> · last updated: ${esc(updated)}
</div>

${message ? `<div class="flash ${message.startsWith("Saved") ? "flash-success" : "flash-error"}">${esc(message)}</div>` : ""}

<div class="card">
  <div class="help">
    Paste the full KB text for <strong>${esc(project)}</strong> below. This becomes the bot's <code>&lt;PROJECT_CONTEXT&gt;</code>
    on every reply for this project. Use clear sections (Project Overview, Location, Master Plan, Pricing, etc.) — the bot
    will ground all its answers in this text only. Plain text, markdown, bullet lists — all fine.
  </div>
  <form method="POST" action="?action=save-facts">
    <input type="hidden" name="project" value="${esc(project)}" />
    <label for="facts_text">Facts text (size: ${(text.length / 1024).toFixed(1)} KB)</label>
    <textarea id="facts_text" name="facts_text" placeholder="# PROJECT: ${esc(project)}

## Project Overview
- Name: ASBL ${esc(project)}
- Location: ...
- RERA Number: ...
- Configuration: ...
- Possession: ...

## Location & Connectivity
### Schools nearby
- ...

### Offices nearby
- ...

## Master Plan
...

## Pricing
- Box price 1695 sqft: ₹1.94 Cr + GST
- Box price 1870 sqft: ₹2.15 Cr + GST

## Other Charges
- ...

## Documents
- Brochure: <link>
- Price Sheet: <link>
- Specifications: <link>
">${esc(text)}</textarea>
    <div class="actions">
      <button type="submit">Save KB</button>
      <a href="?view=dashboard" class="btn-secondary" style="text-decoration:none;padding:10px 22px;border-radius:8px;border:1px solid #d1d1d6;color:#1d1d1f;background:white">Cancel</a>
      <span class="meta">Saving will overwrite the current KB for this project.</span>
    </div>
  </form>
</div>
</body></html>`;
}

// ── Parse application/x-www-form-urlencoded body ──────────────────────────
function parseFormBody(body: any): Record<string, string> {
  if (!body) return {};
  if (typeof body === "object" && !Array.isArray(body)) return body as any;
  if (typeof body === "string") {
    const out: Record<string, string> = {};
    for (const pair of body.split("&")) {
      const [k, v] = pair.split("=");
      if (!k) continue;
      out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent((v || "").replace(/\+/g, " "));
    }
    return out;
  }
  return {};
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

  // Edit KB form (HTML)
  if (req.method === "GET" && req.query.view === "edit-facts") {
    const project = String(req.query.project || "").toUpperCase();
    if (!KNOWN_PROJECTS.includes(project as any)) {
      return res.status(400).send(`<pre>Unknown project: ${esc(project)}. Valid: ${KNOWN_PROJECTS.join(", ")}</pre>`);
    }
    const flash = (req.query.msg as string) || "";
    const html = await renderEditForm(project, flash);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(html);
  }

  // Save KB action (POST form)
  if (req.method === "POST" && req.query.action === "save-facts") {
    const body = parseFormBody(req.body);
    const project = String(body.project || "").toUpperCase();
    const factsText = String(body.facts_text || "");
    if (!KNOWN_PROJECTS.includes(project as any)) {
      return res.status(400).send(`Unknown project: ${esc(project)}`);
    }
    const result = await saveProjectFacts(project, factsText);
    const msg = result.ok ? `Saved (${(factsText.length / 1024).toFixed(1)} KB).` : `Error: ${result.error}`;
    res.setHeader("Location", `?view=edit-facts&project=${encodeURIComponent(project)}&msg=${encodeURIComponent(msg)}`);
    return res.status(303).end();
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
