import type { VercelRequest, VercelResponse } from "@vercel/node";
import { listAllProjectFacts, getProjectFacts, saveProjectFacts, saveProjectKb, KNOWN_PROJECTS } from "./_utils/project_facts";
import { getAllInventoryRows, getInventoryForProject, refreshInventoryCache, INVENTORY_SHEET_URL, InventoryRow } from "./_utils/inventory_sheet";
import { uploadToStorage, extractTextFromPDF, decodeBase64Text, decodeBase64Buffer, createSignedUploadUrl, downloadFromStorage } from "./_utils/storage_upload";
import { callGemini, ANANDITA_SYSTEM_PROMPT } from "./_utils/gemini_chat";
import { getBotSetting, setBotSetting } from "./_utils/bot_settings";

// Bump body-parser limit for base64 PDF uploads (default is 1MB).
// 50MB binary PDF → ~67MB base64 JSON, so allow 70MB headroom.
export const config = {
  api: { bodyParser: { sizeLimit: "70mb" } },
};

const LAZYBOT_URL = process.env.LAZYBOT_URL || "https://lazybot-whatsapp-crm.onrender.com";
const LAZYBOT_API_KEY = process.env.LAZYBOT_API_KEY || "";
const LAZYBOT_SESSION_ID = process.env.LAZYBOT_SESSION_ID || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

// ── Shared modern stylesheet (used by every HTML view) ─────────────────────
const SHARED_STYLE = `
<style>
:root {
  --bg: #f7f8fa;
  --surface: #ffffff;
  --surface-hover: #fafbfc;
  --surface-muted: #f3f4f6;
  --border: #e5e7eb;
  --border-strong: #d1d5db;
  --text: #111827;
  --text-soft: #4b5563;
  --text-muted: #6b7280;
  --primary: #2563eb;
  --primary-hover: #1d4ed8;
  --primary-soft: #dbeafe;
  --success: #10b981;
  --warning: #f59e0b;
  --danger: #ef4444;
  --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.04);
  --shadow-md: 0 4px 12px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04);
  --radius: 12px;
  --radius-sm: 8px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  background: var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: var(--surface-muted); padding: 2px 6px; border-radius: 4px; font-size: 12.5px; font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }
.topbar {
  position: sticky; top: 0; z-index: 50;
  background: rgba(255,255,255,0.85); backdrop-filter: saturate(150%) blur(10px); -webkit-backdrop-filter: saturate(150%) blur(10px);
  border-bottom: 1px solid var(--border);
  padding: 14px 28px; display: flex; align-items: center; justify-content: space-between;
}
.topbar .brand a { color: var(--text); font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
.topbar nav { display: flex; gap: 18px; font-size: 13.5px; }
.topbar nav a { color: var(--text-soft); }
.topbar nav a:hover { color: var(--text); text-decoration: none; }
.topbar .meta { color: var(--text-muted); font-size: 12px; }
.container { max-width: 1400px; margin: 0 auto; padding: 28px; }
.page-narrow .container { max-width: 1000px; }
.page-title { font-size: 24px; font-weight: 700; letter-spacing: -0.015em; margin: 0 0 6px; }
.page-sub { color: var(--text-soft); font-size: 13.5px; margin: 0 0 24px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 22px 24px; box-shadow: var(--shadow-sm); transition: box-shadow .15s;
}
.card:hover { box-shadow: var(--shadow-md); }
.card h2 { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); margin: 0 0 16px; }
.card-help, .proj-help { font-size: 13px; color: var(--text-soft); margin-bottom: 18px; line-height: 1.6; padding: 12px 14px; background: var(--primary-soft); border-radius: var(--radius-sm); }
.card-help code, .proj-help code { background: rgba(37,99,235,0.12); color: var(--primary-hover); padding: 1px 6px; border-radius: 3px; font-size: 12px; }
.btn-mini { background: var(--primary); color: #fff; border: none; padding: 5px 12px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600; cursor: pointer; }
.btn-mini:hover { background: var(--primary-hover); }
.full { grid-column: span 2; } @media (max-width: 1100px) { .full { grid-column: span 1; } }
.empty { color: var(--text-muted); font-style: italic; padding: 16px 0; text-align: center; }
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
th { text-align: left; font-weight: 600; color: var(--text-muted); padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; }
td { padding: 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
tbody tr:hover td { background: var(--surface-hover); }
.badge { background: var(--primary-soft); color: var(--primary-hover); padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }
.badge-success { background: rgba(16,185,129,0.12); color: #059669; }
.badge-warn { background: rgba(245,158,11,0.15); color: #b45309; }
.badge-danger { background: rgba(239,68,68,0.12); color: #b91c1c; }
.bar { width: 100%; height: 6px; background: var(--surface-muted); border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; background: linear-gradient(90deg, var(--primary), #4f86ff); border-radius: 999px; }
.dot-ok { color: var(--success); }
.dot-warn { color: var(--warning); }
.dot-miss { color: var(--text-muted); }

/* Buttons */
.btn-primary, .btn-secondary, .btn-danger, button.btn-upload, button.btn-upload-replace, button.btn-upload-kb {
  font-family: inherit; font-size: 13px; font-weight: 600; border: 1px solid transparent; padding: 8px 16px;
  border-radius: var(--radius-sm); cursor: pointer; transition: all .12s ease;
}
.btn-primary { background: var(--primary); color: #fff; }
.btn-primary:hover { background: var(--primary-hover); transform: translateY(-1px); box-shadow: var(--shadow-md); }
.btn-secondary { background: var(--surface); color: var(--text); border-color: var(--border-strong); text-decoration: none; display: inline-block; }
.btn-secondary:hover { background: var(--surface-hover); }
.btn-danger { background: rgba(239,68,68,0.1); color: var(--danger); border-color: rgba(239,68,68,0.3); }
.btn-danger:hover { background: rgba(239,68,68,0.18); }

/* Doc Library cards */
.doc-library { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 18px; margin-top: 8px; }
.proj-card { border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; background: linear-gradient(180deg, #fff 0%, #fafbfc 100%); }
.proj-card h3 { margin: 0 0 14px; font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
.kb-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; margin-bottom: 14px; }
.doc-slots { display: grid; grid-template-columns: 1fr; gap: 8px; margin-bottom: 14px; }
.doc-slot { display: grid; grid-template-columns: 130px 1fr auto; align-items: center; gap: 10px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12.5px; }
.doc-slot.empty-slot { background: rgba(245,158,11,0.05); border-color: rgba(245,158,11,0.25); }
.doc-slot-label { font-weight: 600; color: var(--text); }
.doc-slot-file { color: var(--text-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
.doc-slot-file em { color: var(--text-muted); font-style: normal; }
.ok { color: var(--success); font-size: 14px; }
.missing { color: var(--warning); font-size: 14px; }
.btn-upload, .btn-upload-kb { background: var(--primary); color: #fff; padding: 6px 12px; font-size: 12px; }
.btn-upload:hover, .btn-upload-kb:hover { background: var(--primary-hover); }
.btn-upload-replace { background: var(--surface-muted); color: var(--primary); padding: 6px 12px; font-size: 12px; border: 1px solid var(--border); }
.btn-upload-replace:hover { background: var(--border); }
.btn-delete { background: transparent; color: var(--danger); border: none; cursor: pointer; font-size: 16px; padding: 0 6px; line-height: 1; font-weight: 700; }
.btn-delete:hover { color: #b91c1c; }
.unit-plans { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; }
.unit-table { width: 100%; font-size: 12.5px; margin: 10px 0; }
.unit-table th, .unit-table td { padding: 6px 8px; }
.add-unit-row { display: flex; gap: 8px; margin-top: 10px; }
.size-input { flex: 1; padding: 7px 11px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); font-size: 12.5px; font-family: inherit; background: var(--surface); }
.size-input:focus { outline: 0; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37,99,235,0.15); }
.empty-inline { color: var(--text-muted); font-size: 12.5px; font-style: italic; padding: 4px 0; }

/* Project facts (offer details viewer) */
.proj-content { border: 1px solid var(--border); border-radius: var(--radius-sm); margin: 10px 0; padding: 0; background: var(--surface); }
.proj-content summary { cursor: pointer; padding: 13px 16px; font-size: 13.5px; user-select: none; }
.proj-content summary:hover { background: var(--surface-hover); }
.proj-content[open] summary { border-bottom: 1px solid var(--border); background: var(--surface-hover); }
.proj-text { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; line-height: 1.55; padding: 16px; background: #fcfcfd; max-height: 480px; overflow: auto; margin: 0; white-space: pre-wrap; word-break: break-word; }

/* Edit form views */
.field-label { display: block; font-weight: 600; margin: 14px 0 8px; font-size: 13px; color: var(--text); }
textarea {
  width: 100%; min-height: 540px; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12.5px; line-height: 1.55;
  padding: 14px 16px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); resize: vertical;
  background: var(--surface); color: var(--text);
}
textarea:focus { outline: 0; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37,99,235,0.15); }
.prompt-textarea { min-height: 720px; }
.actions { margin-top: 18px; display: flex; gap: 12px; align-items: center; }
.flash { padding: 12px 16px; border-radius: var(--radius-sm); margin-bottom: 18px; font-size: 13.5px; font-weight: 500; }
.flash-success { background: rgba(16,185,129,0.1); color: #047857; border: 1px solid rgba(16,185,129,0.25); }
.flash-error { background: rgba(239,68,68,0.08); color: #b91c1c; border: 1px solid rgba(239,68,68,0.25); }

/* Misc */
.muted { color: var(--text-muted); font-size: 12px; }
.text-mono { font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
</style>
`;

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

  const [factsRows, msgs24h, intentRows, cronRows, docRows, inventory] = await Promise.all([
    listAllProjectFacts(),
    sb(`whatsapp_messages?created_at=gte.${since24h}&select=phone,direction,message,project,intent,sender,created_at&order=created_at.desc&limit=300`),
    sb(`whatsapp_messages?created_at=gte.${since24h}&direction=eq.inbound&intent=not.is.null&select=intent,project`),
    sb(`cron_log?select=task,ran_at,duration_ms,result,error&order=ran_at.desc&limit=20`),
    sb(`project_documents?select=id,project,doc_type,size_label,unit_size_sft,facing,tower,filename,url,fetched_at&order=fetched_at.desc&limit=200`),
    getAllInventoryRows().catch((err: any) => {
      console.error("[Dashboard] Inventory fetch failed:", err.message);
      return { rows: [], fetchedAt: 0 };
    }),
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

  // ── Section 1: Project Offer Details (per project) ────────────────────
  const offerStatusHtml = allFacts
    .map((r) => {
      const bytes = (r.facts_text || "").length;
      const lineCount = (r.facts_text || "").split("\n").filter((l) => l.trim()).length;
      const status = bytes > 100
        ? `<span style="color:#080">written</span>`
        : `<span style="color:#c80">empty</span>`;
      return `<tr>
        <td><strong>${esc(r.project)}</strong></td>
        <td>${(bytes / 1024).toFixed(1)} KB</td>
        <td>${lineCount}</td>
        <td>${esc(r.updated_at ? new Date(r.updated_at).toLocaleString("en-IN") : "never")}</td>
        <td>${timeAgo(r.updated_at)}</td>
        <td>${status}</td>
        <td>
          <a href="#offer-${esc(r.project)}">view ↓</a>
          ·
          <a href="?view=edit-facts&project=${esc(r.project)}">edit ✎</a>
        </td>
      </tr>`;
    })
    .join("");

  // ── Section 1b: Offer details viewer per project ──────────────────────
  const offerContentHtml = allFacts
    .map((r) => {
      const content = r.facts_text || "";
      const updated = r.updated_at ? new Date(r.updated_at).toLocaleString("en-IN") : "never written";
      const sizeKb = (content.length / 1024).toFixed(1);
      const lines = content.split("\n").filter((l) => l.trim()).length;
      return `<details id="offer-${esc(r.project)}" class="proj-content">
        <summary><strong>${esc(r.project)}</strong> — ${sizeKb} KB · ${lines} lines · last updated ${esc(updated)} · <a href="?view=edit-facts&project=${esc(r.project)}" style="color:#007aff">edit ✎</a></summary>
        <pre class="proj-text">${esc(content) || "(no offer details written — click 'edit ✎' to add)"}</pre>
      </details>`;
    })
    .join("");

  // ── Section 1c: Live Inventory + Pricing (from Google Sheet) ──────────
  const invByProject: Record<string, InventoryRow[]> = {};
  for (const row of inventory.rows) {
    if (!invByProject[row.project]) invByProject[row.project] = [];
    invByProject[row.project].push(row);
  }
  const invFetchedAt = inventory.fetchedAt ? new Date(inventory.fetchedAt).toLocaleString("en-IN") : "never";
  const invFetchedAgo = inventory.fetchedAt ? timeAgo(new Date(inventory.fetchedAt).toISOString()) : "—";

  const inventoryStatusHtml = KNOWN_PROJECTS.map((p) => {
    const rows = invByProject[p] || [];
    if (p === "LEGACY") return ""; // LEGACY not in sheet
    const available = rows.filter((r) => /^available/i.test(r.availability)).length;
    const limited = rows.filter((r) => /not selling/i.test(r.availability)).length;
    const sold = rows.filter((r) => /sold\s*out/i.test(r.availability)).length;
    return `<tr>
      <td><strong>${esc(p)}</strong></td>
      <td>${rows.length}</td>
      <td><span style="color:#080">${available}</span></td>
      <td><span style="color:#c80">${limited}</span></td>
      <td><span style="color:#888">${sold}</span></td>
      <td><a href="#inv-${esc(p)}">view ↓</a></td>
    </tr>`;
  }).filter(Boolean).join("");

  const inventoryDetailHtml = KNOWN_PROJECTS.filter((p) => p !== "LEGACY")
    .map((p) => {
      const rows = invByProject[p] || [];
      if (rows.length === 0) {
        return `<details id="inv-${esc(p)}" class="proj-content">
          <summary><strong>${esc(p)}</strong> — no rows in sheet</summary>
        </details>`;
      }
      const tbody = rows
        .map((r) => {
          const availColor = /^available/i.test(r.availability) ? "#080"
            : /sold/i.test(r.availability) ? "#888" : "#c80";
          return `<tr>
            <td>${esc(r.tower)}</td>
            <td>${esc(r.sizeSft)}</td>
            <td>${esc(r.bhk)}</td>
            <td>${esc(r.facing)}</td>
            <td style="color:${availColor}">${esc(r.availability)}</td>
            <td>${esc(r.pricePerSft)}</td>
            <td>${esc(r.allInclusive)}</td>
            <td>${esc(r.offer)}</td>
          </tr>`;
        })
        .join("");
      return `<details id="inv-${esc(p)}" class="proj-content">
        <summary><strong>${esc(p)}</strong> — ${rows.length} units</summary>
        <table style="margin-top:8px"><tr><th>Tower</th><th>SFT</th><th>BHK</th><th>Facing</th><th>Availability</th><th>₹/sft</th><th>All-inclusive</th><th>Offer</th></tr>${tbody}</table>
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

  // ── Section 5: Project Document Library (per-project upload UI) ────────
  // Group docs by project & doc_type so we can render upload slots / lists.
  const docsByProj: Record<string, Record<string, any[]>> = {};
  for (const d of docRows as any[]) {
    if (!docsByProj[d.project]) docsByProj[d.project] = {};
    const t = d.doc_type;
    if (!docsByProj[d.project][t]) docsByProj[d.project][t] = [];
    docsByProj[d.project][t].push(d);
  }

  const SINGLE_SLOTS: Array<{ key: string; label: string }> = [
    { key: "master_plan", label: "Master Plan" },
    { key: "payment_structure", label: "Payment Structure" },
    { key: "brochure", label: "Brochure" },
    { key: "specifications", label: "Specifications" },
    { key: "amenities", label: "Amenities" },
  ];

  // Multi-PDF slots — one row per label (e.g. tower / unit size / configuration).
  // The bot fuzzy-matches by label when a customer asks for a specific one.
  // Price Sheet upgraded to multi-slot so projects can have per-config /
  // per-tower price sheets (e.g. "Tower A 3BHK", "Tower B 2BHK") instead of
  // forcing one giant price sheet for the whole project.
  const MULTI_SLOTS: Array<{ key: string; title: string; placeholder: string }> = [
    { key: "floor_plan",  title: "Floor Plans",  placeholder: "tower label e.g. Tower A" },
    { key: "unit_plan",   title: "Unit Plans",   placeholder: "size label e.g. 1695 East" },
    { key: "price_sheet", title: "Price Sheets", placeholder: "config/tower e.g. Tower A 3BHK" },
  ];

  const renderDocSlot = (project: string, docKey: string, label: string) => {
    const existing = (docsByProj[project]?.[docKey] || []).slice(0, 1)[0];
    if (existing) {
      return `<div class="doc-slot filled">
        <div class="doc-slot-label">${esc(label)} <span class="ok">●</span></div>
        <div class="doc-slot-file">
          <a href="${esc(existing.url)}" target="_blank" rel="noopener">${esc(existing.filename || "open")}</a>
          <form method="POST" action="?action=delete-doc&id=${esc(existing.id)}" style="display:inline" onsubmit="return confirm('Delete ${esc(label)} for ${esc(project)}?')">
            <button type="submit" class="btn-delete">×</button>
          </form>
        </div>
        <button type="button" class="btn-upload-replace" onclick="pickFile('${esc(project)}', '${esc(docKey)}', null, '${esc(label)}')">Replace</button>
      </div>`;
    }
    return `<div class="doc-slot empty-slot">
      <div class="doc-slot-label">${esc(label)} <span class="missing">○</span></div>
      <div class="doc-slot-file"><em>not uploaded</em></div>
      <button type="button" class="btn-upload" onclick="pickFile('${esc(project)}', '${esc(docKey)}', null, '${esc(label)}')">Upload PDF</button>
    </div>`;
  };

  const renderMultiSlot = (project: string, docType: string, title: string, placeholder: string) => {
    const items = docsByProj[project]?.[docType] || [];
    const labelHeader =
      docType === "floor_plan"  ? "Tower" :
      docType === "price_sheet" ? "Config" :
      "Size";
    // Render the strict columns alongside the legacy size_label so the
    // operator can see at a glance whether a row will be findable via the
    // v5 strict lookup. A "—" in any strict column means the bot won't
    // match it; the row needs editing or backfill.
    const list = items.map((p) => {
      const strictParts: string[] = [];
      if (p.unit_size_sft) strictParts.push(`${p.unit_size_sft} sft`);
      if (p.facing) strictParts.push(String(p.facing));
      if (p.tower) strictParts.push(`Tower ${p.tower}`);
      const strictTag = strictParts.length
        ? `<span style="color:#1a7f37">${esc(strictParts.join(" · "))}</span>`
        : `<span style="color:#a00">— missing —</span>`;
      return `<tr>
        <td>${esc(p.size_label || "—")}</td>
        <td>${strictTag}</td>
        <td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.filename || "open")}</a></td>
        <td>
          <form method="POST" action="?action=delete-doc&id=${esc(p.id)}" style="display:inline" onsubmit="return confirm('Delete ${esc(title)} ${esc(p.size_label || '')} for ${esc(project)}?')">
            <button type="submit" class="btn-delete">delete</button>
          </form>
        </td>
      </tr>`;
    }).join("");

    // v5 strict inputs — these are what the bot's doc_meta matches against.
    // For unit_plan: all three matter. For floor_plan: usually just tower
    // (and optionally size + facing if you keep per-unit floor plans). For
    // price_sheet: config is freeform so the strict columns are optional.
    const wantsSize   = docType === "unit_plan";
    const wantsFacing = docType === "unit_plan";
    const wantsTower  = docType === "unit_plan" || docType === "floor_plan";

    const facingOptions = [
      "", "east", "west", "north", "south",
      "north_east", "north_west", "south_east", "south_west",
    ].map((v) => `<option value="${esc(v)}">${v ? esc(v) : "— facing —"}</option>`).join("");

    return `<div class="unit-plans">
      <div class="doc-slot-label">${esc(title)} <span class="${items.length ? "ok" : "missing"}">${items.length ? "●" : "○"}</span> <span style="color:#888;font-weight:normal">(${items.length})</span></div>
      ${items.length ? `<table class="unit-table">
        <tr><th>${esc(labelHeader)} label (legacy)</th><th>Strict lookup keys</th><th>File</th><th></th></tr>
        ${list}
      </table>` : `<div class="empty-inline">no ${esc(title.toLowerCase())} uploaded yet</div>`}
      <div class="add-unit-row" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px">
        <input type="text" id="multi-${esc(project)}-${esc(docType)}" placeholder="${esc(placeholder)}" class="size-input" style="min-width:180px" />
        ${wantsSize ? `<input type="number" id="multi-${esc(project)}-${esc(docType)}-size" placeholder="size sft (e.g. 1695)" min="100" max="100000" class="size-input" style="width:160px" />` : ""}
        ${wantsFacing ? `<select id="multi-${esc(project)}-${esc(docType)}-facing" class="size-input" style="width:140px">${facingOptions}</select>` : ""}
        ${wantsTower ? `<input type="text" id="multi-${esc(project)}-${esc(docType)}-tower" placeholder="tower (e.g. A)" class="size-input" style="width:100px" />` : ""}
        <button type="button" class="btn-upload" onclick="pickMulti('${esc(project)}', '${esc(docType)}', '${esc(title)}')">+ Add ${esc(title.toLowerCase().slice(0, -1))} PDF</button>
      </div>
      ${(wantsSize || wantsFacing || wantsTower) ? `<div class="proj-help" style="font-size:11px;margin-top:4px">Strict fields are what the v5 bot matches on. The legacy label is kept for the storage filename.</div>` : ""}
    </div>`;
  };

  const renderProjectKbCard = (project: string) => {
    const facts = factsByProject.get(project);
    // KB content is stored in kb_text (separate from facts_text which holds offer details)
    const kbText = (facts as any)?.kb_text || "";
    const kbUpdated = (facts as any)?.kb_updated_at;
    const hasContent = kbText.length > 100;
    const updated = kbUpdated ? timeAgo(kbUpdated) : "never";
    const sizeKb = (kbText.length / 1024).toFixed(1);
    return `<div class="kb-row">
      <span><strong>KB:</strong> ${hasContent ? `<span class="ok">●</span> ${sizeKb} KB · updated ${esc(updated)}` : `<span class="missing">○</span> empty`}</span>
      <button type="button" class="btn-upload-kb" onclick="pickKb('${esc(project)}')">Upload KB (TXT/PDF)</button>
    </div>`;
  };

  // PDF-extracts fallback toggle (default ON if no setting present)
  let pdfExtractsToggleEnabled = true;
  try {
    const row = await getBotSetting("use_pdf_extracts");
    if (row?.value === "false") pdfExtractsToggleEnabled = false;
  } catch {}

  const docLibraryHtml = KNOWN_PROJECTS.filter((p) => p !== "LEGACY")
    .map((p) => `<div class="proj-card">
      <h3>${esc(p)}</h3>
      ${renderProjectKbCard(p)}
      <div class="doc-slots">
        ${SINGLE_SLOTS.map((s) => renderDocSlot(p, s.key, s.label)).join("")}
      </div>
      ${MULTI_SLOTS.map((m) => renderMultiSlot(p, m.key, m.title, m.placeholder)).join("")}
    </div>`)
    .join("");

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>ASBL CRM Dashboard</title>
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
${SHARED_STYLE}
</head><body>
<header class="topbar">
  <div class="brand"><a href="?view=dashboard">ASBL CRM</a></div>
  <nav>
    <a href="?view=dashboard">Dashboard</a>
    <a href="?view=edit-prompt">Bot Prompt</a>
  </nav>
  <div class="meta">Loaded: ${new Date().toLocaleString("en-IN")} · <a href="javascript:location.reload()" style="color:var(--primary)">↻ refresh</a></div>
</header>
<main class="container">
  <h1 class="page-title">Operations Dashboard</h1>
  <p class="page-sub">Live view of project KB, offers, inventory, document library, conversations and bot configuration.</p>

  <div class="grid">

  <div class="card full">
    <h2>1. Project Offer Details (per project)</h2>
    <div class="proj-help">
      This section is only for <strong>offer explanations</strong> — pricing offers, rental schemes,
      pre-EMI offers, limited-time deals — anything the bot should explain when a customer asks
      about offers for a project. Click <strong>edit ✎</strong> to write or update.
      <br><strong>Note:</strong> Offer text is stored separately from the project KB
      (Section 5 → KB upload). Uploading a new KB does <em>not</em> overwrite these offer details.
    </div>
    <table>
      <tr><th>Project</th><th>Size</th><th>Lines</th><th>Last updated</th><th>Age</th><th>Status</th><th>Actions</th></tr>
      ${offerStatusHtml}
    </table>
  </div>

  <div class="card full">
    <h2>1b. Offer Details Content (what the bot sees per project)</h2>
    ${offerContentHtml || `<div class="empty">No offer details yet.</div>`}
  </div>

  <div class="card full">
    <h2>1c. Live Inventory &amp; Pricing (from <a href="${esc(INVENTORY_SHEET_URL)}" target="_blank" rel="noopener">master sheet</a>)</h2>
    <div class="proj-help">
      Edit the <a href="${esc(INVENTORY_SHEET_URL)}" target="_blank" rel="noopener">master Google Sheet</a> —
      changes propagate to the bot within ~5 minutes (or instantly if you hit the refresh button below).
      The bot uses this as the source of truth for unit availability, per-sft rates, all-inclusive prices,
      and active offers.
      <form method="POST" action="?action=refresh-inventory" style="display:inline-block;margin-left:12px">
        <button type="submit" class="btn-mini">↻ Refresh now</button>
      </form>
      Last fetched: <strong>${esc(invFetchedAt)}</strong> (${esc(invFetchedAgo)}) · ${inventory.rows.length} units in sheet.
    </div>
    ${inventoryStatusHtml ? `<table>
      <tr><th>Project</th><th>Total units</th><th>Available</th><th>Limited</th><th>Sold out</th><th>Detail</th></tr>
      ${inventoryStatusHtml}
    </table>` : `<div class="empty">No inventory rows fetched.</div>`}
    <div style="margin-top:16px">${inventoryDetailHtml}</div>
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
    <h2>5. Project Document Library (KB + PDFs the bot sends on WhatsApp)</h2>
    <div class="card-help">
      <strong>KB</strong> — TXT or PDF. Text is auto-extracted and fed into the bot's Gemini prompt as <code>PROJECT_CONTEXT</code>. Replace anytime; latest upload wins.<br>
      <strong>Master Plan / Floor Plan / Price Sheet / Payment Structure / Brochure / Specifications / Amenities</strong> — single PDF per project. The bot sends this file directly via Periskope when a customer asks.<br>
      <strong>Unit Plans</strong> — multiple PDFs, one per inventory size (e.g. <code>1695 East</code>). Bot matches by size label.<br>
      Files upload <strong>directly to Supabase Storage</strong> via signed URL — large PDFs (up to 50 MB) work without hitting Vercel's 4.5 MB request limit.
    </div>
    <div class="doc-library">
      ${docLibraryHtml}
    </div>
  </div>

  <div class="card full">
    <h2>6. Bot System Prompt</h2>
    <div class="card-help">
      The Gemini system prompt defines the bot's persona, banned phrases, intent labels and JSON output format. Edit it on the dedicated page — saves are <strong>live</strong> (the bot picks up the new prompt on the next message; no redeploy needed).
    </div>
    <a href="?view=edit-prompt" class="btn-primary" style="display:inline-block;text-decoration:none">Open prompt editor →</a>
  </div>

  <div class="card full">
    <h2>7. PDF Extracts as Fallback KB</h2>
    <div class="card-help">
      When ON, every uploaded PDF (brochure, specs, master plan, etc.) gets text-extracted on upload and added to the bot's context as a fallback source. If a customer asks something the curated KB doesn't cover, the bot scans the PDFs for an answer before deferring. Cap: 3.5 KB per PDF in context.
      <br><br>
      ${pdfExtractsToggleEnabled ? `Status: <strong style="color:var(--success)">ON</strong>` : `Status: <strong style="color:var(--text-muted)">OFF</strong>`} ·
      <form method="POST" action="?action=set-pdf-extracts&value=${pdfExtractsToggleEnabled ? "off" : "on"}" style="display:inline">
        <button type="submit" class="btn-mini">Turn ${pdfExtractsToggleEnabled ? "OFF" : "ON"}</button>
      </form>
    </div>
    <div style="font-size:13px;color:var(--text-soft);line-height:1.5">
      <strong>Backfill existing PDFs</strong> — if you uploaded PDFs before this feature existed, they don't have text extracts yet. Run the backfill once to extract all of them:
      <pre style="background:var(--surface-muted);padding:10px;border-radius:6px;font-size:12px;overflow:auto;margin-top:8px">curl -X POST "https://asbl-crm-api.vercel.app/api/chat-history?action=backfill-pdf-extracts&secret=&lt;INHOUSE_POSTHOOK_SECRET&gt;"

# v5 strict-meta backfill — parses existing size_label to fill unit_size_sft/facing/tower
# Preview (no writes): &dry=1   |   Filter: &doc_type=unit_plan  &project=LOFT
curl "https://asbl-crm-api.vercel.app/api/chat-history?action=backfill-doc-meta&secret=&lt;INHOUSE_POSTHOOK_SECRET&gt;&dry=1"</pre>
    </div>
  </div>

  </div>
</main>

<!-- Hidden file input reused by all upload buttons -->
<input type="file" id="hidden-file-input" accept=".pdf,.txt,application/pdf,text/plain" style="display:none" />

<script>
// ── Upload flow: signed-URL direct to Supabase, then finalize metadata ──
const _fileInput = document.getElementById('hidden-file-input');
let _ctx = null;

function pickKb(project) {
  _ctx = { kind: 'kb', project, label: 'KB' };
  _fileInput.accept = '.pdf,.txt,application/pdf,text/plain';
  _fileInput.value = '';
  _fileInput.click();
}
function pickFile(project, docType, sizeLabel, label) {
  _ctx = { kind: 'doc', project, docType, sizeLabel, label };
  _fileInput.accept = '.pdf,application/pdf';
  _fileInput.value = '';
  _fileInput.click();
}
function pickMulti(project, docType, title) {
  const input = document.getElementById('multi-' + project + '-' + docType);
  const sizeLabel = (input?.value || '').trim();
  // v5 strict fields (optional; null if the input doesn't exist for this doc_type)
  const sizeEl = document.getElementById('multi-' + project + '-' + docType + '-size');
  const facingEl = document.getElementById('multi-' + project + '-' + docType + '-facing');
  const towerEl = document.getElementById('multi-' + project + '-' + docType + '-tower');
  const unitSizeSft = sizeEl ? parseInt(sizeEl.value, 10) : NaN;
  const facing = facingEl ? facingEl.value.trim() : '';
  const tower = towerEl ? towerEl.value.trim() : '';

  // unit_plan REQUIRES the strict fields so the bot can match doc_meta exactly.
  if (docType === 'unit_plan') {
    if (!isFinite(unitSizeSft) || unitSizeSft < 100) {
      alert('Unit Plan: enter "size sft" (integer, e.g. 1695)');
      sizeEl?.focus();
      return;
    }
    if (!facing) {
      alert('Unit Plan: pick a facing (east, west, etc.)');
      facingEl?.focus();
      return;
    }
  }
  if (!sizeLabel) {
    alert('Enter a label first (e.g. "Tower A" for floor plans, "1695 East" for unit plans)');
    input?.focus();
    return;
  }

  _ctx = {
    kind: 'multi', project, docType, sizeLabel,
    label: title + ' ' + sizeLabel,
    unit_size_sft: isFinite(unitSizeSft) ? unitSizeSft : null,
    facing: facing || null,
    tower: tower || null,
  };
  _fileInput.accept = '.pdf,application/pdf';
  _fileInput.value = '';
  _fileInput.click();
}

async function uploadFile(ctx, file, btn) {
  if (file.size > 50 * 1024 * 1024) { alert('File too large (max 50 MB)'); return; }
  const oldText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Signing…'; }

  const isKb = ctx.kind === 'kb';
  const mimetype = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/plain');

  try {
    // 1. Get signed upload URL from our backend
    const signReq = { project: ctx.project, filename: file.name, is_kb: isKb };
    if (!isKb) {
      signReq.doc_type = ctx.docType;
      if (ctx.sizeLabel) signReq.size_label = ctx.sizeLabel;
      if (ctx.unit_size_sft !== undefined) signReq.unit_size_sft = ctx.unit_size_sft;
      if (ctx.facing !== undefined) signReq.facing = ctx.facing;
      if (ctx.tower !== undefined) signReq.tower = ctx.tower;
    }
    const signRes = await fetch('?action=upload-sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signReq),
    });
    const sign = await signRes.json();
    if (!signRes.ok || !sign.ok) throw new Error(sign.error || 'sign failed');

    // 2. PUT file directly to Supabase storage (bypasses Vercel body limit)
    if (btn) btn.textContent = 'Uploading…';
    const putRes = await fetch(sign.uploadPath, {
      method: 'PUT',
      headers: { 'Content-Type': mimetype, 'x-upsert': 'true' },
      body: file,
    });
    if (!putRes.ok) {
      const errText = await putRes.text().catch(() => '');
      throw new Error('Storage upload ' + putRes.status + ': ' + errText.slice(0, 200));
    }

    // 3. Finalize — record metadata + (for KB) extract text
    if (btn) btn.textContent = isKb ? 'Extracting…' : 'Saving…';
    const finReq = {
      project: ctx.project, filename: file.name, mimetype,
      storage_path: sign.storagePath, public_url: sign.publicUrl, is_kb: isKb,
    };
    if (!isKb) {
      finReq.doc_type = ctx.docType;
      if (ctx.sizeLabel) finReq.size_label = ctx.sizeLabel;
      if (ctx.unit_size_sft !== undefined) finReq.unit_size_sft = ctx.unit_size_sft;
      if (ctx.facing !== undefined) finReq.facing = ctx.facing;
      if (ctx.tower !== undefined) finReq.tower = ctx.tower;
    }
    const finRes = await fetch('?action=upload-finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finReq),
    });
    const fin = await finRes.json();
    if (!finRes.ok || !fin.ok) throw new Error(fin.error || 'finalize failed');

    if (isKb) alert('KB uploaded: ' + fin.extractedChars + ' chars extracted for ' + ctx.project);
    else alert(ctx.label + ' uploaded for ' + ctx.project);
    location.reload();
  } catch (err) {
    alert('Upload error: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}

_fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !_ctx) return;
  const ctx = _ctx; _ctx = null;
  const btn = document.activeElement?.tagName === 'BUTTON' ? document.activeElement : null;
  await uploadFile(ctx, file, btn);
});
</script>
</body></html>`;
}

// ── Render edit-offer-details form ────────────────────────────────────────
async function renderEditForm(project: string, message: string = ""): Promise<string> {
  const facts = await getProjectFacts(project);
  const text = facts?.facts_text || "";
  const updated = facts?.updated_at ? new Date(facts.updated_at).toLocaleString("en-IN") : "never";

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Edit ${esc(project)} Offer Details — ASBL CRM</title>
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
${SHARED_STYLE}
</head><body class="page-narrow">
<header class="topbar">
  <div class="brand"><a href="?view=dashboard">ASBL CRM</a></div>
  <nav><a href="?view=dashboard">← Dashboard</a></nav>
</header>
<main class="container">
  <h1 class="page-title">Edit Offer Details — ${esc(project)}</h1>
  <p class="page-sub">Last updated: ${esc(updated)}</p>

  ${message ? `<div class="flash ${message.startsWith("Saved") ? "flash-success" : "flash-error"}">${esc(message)}</div>` : ""}

  <div class="card">
    <div class="card-help">
      Write the <strong>offer explanation</strong> for ${esc(project)} below — rental schemes, pre-EMI offers, limited-time deals. Stored in <code>project_facts.facts_text</code>, separate from the KB upload (Section 5). Uploading a new KB will <em>not</em> overwrite this.
    </div>
    <form method="POST" action="?action=save-facts">
      <input type="hidden" name="project" value="${esc(project)}" />
      <label class="field-label">Offer details (current size: ${(text.length / 1024).toFixed(1)} KB)</label>
      <textarea name="facts_text" placeholder="# ${esc(project)} — OFFERS

## Active Offer
- Name: <e.g. Rental Offer>
- What it is: <plain-language explainer the bot can read out>
- Eligibility: <who qualifies>
- Booking amount: <e.g. Rs. 10L>
- Returns / discount: <e.g. Rs. 50/sqft/month till Dec 2026>
- Validity: <until when>
- Key terms: <any caveats>

## Past Offers (for reference)
- 25:75 offer — discontinued from 11 February 2026
- ...

## Notes for the bot
- If asked about the rental offer, explain in 2-3 lines and offer to share the calculation for their unit size.
- Always confirm exact terms over a call with the executive.
">${esc(text)}</textarea>
      <div class="actions">
        <button type="submit" class="btn-primary">Save offer details</button>
        <a href="?view=dashboard" class="btn-secondary">Cancel</a>
        <span class="muted" style="margin-left:auto">Saving overwrites the current offer text for this project.</span>
      </div>
    </form>
  </div>
</main>
</body></html>`;
}

// ── Render edit-bot-prompt page ────────────────────────────────────────────
async function renderEditPrompt(message: string = ""): Promise<string> {
  const row = await getBotSetting("system_prompt");
  const isOverride = !!(row?.value && row.value.trim().length > 200);
  const text = isOverride ? row!.value : ANANDITA_SYSTEM_PROMPT;
  const updated = row?.updated_at ? new Date(row.updated_at).toLocaleString("en-IN") : "—";

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Edit Bot Prompt — ASBL CRM</title>
${SHARED_STYLE}
</head><body class="page-narrow">
<header class="topbar">
  <div class="brand"><a href="?view=dashboard">ASBL CRM</a></div>
  <nav><a href="?view=dashboard">← Dashboard</a></nav>
</header>
<main class="container">
  <h1 class="page-title">Bot System Prompt</h1>
  <p class="page-sub">This is the live Gemini 3 Pro instruction set. Saving here updates the bot <strong>instantly</strong> — no redeploy. Active source: <strong>${isOverride ? "DB override" : "hardcoded default"}</strong>${isOverride ? ` · last edited ${esc(updated)}` : ""}.</p>

  ${message ? `<div class="flash ${message.startsWith("Saved") ? "flash-success" : "flash-error"}">${esc(message)}</div>` : ""}

  <div class="card">
    <div class="card-help">
      <strong>What goes here:</strong> Persona, banned phrases, intent labels, JSON output format. The relay layer wraps every customer message with <code>&lt;CUSTOMER&gt;</code>, <code>&lt;PROJECT_CONTEXT&gt;</code>, <code>&lt;CONVERSATION_HISTORY&gt;</code>, <code>&lt;USER_MESSAGE&gt;</code> blocks before sending to the bot. The bot must output strict JSON: <code>{"intent","flags","project","doc_to_send","reply"}</code>.
    </div>
    <form method="POST" action="?action=save-prompt">
      <label class="field-label">System prompt (current size: ${(text.length / 1024).toFixed(1)} KB)</label>
      <textarea name="prompt" class="prompt-textarea" spellcheck="false">${esc(text)}</textarea>
      <div class="actions">
        <button type="submit" class="btn-primary">Save prompt</button>
        <a href="?view=dashboard" class="btn-secondary">Cancel</a>
        ${isOverride ? `<form method="POST" action="?action=reset-prompt" style="display:inline;margin-left:auto" onsubmit="return confirm('Discard your override and revert to the hardcoded default?')"><button type="submit" class="btn-danger">Reset to default</button></form>` : ""}
      </div>
    </form>
  </div>
</main>
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

  // Edit bot prompt view
  if (req.method === "GET" && req.query.view === "edit-prompt") {
    const flash = (req.query.msg as string) || "";
    const html = await renderEditPrompt(flash);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(html);
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

  // Save offer details action (POST form)
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

  // Manual inventory refresh (POST form from dashboard)
  if (req.method === "POST" && req.query.action === "refresh-inventory") {
    try {
      const result = await refreshInventoryCache();
      console.log(`[Inventory] manual refresh: ${result.count} rows`);
    } catch (err: any) {
      console.error(`[Inventory] manual refresh failed: ${err.message}`);
    }
    res.setHeader("Location", `?view=dashboard`);
    return res.status(303).end();
  }

  // ─── KB upload (TXT or PDF) — extracts text → project_facts.facts_text ───
  if (req.method === "POST" && req.query.action === "upload-kb") {
    try {
      const body = req.body as any;
      const project = String(body.project || "").toUpperCase();
      const filename = String(body.filename || "kb-upload");
      const mimeType = String(body.mimetype || "application/octet-stream");
      const base64 = String(body.base64_content || "");

      if (!KNOWN_PROJECTS.includes(project as any)) {
        return res.status(400).json({ error: `Unknown project: ${project}` });
      }
      if (!base64) return res.status(400).json({ error: "base64_content required" });

      // Extract text — TXT directly, PDF via pdf-parse
      let extractedText = "";
      if (mimeType === "text/plain" || filename.toLowerCase().endsWith(".txt")) {
        extractedText = decodeBase64Text(base64);
      } else if (mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
        extractedText = await extractTextFromPDF(decodeBase64Buffer(base64));
        if (!extractedText) {
          return res.status(400).json({ error: "PDF text extraction returned empty — file may be image-only or corrupt" });
        }
      } else {
        return res.status(400).json({ error: `Unsupported mimetype: ${mimeType}` });
      }

      // Upload original to storage (for backup / reference)
      const upload = await uploadToStorage({
        project,
        docType: "kb_source",
        filename,
        mimeType,
        base64Content: base64,
      });

      // Save extracted KB text + PDF URL into project_facts.kb_text
      // (kept SEPARATE from facts_text so curated OFFER details are never overwritten)
      const saveResult = await saveProjectKb(project, extractedText, upload.publicUrl);
      if (!saveResult.ok) {
        return res.status(500).json({ error: `Save failed: ${saveResult.error}` });
      }

      return res.status(200).json({
        ok: true,
        project,
        extractedChars: extractedText.length,
        publicUrl: upload.publicUrl,
      });
    } catch (err: any) {
      console.error(`[upload-kb] failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Doc upload (PDF) — saves to Storage + project_documents row ────────
  if (req.method === "POST" && req.query.action === "upload-doc") {
    try {
      const body = req.body as any;
      const project = String(body.project || "").toUpperCase();
      const docType = String(body.doc_type || "").toLowerCase();
      const sizeLabel = body.size_label ? String(body.size_label) : null;
      const filename = String(body.filename || "doc.pdf");
      const mimeType = String(body.mimetype || "application/pdf");
      const base64 = String(body.base64_content || "");

      const VALID_DOC_TYPES = ["master_plan", "floor_plan", "unit_plan", "price_sheet", "payment_structure", "brochure", "specifications", "amenities"];
      if (!KNOWN_PROJECTS.includes(project as any)) {
        return res.status(400).json({ error: `Unknown project: ${project}` });
      }
      if (!VALID_DOC_TYPES.includes(docType)) {
        return res.status(400).json({ error: `Unknown doc_type: ${docType}` });
      }
      if (!base64) return res.status(400).json({ error: "base64_content required" });

      // unit_plan REQUIRES size_label
      if ((docType === "unit_plan" || docType === "floor_plan") && !sizeLabel) {
        return res.status(400).json({ error: `size_label required for ${docType} (e.g. "Tower A" / "1695 East")` });
      }

      const upload = await uploadToStorage({
        project,
        docType,
        filename,
        mimeType,
        base64Content: base64,
        sizeLabel,
      });

      // Insert row in project_documents
      const insertBody: any = {
        project,
        doc_type: docType,
        filename,
        url: upload.publicUrl,
      };
      if (sizeLabel) insertBody.size_label = sizeLabel;

      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/project_documents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "return=representation",
        },
        body: JSON.stringify(insertBody),
      });

      if (!insertRes.ok) {
        const errText = await insertRes.text();
        return res.status(500).json({ error: `DB insert failed: ${errText.slice(0, 200)}` });
      }

      const inserted = await insertRes.json();
      return res.status(200).json({
        ok: true,
        project,
        docType,
        sizeLabel,
        publicUrl: upload.publicUrl,
        record: inserted,
      });
    } catch (err: any) {
      console.error(`[upload-doc] failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Lead context for inbound calls ────────────────────────────────────
  // GET ?action=lead-context&phone=<E164 or 10-digit>&secret=<INHOUSE_POSTHOOK_SECRET>
  // Returns a compact context object for the voice bot to feed into the
  // Gemini Live session at inbound-call start. Lets the bot greet by name,
  // reference the project, and avoid asking duplicate qualifying questions.
  if (req.method === "GET" && req.query.action === "lead-context") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=" });
    }

    const phoneRaw = String(req.query.phone || "").trim();
    if (!phoneRaw) return res.status(400).json({ error: "phone query param required" });
    const phone = phoneRaw.replace(/^\+/, "").replace(/\D/g, "");

    try {
      const { findLeadByPhone } = await import("./_utils/zoho");
      const lead = await findLeadByPhone(phone);
      if (!lead) {
        return res.status(200).json({
          found: false,
          phone,
          message: "No lead with this phone in Zoho. Treat as fresh inquiry.",
        });
      }

      // Pull last 5 WhatsApp messages to summarise prior intent
      let lastWaIntent: string | null = null;
      let lastWaMessage: string | null = null;
      try {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/whatsapp_messages?phone=eq.${phone}&order=created_at.desc&limit=5&select=message,intent,direction,created_at`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        const rows = (await r.json()) as any[];
        const last = rows?.[0];
        lastWaMessage = last?.message?.slice(0, 200) || null;
        lastWaIntent = last?.intent || null;
      } catch {}

      const fullName = [lead.First_Name, lead.Last_Name]
        .filter((n) => n && n !== ".")
        .join(" ")
        .trim() || null;

      return res.status(200).json({
        found: true,
        phone,
        lead_id: lead.id,
        customer_name: fullName,
        first_name: lead.First_Name || null,
        project: lead.ASBL_Project || null,
        lead_status: lead.Lead_Status || null,
        call_status: lead.Call_Status || null,
        mlid: lead.Master_Lead_ID || null,
        plid: lead.Project_Lead_ID || null,
        last_arrowhead_call_id: lead.Last_Arrowhead_Call_ID || null,
        last_inhouse_call_id: lead.Last_Inhouse_Call_ID || null,
        total_call_duration_secs: lead.Total_Call_Duration_Secs || 0,
        recent_whatsapp: lastWaMessage
          ? { intent: lastWaIntent, last_message: lastWaMessage }
          : null,
        // A ready-to-inject snippet the bot can prepend to its system prompt
        context_snippet:
          fullName
            ? `The caller is ${fullName} (Mobile ${phone}). They previously enquired about ASBL ${lead.ASBL_Project || "(project not set)"}. ${lead.Lead_Status ? `Current lead status: ${lead.Lead_Status}.` : ""} ${lastWaMessage ? `Their last WhatsApp message was: "${lastWaMessage.slice(0, 120)}".` : ""}`.trim()
            : `Caller (Mobile ${phone}) is in our CRM but name is missing. They previously enquired about ASBL ${lead.ASBL_Project || "(project not set)"}.`,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Zoho daily leads report (since YYYY-MM-DD) ───────────────────────
  // GET ?action=zoho-leads-report&since=YYYY-MM-DD&secret=<INHOUSE_POSTHOOK_SECRET>
  // Pages through all Zoho Leads created on/after `since`, returns per-day
  // aggregates: total, by_status, with site-visit indicators.
  if (req.method === "GET" && req.query.action === "zoho-leads-report") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=" });
    }
    const since = String(req.query.since || "2026-04-01");
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();

      const fields = "id,Created_Time,Lead_Status,Call_Status,ASBL_Project,Lead_Source,First_Name,Last_Name,Mobile";
      const allLeads: any[] = [];
      let page = 1;
      const maxPages = 30; // 30 × 200 = 6000 leads safety cap
      while (page <= maxPages) {
        const r = await fetch(
          `${ZOHO_API_BASE}/Leads/search?criteria=(Created_Time:greater_equal:${since}T00:00:00%2B05:30)&fields=${fields}&page=${page}&per_page=200`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
        );
        if (r.status === 204) break;
        if (!r.ok) {
          const t = await r.text();
          return res.status(500).json({ error: `Zoho ${r.status}: ${t.slice(0, 300)}` });
        }
        const data = (await r.json()) as any;
        const rows = data?.data || [];
        allLeads.push(...rows);
        if (rows.length < 200 || data?.info?.more_records === false) break;
        page++;
      }

      // Aggregate per day
      const byDate: Record<string, any> = {};
      for (const lead of allLeads) {
        const created = String(lead.Created_Time || "");
        const day = created.slice(0, 10); // YYYY-MM-DD
        if (!day) continue;
        if (!byDate[day]) {
          byDate[day] = {
            date: day,
            total: 0,
            site_visit_booked: 0,   // Lead_Status: "Pre Site" / "Site Visit Booked"
            site_visit_done: 0,     // Lead_Status: "Site Visit Done" / "Site Visited"
            statuses: {} as Record<string, number>,
            sources: {} as Record<string, number>,   // FIM Forms / Website Inquiry / etc.
          };
        }
        byDate[day].total++;
        const ls = String(lead.Lead_Status || "");
        const src = String(lead.Lead_Source || "(unknown)");
        byDate[day].statuses[ls] = (byDate[day].statuses[ls] || 0) + 1;
        byDate[day].sources[src] = (byDate[day].sources[src] || 0) + 1;
        const lsLower = ls.toLowerCase();
        if (
          lsLower.includes("pre site") ||
          lsLower.includes("site visit booked") ||
          lsLower === "site visit"
        ) byDate[day].site_visit_booked++;
        if (
          lsLower.includes("site visit done") ||
          lsLower === "site visited" ||
          lsLower.includes("visited")
        ) byDate[day].site_visit_done++;
      }
      const dates = Object.keys(byDate).sort();
      const report = dates.map((d) => byDate[d]);
      // Also collect all unique statuses for inspection
      const allStatuses = new Set<string>();
      for (const r of report) Object.keys(r.statuses).forEach((s) => allStatuses.add(s));

      return res.status(200).json({
        since,
        total_leads: allLeads.length,
        pages_fetched: page,
        all_statuses_seen: Array.from(allStatuses).sort(),
        report,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Zoho lead inspector (debug) ────────────────────────────────────────
  // GET ?action=zoho-lead&id=<lead_id> OR &phone=<+91...>
  // Returns the raw lead record + recent Notes + recent Calls for diagnosis.
  // Auth: gated by INHOUSE_POSTHOOK_SECRET (so it isn't open to the world).
  if (req.method === "GET" && req.query.action === "zoho-lead") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret) {
      return res.status(503).json({ error: "INHOUSE_POSTHOOK_SECRET not configured (debug gate)" });
    }
    if (incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }

    try {
      const { getAccessToken, findLeadByPhone } = await import("./_utils/zoho");
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();

      const fields = "id,First_Name,Last_Name,Mobile,Email,ASBL_Project,Lead_Status,Last_Intent,Call_Status,Call_Duration,Total_Call_Duration_Secs,Last_Inhouse_Call_ID,Last_Arrowhead_Call_ID,Master_Lead_ID,Project_Lead_ID,Created_Time,Modified_Time";

      let lead: any = null;
      const leadId = req.query.id as string;
      const phone = req.query.phone as string;

      if (leadId) {
        const r = await fetch(`${ZOHO_API_BASE}/Leads/${leadId}?fields=${fields}`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
        });
        const j = await r.json() as any;
        lead = j?.data?.[0] || null;
      } else if (phone) {
        const cleaned = phone.replace(/^\+/, "");
        lead = await findLeadByPhone(cleaned);
      } else {
        return res.status(400).json({ error: "id or phone query param required" });
      }

      if (!lead) {
        return res.status(404).json({ error: "Lead not found", searched: { id: leadId, phone } });
      }

      // ── Fetch Notes — try related-list first, then Notes/search fallback ──
      let notes: any[] = [];
      const notesDebug: any = {};
      try {
        const nr = await fetch(
          `${ZOHO_API_BASE}/Leads/${lead.id}/Notes?sort_by=Created_Time&sort_order=desc&per_page=10`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
        );
        notesDebug.related_list_status = nr.status;
        if (nr.ok) {
          const nj = await nr.json() as any;
          notes = (nj?.data || []).map((n: any) => ({
            id: n.id,
            title: n.Note_Title,
            content: n.Note_Content || "",
            created_at: n.Created_Time,
          }));
        } else if (nr.status !== 204) {
          notesDebug.related_list_error = (await nr.text()).slice(0, 200);
        }
      } catch (e: any) { notesDebug.related_list_exception = e.message; }

      // Fallback: Notes/search by Parent_Id
      if (!notes.length) {
        try {
          const sr = await fetch(
            `${ZOHO_API_BASE}/Notes/search?criteria=(Parent_Id:equals:${lead.id})&sort_by=Created_Time&sort_order=desc&per_page=10`,
            { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
          );
          notesDebug.search_status = sr.status;
          if (sr.ok) {
            const sj = await sr.json() as any;
            notes = (sj?.data || []).map((n: any) => ({
              id: n.id,
              title: n.Note_Title,
              content: n.Note_Content || "",
              created_at: n.Created_Time,
            }));
          } else if (sr.status !== 204) {
            notesDebug.search_error = (await sr.text()).slice(0, 200);
          }
        } catch (e: any) { notesDebug.search_exception = e.message; }
      }

      // ── Fetch recent Calls — Calls aren't lead-linked here, search by recency ──
      let calls: any[] = [];
      const callsDebug: any = {};
      try {
        const cr = await fetch(
          `${ZOHO_API_BASE}/Calls?fields=id,Subject,Call_Type,Call_Duration,Call_Start_Time,Call_Status,Call_Result,Description&sort_by=Created_Time&sort_order=desc&per_page=20`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
        );
        callsDebug.list_status = cr.status;
        if (cr.ok) {
          const cj = await cr.json() as any;
          // Filter to calls referencing this lead in description (note: Zoho org doesn't support Who_Id for leads)
          const leadPhone = String(lead.Mobile || "").replace(/^\+/, "");
          calls = (cj?.data || [])
            .filter((c: any) => {
              const desc = String(c.Description || "");
              const sub = String(c.Subject || "");
              return desc.includes(leadPhone) || sub.includes(lead.Project_Lead_ID || "") || sub.includes(lead.Master_Lead_ID || "");
            })
            .slice(0, 5)
            .map((c: any) => ({
              id: c.id,
              subject: c.Subject,
              type: c.Call_Type,
              duration: c.Call_Duration,
              start_time: c.Call_Start_Time,
              status: c.Call_Status,
              call_result: c.Call_Result,
              description: (c.Description || "").slice(0, 300),
            }));
        } else if (cr.status !== 204) {
          callsDebug.list_error = (await cr.text()).slice(0, 200);
        }
      } catch (e: any) { callsDebug.list_exception = e.message; }

      return res.status(200).json({ lead, notes, calls, _debug: { notes: notesDebug, calls: callsDebug } });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Arrowhead diagnostic + manual test ─────────────────────────────────
  // GET  ?action=arrowhead-diag&secret=<...>
  //   Reports current Arrowhead config (URL + token presence).
  // POST ?action=arrowhead-test&secret=<...>&phone=+12266411111
  //   Fires a verbose dry-run POST to Arrowhead and returns the full
  //   response chain. Used when "calls scheduled by our endpoint but
  //   nothing shows in Arrowhead dashboard" — pinpoints whether we're
  //   actually reaching Arrowhead vs failing silently.
  if (req.method === "GET" && req.query.action === "arrowhead-diag") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const url = process.env.ARROWHEAD_CAMPAIGN_URL_US ||
      "https://api.agent.arrowhead.team/api/v2/public/domain/932f86fc-ed03-42d5-a127-7dfc63216a8a/campaign/adcc6884-03d1-4bfa-8b2f-ce4da5ddc527/schedule";
    const tokenSet = !!process.env.ARROWHEAD_BEARER_TOKEN;
    const tokenLen = (process.env.ARROWHEAD_BEARER_TOKEN || "").length;
    return res.status(200).json({
      campaign_url: url,
      token_configured: tokenSet,
      token_length: tokenLen,
      note: tokenSet
        ? "Token configured. Use ?action=arrowhead-test&phone=<E164> to fire a verbose test."
        : "Token MISSING — set ARROWHEAD_BEARER_TOKEN env var and redeploy.",
    });
  }

  if ((req.method === "POST" || req.method === "GET") && req.query.action === "arrowhead-test") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const phone = String(req.query.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone query param required (E.164)" });

    const url = process.env.ARROWHEAD_CAMPAIGN_URL_US ||
      "https://api.agent.arrowhead.team/api/v2/public/domain/932f86fc-ed03-42d5-a127-7dfc63216a8a/campaign/adcc6884-03d1-4bfa-8b2f-ce4da5ddc527/schedule";
    const token = process.env.ARROWHEAD_BEARER_TOKEN || "";
    if (!token) {
      return res.status(500).json({ error: "ARROWHEAD_BEARER_TOKEN env var missing" });
    }
    const dryRun = String(req.query.dry || "") === "1";
    // Arrowhead's current schema (as of May 2026 — confirmed via curl
    // from their team). All 5 top-level fields are required.
    const payload: any = {
      customer_full_name: "Test Customer",
      mobile_number: phone.replace(/^\+/, ""),
      external_customer_id: `TEST-${Date.now()}`,
      external_schedule_id: `TEST-${Date.now()}-call-1`,
      input_variables: {
        budget: "",
        intent: "",
        country: "",
        project: "ASBL Loft",
        comments: "Test call from CRM diag endpoint",
        customer_name: "Test Customer",
        web_time_spent: "",
        size_preference: "",
        call_enrichment_data: "",
        floor_level_preference: "",
        handover_timeline_preference: "",
      },
    };
    if (dryRun) {
      return res.status(200).json({
        dry_run: true,
        would_POST_to: url,
        would_use_token_prefix: token.slice(0, 8) + "...",
        would_send_payload: payload,
      });
    }
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const ms = Date.now() - t0;
      const respText = await r.text();
      let respJson: any = null;
      try { respJson = JSON.parse(respText); } catch {}
      return res.status(200).json({
        request: {
          url,
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.slice(0, 8)}...` },
          body: payload,
        },
        response: {
          ok: r.ok,
          status: r.status,
          headers: Object.fromEntries(r.headers.entries()),
          body: respJson || respText.slice(0, 1000),
        },
        latency_ms: ms,
        verdict: r.ok
          ? "✓ Arrowhead returned 2xx. Check their dashboard now — if still nothing, the URL is pointing to a stale/wrong campaign."
          : `✗ Arrowhead returned ${r.status}. Token expired, URL changed, or campaign disabled.`,
      });
    } catch (err: any) {
      return res.status(500).json({
        error: `arrowhead fetch threw: ${err.message}`,
        url,
      });
    }
  }

  // ─── PRD v1.0 — migrate legacy leads to PRD_Stage / PRD_Status ──────────
  // POST ?action=prd-migrate-legacy&secret=<INHOUSE_POSTHOOK_SECRET>&max=200&page=1
  //   Reads each lead's original Lead_Status field and maps to PRD's
  //   4-stage / 5-status model per user-confirmed mapping table.
  //   Skips: Booked + Virtual Tour (no slot in new PRD).
  //   Idempotent: leads already on PRD_Stage are skipped.
  if (req.method === "POST" && req.query.action === "prd-migrate-legacy") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();
      const max = Math.min(Number(req.query.max) || 200, 1000);
      const startPage = Math.max(1, Number(req.query.page) || 1);

      // Mapping per user-confirmed table (Q5 + Q6 clarifications).
      // Returns null = skip (Booked / Virtual Tour / unknown).
      const mapLegacy = (s: string | null | undefined): { stage: string; status: string | null; reason?: string } | null => {
        const v = (s || "").trim();
        if (!v) return { stage: "New Lead", status: "NA" };
        const lower = v.toLowerCase();
        if (["fresh", "na", "not called", "new"].includes(lower)) return { stage: "New Lead", status: "NA" };
        if (lower === "cf") return { stage: "New Lead", status: "CF" };
        if (lower === "sf") return { stage: "New Lead", status: "SF" };
        if (["cb1", "callback", "customer requested"].includes(lower)) return { stage: "Lead Initiated", status: "CS" };
        if (["cb2", "auto callback", "system scheduled"].includes(lower)) return { stage: "Lead Initiated", status: "SS" };
        if (lower === "pre site") return { stage: "Pre Site Visit", status: "NA" };
        if (lower === "lead initiated") return { stage: "New Lead", status: "SS" };
        if (lower === "connected") return { stage: "New Lead", status: "SS" };
        if (lower === "not interested") return { stage: "Not Interested", status: null, reason: "Not Interested" };
        if (["closed", "unreachable", "no response"].includes(lower)) return { stage: "Not Interested", status: null, reason: "User Not Responding" };
        if (["booked", "virtual tour"].includes(lower)) return null;  // SKIP
        return null;  // unknown → skip
      };

      const errors: any[] = [];
      let scanned = 0;
      let migrated = 0;
      let skippedAlreadyOnPrd = 0;
      let skippedNoMapping = 0;
      let skippedTerminal = 0;
      let failed = 0;

      let page = startPage;
      while (scanned < max) {
        const r = await fetch(
          `${ZOHO_API_BASE}/Leads?` +
          `fields=id,Lead_Status,PRD_Stage,PRD_Status&` +
          `per_page=100&page=${page}&sort_by=Modified_Time&sort_order=desc`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
        );
        if (r.status === 204) break;
        if (!r.ok) {
          errors.push({ page, status: r.status, error: (await r.text()).slice(0, 300) });
          break;
        }
        const rawText = await r.text();
        if (!rawText.trim()) break;
        let data: any = null;
        try { data = JSON.parse(rawText); } catch { break; }
        const rows = (data?.data || []) as any[];
        if (!rows.length) break;

        for (const lead of rows) {
          if (scanned >= max) break;
          scanned++;
          if (lead.PRD_Stage) { skippedAlreadyOnPrd++; continue; }
          const mapped = mapLegacy(lead.Lead_Status);
          if (!mapped) { skippedNoMapping++; continue; }

          const now = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
          const updateBody: any = {
            id: lead.id,
            PRD_Stage: mapped.stage,
            PRD_Status: mapped.status,
            PRD_Last_Action: "Manual",
            PRD_Last_Action_Time: now,
          };
          if (mapped.reason) updateBody.Not_Interested_Reason = mapped.reason;

          try {
            const ur = await fetch(`${ZOHO_API_BASE}/Leads`, {
              method: "PATCH",
              headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ data: [updateBody] }),
            });
            if (!ur.ok) {
              failed++;
              errors.push({ lead_id: lead.id, status: ur.status, error: (await ur.text()).slice(0, 200) });
            } else {
              migrated++;
              if (mapped.stage === "Not Interested") skippedTerminal++;
            }
          } catch (err: any) {
            failed++;
            errors.push({ lead_id: lead.id, error: err.message });
          }
        }

        if (data?.info?.more_records !== true) break;
        page++;
      }

      return res.status(200).json({
        page_start: startPage,
        page_end: page,
        scanned,
        migrated,
        skipped_already_on_prd: skippedAlreadyOnPrd,
        skipped_no_mapping: skippedNoMapping,
        migrated_to_terminal: skippedTerminal,
        failed,
        errors: errors.slice(0, 10),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── PRD v1.0 — overwrite Stage / Status picklist values ────────────────
  // GET ?action=prd-fix-stage-status&secret=<INHOUSE_POSTHOOK_SECRET>&dry=1
  //   Stage and Status existed pre-yesterday with old picklist values.
  //   This endpoint REPLACES their picklist values with PRD's 4-stage and
  //   5-status taxonomy. Existing leads with old values become "blank" —
  //   the migration script (Phase 8) re-populates them.
  if (req.method === "GET" && req.query.action === "prd-fix-stage-status") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const dryRun = String(req.query.dry || "") === "1";
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();

      const fr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      if (!fr.ok) {
        return res.status(fr.status).json({ error: "field-list failed", body: (await fr.text()).slice(0, 500) });
      }
      const fj = (await fr.json()) as any;
      const allFields = (fj?.fields || []) as any[];

      const stageField = allFields.find((f) => f.api_name === "Stage");
      const statusField = allFields.find((f) => f.api_name === "Status");

      const targets: Array<{ field: any; new_values: string[] }> = [];
      if (stageField) {
        targets.push({
          field: stageField,
          new_values: ["New Lead", "Lead Initiated", "Pre Site Visit", "Not Interested"],
        });
      }
      if (statusField) {
        targets.push({
          field: statusField,
          new_values: ["NA", "CF", "SF", "CS", "SS"],
        });
      }

      const summary: any[] = [];
      for (const t of targets) {
        const before = (t.field.pick_list_values || []).map((p: any) => p.display_value || p.actual_value);
        summary.push({
          api_name: t.field.api_name,
          field_id: t.field.id,
          before_values: before,
          target_values: t.new_values,
          would_change: JSON.stringify(before.sort()) !== JSON.stringify([...t.new_values].sort()),
        });
      }

      if (dryRun) {
        return res.status(200).json({ dry_run: true, summary });
      }

      // Actually apply — PUT /settings/fields/{id} with new pick_list_values
      const apply: any[] = [];
      for (const t of targets) {
        const newPicks = t.new_values.map((v) => ({ display_value: v, actual_value: v }));
        const body = { fields: [{ pick_list_values: newPicks }] };
        const ur = await fetch(`${ZOHO_API_BASE}/settings/fields/${t.field.id}?module=Leads`, {
          method: "PATCH",
          headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await ur.json().catch(() => ({}));
        apply.push({
          api_name: t.field.api_name,
          http_status: ur.status,
          success: ur.status >= 200 && ur.status < 300,
          response: ur.status >= 200 && ur.status < 300 ? "ok" : j,
        });
      }
      return res.status(200).json({ summary, apply });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── PRD v1.0 — create the 13 required Zoho fields ──────────────────────
  // GET ?action=prd-create-fields&secret=<INHOUSE_POSTHOOK_SECRET>
  //   Creates the 13 custom fields per PRD section 11. Each field has a
  //   primary label (matching PRD exactly) and a "PRD <X>" fallback label
  //   used when the primary clashes with existing Zoho fields (e.g. plain
  //   "Status" is reserved). Idempotent — skips if api_name already exists.
  if (req.method === "GET" && req.query.action === "prd-create-fields") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();

      const fr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      if (!fr.ok) {
        return res.status(fr.status).json({ error: "field-list failed", body: (await fr.text()).slice(0, 500) });
      }
      const fj = (await fr.json()) as any;
      const existing = (fj?.fields || []) as any[];
      const existingApis = new Set(existing.map((f) => f.api_name));
      const existingLabels = new Set(existing.map((f) => f.field_label));

      const pickList = (values: string[]) =>
        values.map((v) => ({ display_value: v, actual_value: v }));

      const desired = [
        { primary_api: "Stage",                    fallback_api: "PRD_Stage",                    primary_label: "Stage",                   fallback_label: "PRD Stage",                   spec_base: { data_type: "picklist", pick_list_values: pickList(["New Lead", "Lead Initiated", "Pre Site Visit", "Not Interested"]) } },
        { primary_api: "Status",                   fallback_api: "PRD_Status",                   primary_label: "Status",                  fallback_label: "PRD Status",                  spec_base: { data_type: "picklist", pick_list_values: pickList(["NA", "CF", "SF", "CS", "SS"]) } },
        { primary_api: "Preferred_Call_Time",      fallback_api: "PRD_Preferred_Call_Time",      primary_label: "Preferred Call Time",     fallback_label: "PRD Preferred Call Time",     spec_base: { data_type: "datetime" } },
        { primary_api: "System_Call_Time",         fallback_api: "PRD_System_Call_Time",         primary_label: "System Call Time",        fallback_label: "PRD System Call Time",        spec_base: { data_type: "datetime" } },
        { primary_api: "Chatbot_Attempt_Count",    fallback_api: "PRD_Chatbot_Attempt_Count",    primary_label: "Chatbot Attempt Count",   fallback_label: "PRD Chatbot Attempt Count",   spec_base: { data_type: "integer" } },
        { primary_api: "Chatbot_Follow_up_Count",  fallback_api: "PRD_Chatbot_Follow_up_Count",  primary_label: "Chatbot Follow-up Count", fallback_label: "PRD Chatbot Follow-up Count", spec_base: { data_type: "integer" } },
        { primary_api: "SS_Call_Attempt_Count",    fallback_api: "PRD_SS_Call_Attempt_Count",    primary_label: "SS Call Attempt Count",   fallback_label: "PRD SS Call Attempt Count",   spec_base: { data_type: "integer" } },
        { primary_api: "Last_Action",              fallback_api: "PRD_Last_Action",              primary_label: "Last Action",             fallback_label: "PRD Last Action",             spec_base: { data_type: "picklist", pick_list_values: pickList(["Chatbot", "AI Call", "Manual"]) } },
        { primary_api: "Last_Action_Time",         fallback_api: "PRD_Last_Action_Time",         primary_label: "Last Action Time",        fallback_label: "PRD Last Action Time",        spec_base: { data_type: "datetime" } },
        { primary_api: "Last_Customer_Response",   fallback_api: "PRD_Last_Customer_Response",   primary_label: "Last Customer Response",  fallback_label: "PRD Last Customer Response",  spec_base: { data_type: "textarea", length: 2000 } },
        { primary_api: "Intent_Captured",          fallback_api: "PRD_Intent_Captured",          primary_label: "Intent Captured",         fallback_label: "PRD Intent Captured",         spec_base: { data_type: "boolean" } },
        { primary_api: "Site_Visit_Date",          fallback_api: "PRD_Site_Visit_Date",          primary_label: "Site Visit Date",         fallback_label: "PRD Site Visit Date",         spec_base: { data_type: "datetime" } },
        { primary_api: "Not_Interested_Reason",    fallback_api: "PRD_Not_Interested_Reason",    primary_label: "Not Interested Reason",   fallback_label: "PRD Not Interested Reason",   spec_base: { data_type: "picklist", pick_list_values: pickList(["Not Interested", "User Not Responding", "Budget Issue", "Visit Confirmation Failed", "Other"]) } },
      ];

      const results: any[] = [];
      // Fields where the primary api_name pre-exists with INCOMPATIBLE
      // picklist values (yesterday's spec or older). Force fallback for these.
      const FORCE_FALLBACK = new Set(["Stage", "Status"]);

      for (const d of desired) {
        if (FORCE_FALLBACK.has(d.primary_api)) {
          // Skip primary, create fallback directly
          if (existingApis.has(d.fallback_api)) {
            results.push({ api: d.fallback_api, status: "already_exists", which: "fallback_forced" });
            continue;
          }
          // Force creation under fallback name + label
          const body = { fields: [{ field_label: d.fallback_label, ...d.spec_base }] };
          const cr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
            method: "POST",
            headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const j = await cr.json().catch(() => ({}));
          const success = cr.status >= 200 && cr.status < 300;
          results.push({
            api_intended: d.fallback_api,
            label_tried: [d.fallback_label],
            status: success ? "created_fallback_forced" : "failed",
            http_status: cr.status,
            response: success ? "ok" : j,
            reason: "primary api pre-exists with incompatible picklist",
          });
          continue;
        }
        if (existingApis.has(d.primary_api)) {
          results.push({ api: d.primary_api, status: "already_exists", which: "primary" });
          continue;
        }
        if (existingApis.has(d.fallback_api)) {
          results.push({ api: d.fallback_api, status: "already_exists", which: "fallback" });
          continue;
        }
        let useLabel = d.primary_label;
        if (existingLabels.has(d.primary_label)) {
          useLabel = d.fallback_label;
        }
        const body = { fields: [{ field_label: useLabel, ...d.spec_base }] };
        const cr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await cr.json().catch(() => ({}));
        const success = cr.status >= 200 && cr.status < 300;
        // Retry with fallback label if primary attempt failed on duplicate
        if (!success && useLabel === d.primary_label) {
          const errMsg = JSON.stringify(j).toLowerCase();
          if (errMsg.includes("duplicate") || errMsg.includes("already exists") || errMsg.includes("system keyword")) {
            const retryBody = { fields: [{ field_label: d.fallback_label, ...d.spec_base }] };
            const cr2 = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
              method: "POST",
              headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify(retryBody),
            });
            const j2 = await cr2.json().catch(() => ({}));
            const ok2 = cr2.status >= 200 && cr2.status < 300;
            results.push({
              api_intended: d.primary_api,
              label_tried: [d.primary_label, d.fallback_label],
              status: ok2 ? "created_fallback" : "failed",
              http_status: cr2.status,
              response: ok2 ? "ok" : j2,
            });
            continue;
          }
        }
        results.push({
          api_intended: d.primary_api,
          label_tried: [useLabel],
          status: success ? "created" : "failed",
          http_status: cr.status,
          response: success ? "ok" : j,
        });
      }

      const created = results.filter((r) => r.status === "created" || r.status === "created_fallback");
      const skipped = results.filter((r) => r.status === "already_exists");
      const failed = results.filter((r) => r.status === "failed");

      return res.status(200).json({
        status: failed.length === 0 ? "ok" : "partial",
        totals: { spec_fields_total: desired.length, created: created.length, already_existed: skipped.length, failed: failed.length },
        results,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── PRD v1.0 cleanup: delete all old "ASBL " labeled fields ──────────
  // GET ?action=prd-cleanup-old-fields&secret=<INHOUSE_POSTHOOK_SECRET>&dry=1
  //   Lists or deletes every Leads-module custom field whose label starts
  //   with "ASBL " (created by yesterday's spec implementation).
  //   PRD v1.0 replaces all of those with a simpler 13-field schema.
  //   dry=1  → list only (preview)
  //   no dry → actually delete (irreversible — all data on those fields lost)
  if (req.method === "GET" && req.query.action === "prd-cleanup-old-fields") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const dryRun = String(req.query.dry || "") === "1";
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();

      const fr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      if (!fr.ok) {
        return res.status(fr.status).json({ error: "field-list failed", body: (await fr.text()).slice(0, 500) });
      }
      const fj = (await fr.json()) as any;
      const allFields = (fj?.fields || []) as any[];

      // Match by label prefix "ASBL " (Zoho truncated my longer "ASBL Loft
      // Spec — " prefix to just "ASBL " when creating yesterday's fields).
      // EXCLUDE protected fields that pre-date yesterday's spec and are
      // production-critical (ASBL_Project is the main project picklist —
      // used by every ingest, webhook, and lead view; deleting would break
      // half the codebase).
      const PROTECTED_API_NAMES = new Set([
        "ASBL_Project",
      ]);
      const toDelete = allFields.filter((f) =>
        typeof f.field_label === "string" &&
        f.field_label.startsWith("ASBL ") &&
        !PROTECTED_API_NAMES.has(f.api_name),
      );

      if (dryRun) {
        return res.status(200).json({
          dry_run: true,
          would_delete_count: toDelete.length,
          would_delete: toDelete.map((f) => ({ id: f.id, api_name: f.api_name, label: f.field_label, data_type: f.data_type })),
        });
      }

      // Actually delete — one by one for clean per-field error reporting.
      const results: any[] = [];
      for (const f of toDelete) {
        try {
          const dr = await fetch(`${ZOHO_API_BASE}/settings/fields/${f.id}?module=Leads`, {
            method: "DELETE",
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
          });
          const j = await dr.json().catch(() => ({}));
          results.push({
            id: f.id,
            api_name: f.api_name,
            http_status: dr.status,
            success: dr.status >= 200 && dr.status < 300,
            response: dr.status >= 200 && dr.status < 300 ? "deleted" : j,
          });
        } catch (err: any) {
          results.push({ id: f.id, api_name: f.api_name, success: false, response: { error: err.message } });
        }
      }

      const deleted = results.filter((r) => r.success).map((r) => r.api_name);
      const failed = results.filter((r) => !r.success);

      return res.status(200).json({
        total_matched: toDelete.length,
        deleted_count: deleted.length,
        failed_count: failed.length,
        deleted,
        failed,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }


  // ─── Backfill Meta form leads into Zoho ──────────────────────────────────
  // POST/GET ?action=meta-backfill-form&secret=<...>&form_ids=<csv>
  //   Fetches every lead from each Meta form via Graph API /{form-id}/leads
  //   and runs them through our standard ingestLead() pipeline (dedup-safe).
  //   Existing leads matched by phone+project will have Resubmission_Count
  //   bumped; brand-new ones get created from scratch. Used to recover the
  //   leads that were captured by Meta but never reached us because our
  //   token lacked pages_manage_ads scope until the token rotation.
  if ((req.method === "POST" || req.method === "GET") && req.query.action === "meta-backfill-form") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    const formIdsRaw = String(req.query.form_ids || "").trim();
    if (!formIdsRaw) {
      return res.status(400).json({ error: "form_ids query param required (comma-separated)" });
    }
    const formIds = formIdsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const metaToken = process.env.META_PAGE_ACCESS_TOKEN || "";
    if (!metaToken) return res.status(500).json({ error: "META_PAGE_ACCESS_TOKEN not set" });

    const { buildNormalizedLead } = await import("./ingest/meta");
    const { ingestLead } = await import("./_utils/ingest");

    const overallStart = Date.now();
    const perFormResults: any[] = [];
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    for (const fid of formIds) {
      const created: any[] = [];
      const updated: any[] = [];
      const failed: any[] = [];
      const skipped: any[] = [];
      let nextUrl: string | null =
        `https://graph.facebook.com/v19.0/${fid}/leads?fields=id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic&limit=100&access_token=${encodeURIComponent(metaToken)}`;
      let pageCount = 0;
      let totalSeen = 0;
      let formError: string | null = null;

      while (nextUrl && pageCount < 20) {
        pageCount++;
        let pageData: any = null;
        try {
          const r = await fetch(nextUrl);
          pageData = await r.json();
          if (!r.ok || pageData?.error) {
            formError = pageData?.error?.message || `HTTP ${r.status}`;
            break;
          }
        } catch (err: any) {
          formError = `fetch threw: ${err.message}`;
          break;
        }
        const items = Array.isArray(pageData?.data) ? pageData.data : [];
        totalSeen += items.length;
        for (const item of items) {
          try {
            const enriched = { ...item, leadgen_id: item.id, form_id: fid };
            const lead = buildNormalizedLead(enriched);
            if (!lead) {
              skipped.push({ id: item.id, reason: "no_phone_or_normalize_failed" });
              continue;
            }
            const result = await ingestLead(lead);
            if (result.action === "created") {
              created.push({
                id: item.id,
                zoho_lead_id: result.zoho_lead_id,
                mobile: lead.mobile,
                name: `${lead.first_name} ${lead.last_name}`.trim(),
              });
            } else {
              updated.push({
                id: item.id,
                zoho_lead_id: result.zoho_lead_id,
                mobile: lead.mobile,
                resubmission_count: result.resubmission?.count,
              });
            }
          } catch (err: any) {
            failed.push({ id: item.id, error: (err.message || String(err)).slice(0, 200) });
          }
        }
        nextUrl = pageData?.paging?.next || null;
      }

      totalCreated += created.length;
      totalUpdated += updated.length;
      totalFailed += failed.length;
      totalSkipped += skipped.length;

      perFormResults.push({
        form_id: fid,
        pages_fetched: pageCount,
        total_seen: totalSeen,
        created_count: created.length,
        updated_count: updated.length,
        failed_count: failed.length,
        skipped_count: skipped.length,
        error: formError,
        created_sample: created.slice(0, 5),
        updated_sample: updated.slice(0, 5),
        failed_sample: failed.slice(0, 5),
        skipped_sample: skipped.slice(0, 5),
      });
    }

    return res.status(200).json({
      ms: Date.now() - overallStart,
      totals: {
        created: totalCreated,
        updated: totalUpdated,
        failed: totalFailed,
        skipped: totalSkipped,
      },
      per_form: perFormResults,
    });
  }

  // ─── Probe specific Meta form IDs — pinpoint ownership + readability ────
  // GET ?action=meta-form-probe&secret=<INHOUSE_POSTHOOK_SECRET>&form_ids=<csv>
  //   For each form_id, calls Graph API directly and returns:
  //     - whether our token can read it
  //     - the page that owns the form (with ID + name)
  //     - the form's current status (ACTIVE / PAUSED / ARCHIVED)
  //     - whether the owning page is in our token's scope
  //     - which app is subscribed to that page's leadgen webhook
  //   This is the surgical follow-up to meta-deep-diag when the user
  //   knows specific form IDs that should be flowing leads.
  if (req.method === "GET" && req.query.action === "meta-form-probe") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    const formIdsRaw = String(req.query.form_ids || "").trim();
    if (!formIdsRaw) {
      return res.status(400).json({ error: "form_ids query param required (comma-separated)" });
    }
    const formIds = formIdsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const metaToken = process.env.META_PAGE_ACCESS_TOKEN || "";
    if (!metaToken) return res.status(500).json({ error: "META_PAGE_ACCESS_TOKEN not set" });

    // Get list of pages this token can access so we can flag in-scope vs not
    const pagesRes = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token&limit=50&access_token=${encodeURIComponent(metaToken)}`,
    );
    const pagesData = await pagesRes.json().catch(() => ({}));
    const visiblePages = (pagesData?.data || []) as any[];
    const visiblePageIds = new Set(visiblePages.map((p: any) => p.id));

    // Pick a page access token to ALSO try with — sometimes form reads
    // need the page-scoped token, not the System User one.
    const firstPage = visiblePages[0];
    const probePageToken = firstPage?.access_token || "";
    const probePageId = firstPage?.id;
    const probePageName = firstPage?.name;

    const probes: any[] = [];
    for (const fid of formIds) {
      // ── Try 1: System User token (current behaviour) ──────────────────
      const r = await fetch(
        `https://graph.facebook.com/v19.0/${fid}?fields=id,name,status,locale,leads_count,page,created_time&access_token=${encodeURIComponent(metaToken)}`,
      );
      const data = await r.json().catch(() => ({}));
      const systemUserAttempt = {
        ok: r.ok && !data?.error,
        error: data?.error?.message,
        error_code: data?.error?.code,
        error_subcode: data?.error?.error_subcode,
        error_type: data?.error?.type,
      };

      // ── Try 2: Page-scoped token (if page visible) ────────────────────
      let pageTokenAttempt: any = { skipped: !probePageToken };
      if (probePageToken) {
        const pr = await fetch(
          `https://graph.facebook.com/v19.0/${fid}?fields=id,name,status,locale,leads_count,page,created_time&access_token=${encodeURIComponent(probePageToken)}`,
        );
        const pd = await pr.json().catch(() => ({}));
        pageTokenAttempt = {
          ok: pr.ok && !pd?.error,
          name: pd?.name,
          status: pd?.status,
          page_id: pd?.page?.id,
          page_name: pd?.page?.name,
          leads_count: pd?.leads_count,
          error: pd?.error?.message,
          error_code: pd?.error?.code,
        };
      }

      // ── Try 3: List the page's forms and see if this ID is in there ───
      let foundInPageList: any = { skipped: !probePageToken };
      if (probePageToken && probePageId) {
        const lr = await fetch(
          `https://graph.facebook.com/v19.0/${probePageId}/leadgen_forms?fields=id,name,status,leads_count&limit=200&access_token=${encodeURIComponent(probePageToken)}`,
        );
        const ld = await lr.json().catch(() => ({}));
        if (lr.ok && Array.isArray(ld?.data)) {
          const match = ld.data.find((f: any) => String(f.id) === String(fid));
          foundInPageList = {
            page_id: probePageId,
            page_name: probePageName,
            page_form_count: ld.data.length,
            this_form_in_list: !!match,
            this_form_details: match || null,
            sample_form_ids: ld.data.slice(0, 5).map((f: any) => `${f.id} (${f.name})`),
          };
        } else {
          foundInPageList = {
            page_id: probePageId,
            page_name: probePageName,
            error: ld?.error?.message || `HTTP ${lr.status}`,
          };
        }
      }

      const anyOk = systemUserAttempt.ok || pageTokenAttempt?.ok;
      if (!anyOk) {
        probes.push({
          form_id: fid,
          readable: false,
          system_user_attempt: systemUserAttempt,
          page_token_attempt: pageTokenAttempt,
          found_in_page_list: foundInPageList,
          error: systemUserAttempt.error || pageTokenAttempt?.error,
          error_code: systemUserAttempt.error_code,
        });
        continue;
      }
      const pageId = data?.page?.id;
      const pageName = data?.page?.name;
      // Check leadgen webhook subscription on the form's owning page
      let leadgenSubscribed: boolean | null = null;
      let subscribedApps: any[] = [];
      if (pageId && visiblePageIds.has(pageId)) {
        const page = visiblePages.find((p: any) => p.id === pageId);
        const pageToken = page?.access_token || metaToken;
        const sr = await fetch(
          `https://graph.facebook.com/v19.0/${probePageId}/subscribed_apps?access_token=${encodeURIComponent(probePageToken)}`,
        );
        const sd = await sr.json().catch(() => ({}));
        if (sr.ok && Array.isArray(sd?.data)) {
          subscribedApps = sd.data.map((a: any) => ({
            id: a.id,
            name: a.name,
            subscribed_fields: a.subscribed_fields || [],
            has_leadgen: (a.subscribed_fields || []).includes("leadgen"),
          }));
          leadgenSubscribed = subscribedApps.some((a) => a.has_leadgen);
        }
      }
      probes.push({
        form_id: fid,
        readable: true,
        name: data.name,
        status: data.status,
        leads_count: data.leads_count,
        locale: data.locale,
        created_time: data.created_time,
        page_id: probePageId,
        page_name: probePageName,
        page_in_token_scope: pageId ? visiblePageIds.has(pageId) : false,
        leadgen_subscribed_on_page: leadgenSubscribed,
        subscribed_apps: subscribedApps,
      });
    }
    const issues: string[] = [];
    for (const p of probes) {
      if (!p.readable) {
        issues.push(`Form ${p.form_id}: NOT readable (${p.error}). Token can't see it.`);
      } else {
        if (!p.page_in_token_scope) {
          issues.push(`Form ${p.form_id} is owned by page ${p.page_id} (${p.page_name}) which is NOT in our token's scope — leads from this form will never reach us.`);
        } else if (p.leadgen_subscribed_on_page === false) {
          issues.push(`Form ${p.form_id}'s page (${p.page_name}) is in scope but NOT subscribed to leadgen webhook. Use &fix=1 on meta-deep-diag to subscribe.`);
        }
      }
    }
    if (!issues.length) {
      issues.push("All probed forms are readable, owned by in-scope pages, and the pages are subscribed to leadgen. Leads should flow — check our webhook handler logs for downstream issues.");
    }
    return res.status(200).json({
      token_visible_pages: visiblePages.map((p) => ({ id: p.id, name: p.name })),
      probed_forms: probes,
      issues,
    });
  }

  // ─── Zoho audit — full custom fields + Blueprint + Lead_Status picklist ──
  // GET ?action=zoho-audit&secret=<INHOUSE_POSTHOOK_SECRET>
  //   One-shot diagnostic to map current Zoho state against the spec's
  //   80+ custom field requirement, 6-stage Blueprint, and Status model.
  //   Returns:
  //     - All custom fields grouped by section + flagged with type/length
  //     - All picklist values for Lead_Status (and other key picklists)
  //     - Existing Blueprint structure if any
  //   Used as Step 1 of the ASBL spec implementation: gap analysis.
  if (req.method === "GET" && req.query.action === "zoho-audit") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();

      // 1. All Leads-module fields
      const fr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      if (!fr.ok) {
        return res.status(fr.status).json({ error: "fields fetch failed", body: (await fr.text()).slice(0, 500) });
      }
      const fj = await fr.json() as any;
      const allFields = (fj?.fields || []) as any[];

      // 2. Picklist values for key fields (Lead_Status, ASBL_Project, etc.)
      const pickFields: Record<string, string[]> = {};
      const keyPicklists = ["Lead_Status", "ASBL_Project", "Call_Status", "Call_Outcome", "Last_Resubmission_Source", "Lead_Source"];
      for (const apiName of keyPicklists) {
        const f = allFields.find((x) => x.api_name === apiName);
        if (f && Array.isArray(f.pick_list_values)) {
          pickFields[apiName] = f.pick_list_values.map((p: any) => p.display_value || p.actual_value);
        }
      }

      // 3. Blueprint structure — list all blueprints for Leads module
      let blueprints: any = null;
      try {
        const br = await fetch(`${ZOHO_API_BASE}/settings/automation/blueprint?module=Leads`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
        });
        if (br.ok) {
          const bj = await br.json();
          blueprints = bj;
        } else {
          blueprints = { error: `${br.status}: ${(await br.text()).slice(0, 200)}` };
        }
      } catch (err: any) {
        blueprints = { error: err.message };
      }

      // 4. Custom field summary — group by lookup_type, system_defined, etc.
      const customFields = allFields.filter((f) => f.custom_field);
      const systemFields = allFields.filter((f) => !f.custom_field);

      const customByType: Record<string, number> = {};
      for (const f of customFields) {
        const t = f.data_type || "unknown";
        customByType[t] = (customByType[t] || 0) + 1;
      }

      // Spec requires these field families — flag which ones we have
      const specFamilies: Record<string, { spec_count: number; have: string[] }> = {
        "Identity & Attribution (9.1)": {
          spec_count: 17,
          have: customFields
            .filter((f) => /Project|Visitor|Session|GCLID|FBCLID|WBRAID|GBRAID|UTM|Landing|Referrer|Device|IP/i.test(f.api_name))
            .map((f) => f.api_name),
        },
        "Stage & Status (9.2)": {
          spec_count: 7,
          have: customFields
            .filter((f) => /Stage|Status|Callback_Source|Closure_Reason|State_Change/i.test(f.api_name))
            .map((f) => f.api_name),
        },
        "WhatsApp Channel (9.3)": {
          spec_count: 6,
          have: customFields
            .filter((f) => /WhatsApp|Opt_Out_WhatsApp/i.test(f.api_name))
            .map((f) => f.api_name),
        },
        "Voice Channel (9.4)": {
          spec_count: 9,
          have: customFields
            .filter((f) => /Call_State|Call_Last|Call_Attempt|Call_Connected|Call_Disposition|Recording|Preferred_Callback|Opt_Out_Calls/i.test(f.api_name))
            .map((f) => f.api_name),
        },
        "Bot State (9.5)": {
          spec_count: 6,
          have: customFields
            .filter((f) => /Bot_|Active_Channel|LLM_Cost/i.test(f.api_name))
            .map((f) => f.api_name),
        },
        "Slots (9.6)": {
          spec_count: 9,
          have: customFields
            .filter((f) => /Intent|Budget_Bucket|Timeline_Bucket|Configuration_Interest|Workplace|Loan_Required|Competitor|Slot/i.test(f.api_name))
            .map((f) => f.api_name),
        },
        "Lead Score (9.7)": {
          spec_count: 4,
          have: customFields
            .filter((f) => /Lead_Score|Lead_Tier|Score_Last|Predicted_Value/i.test(f.api_name))
            .map((f) => f.api_name),
        },
        "Site Visit (9.8)": {
          spec_count: 7,
          have: customFields
            .filter((f) => /Site_Visit/i.test(f.api_name))
            .map((f) => f.api_name),
        },
        "Outcome (9.9)": {
          spec_count: 4,
          have: customFields
            .filter((f) => /Booking|Closed_At/i.test(f.api_name))
            .map((f) => f.api_name),
        },
        "Progress Flags (9.10)": {
          spec_count: 16,
          have: customFields
            .filter((f) => /^F_/i.test(f.api_name))
            .map((f) => f.api_name),
        },
        "System/Audit (9.11)": {
          spec_count: 6,
          have: customFields
            .filter((f) => /Last_Inbound|Next_Action|Active_Cadence|Cadence_Step|Lead_Locked/i.test(f.api_name))
            .map((f) => f.api_name),
        },
      };

      const gapSummary = Object.entries(specFamilies).map(([family, info]) => ({
        family,
        spec_count: info.spec_count,
        have_count: info.have.length,
        missing_count: Math.max(0, info.spec_count - info.have.length),
        have_fields: info.have,
      }));

      return res.status(200).json({
        timestamp: new Date().toISOString(),
        totals: {
          all_fields: allFields.length,
          custom_fields: customFields.length,
          system_fields: systemFields.length,
        },
        custom_fields_by_type: customByType,
        all_custom_field_api_names: customFields.map((f) => ({
          api_name: f.api_name,
          label: f.field_label,
          type: f.data_type,
          length: f.length,
          required: f.required,
        })),
        picklists: pickFields,
        blueprints: blueprints,
        spec_gap_analysis: gapSummary,
        spec_gap_totals: {
          total_spec_fields_needed: gapSummary.reduce((s, g) => s + g.spec_count, 0),
          total_we_have: gapSummary.reduce((s, g) => s + g.have_count, 0),
          total_missing: gapSummary.reduce((s, g) => s + g.missing_count, 0),
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Zoho field metadata + auto-create Last_Inhouse_Call_ID ────────────
  // GET ?action=zoho-fields&secret=<INHOUSE_POSTHOOK_SECRET>
  //   Lists ALL custom fields on the Leads module + checks for the call-id
  //   ones used by our posthook flows (Last_Arrowhead_Call_ID, Last_Inhouse_Call_ID).
  // GET ?action=zoho-create-inhouse-field&secret=<...>
  //   Attempts to CREATE Last_Inhouse_Call_ID via Zoho Metadata API.
  //   Requires the refresh token to have ZohoCRM.settings.fields.CREATE scope.
  // GET ?action=zoho-create-resubmission-fields&secret=<...>
  //   Creates Resubmission_Count / Resubmission_History / Last_Resubmission_At /
  //   Last_Resubmission_Source so the resubmission tracking system can stamp
  //   leads on every form re-fill. Idempotent — skips fields that exist.
  if (req.method === "GET" && (req.query.action === "zoho-fields" || req.query.action === "zoho-create-inhouse-field" || req.query.action === "zoho-create-recording-field" || req.query.action === "zoho-create-resubmission-fields")) {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }

    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();

      // Always list fields first
      const fr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      if (!fr.ok) {
        return res.status(fr.status).json({ error: "field-list failed", body: (await fr.text()).slice(0, 500) });
      }
      const fj = await fr.json() as any;
      const allFields = (fj?.fields || []) as any[];
      const callRelated = allFields
        .filter((f) => /call|inhouse|arrowhead|recording|transcript|resubmission/i.test(f.api_name || ""))
        .map((f) => ({
          api_name: f.api_name,
          field_label: f.field_label,
          data_type: f.data_type,
          custom_field: f.custom_field,
          length: f.length,
        }));

      const hasInhouse = callRelated.some((f) => f.api_name === "Last_Inhouse_Call_ID");

      if (req.query.action === "zoho-fields") {
        return res.status(200).json({
          total_fields: allFields.length,
          call_related_fields: callRelated,
          Last_Inhouse_Call_ID_exists: hasInhouse,
        });
      }

      // zoho-create-resubmission-fields — creates the 4 fields the
      // resubmission tracking system needs:
      //   - Resubmission_Count        : integer, default 0
      //   - Resubmission_History      : textarea (30000), one line per resubmit
      //   - Last_Resubmission_At      : datetime
      //   - Last_Resubmission_Source  : text (60 chars), e.g. "Website Inquiry"
      // Idempotent: skips fields that already exist, creates the rest.
      if (req.query.action === "zoho-create-resubmission-fields") {
        const desired: Array<{ api: string; spec: any }> = [
          {
            api: "Resubmission_Count",
            spec: { field_label: "Resubmission Count", data_type: "integer" },
          },
          {
            // Zoho textarea only accepts length 2000 / 32000 / 50000.
            // 32000 is the right tier — comfortably fits ~200+ resubmission
            // history lines (~150 chars each).
            api: "Resubmission_History",
            spec: { field_label: "Resubmission History", data_type: "textarea", length: 32000 },
          },
          {
            api: "Last_Resubmission_At",
            spec: { field_label: "Last Resubmission At", data_type: "datetime" },
          },
          {
            api: "Last_Resubmission_Source",
            spec: { field_label: "Last Resubmission Source", data_type: "text", length: 60 },
          },
        ];
        const existingApis = new Set(allFields.map((f) => f.api_name));
        const toCreate = desired.filter((d) => !existingApis.has(d.api));
        const skipped = desired.filter((d) => existingApis.has(d.api));

        if (!toCreate.length) {
          return res.status(200).json({
            status: "all_already_exist",
            existing: skipped.map((d) => d.api),
          });
        }

        // Zoho's Metadata API accepts multiple fields per request, but
        // partial-failure responses are easier to debug if we send one at a
        // time — so we loop. Total network cost is 4 small requests.
        const results: any[] = [];
        for (const d of toCreate) {
          const cr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
            method: "POST",
            headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ fields: [d.spec] }),
          });
          const j = await cr.json().catch(() => ({}));
          results.push({ api_name: d.api, http_status: cr.status, response: j });
        }
        return res.status(200).json({
          status: "attempted",
          created: results.filter((r) => r.http_status >= 200 && r.http_status < 300).map((r) => r.api_name),
          skipped: skipped.map((d) => d.api),
          results,
          hint: results.some((r) => r.http_status === 401 || r.http_status === 403)
            ? "Zoho refresh token likely lacks ZohoCRM.settings.fields.CREATE scope. Add the fields manually under Setup → Customization → Modules → Leads → Fields."
            : undefined,
        });
      }

      // zoho-create-recording-field — creates Last_Recording_URL (text, 500 chars)
      if (req.query.action === "zoho-create-recording-field") {
        const hasRecording = allFields.some((f) => f.api_name === "Last_Recording_URL");
        if (hasRecording) {
          return res.status(200).json({
            status: "already_exists",
            existing: callRelated.find((f) => f.api_name === "Last_Recording_URL"),
          });
        }
        const cr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            fields: [{
              field_label: "Last Recording URL",
              data_type: "textarea",
              length: 3000,
            }],
          }),
        });
        return res.status(cr.status).json({
          attempted: true,
          http_status: cr.status,
          response: await cr.json().catch(() => ({})),
        });
      }

      // zoho-create-inhouse-field path
      if (hasInhouse) {
        return res.status(200).json({
          status: "already_exists",
          message: "Last_Inhouse_Call_ID is already a field on the Leads module",
          existing: callRelated.find((f) => f.api_name === "Last_Inhouse_Call_ID"),
        });
      }

      // Attempt creation — Zoho's tooltip.name only accepts "Static Text" or
      // "Info Icon" (with that exact casing). Skipping tooltip for simplicity.
      const createBody = {
        fields: [
          {
            field_label: "Last Inhouse Call ID",
            data_type: "text",
            length: 100,
          },
        ],
      };
      const cr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createBody),
      });
      const createResp = await cr.json().catch(() => ({}));
      return res.status(cr.status).json({
        attempted: true,
        http_status: cr.status,
        response: createResp,
        hint: cr.status === 401 || cr.status === 403
          ? "Your Zoho refresh token likely doesn't have ZohoCRM.settings.fields.CREATE scope. Add the field manually: Setup → Customization → Modules → Leads → Fields → + New Field → Single Line → name 'Last Inhouse Call ID'."
          : undefined,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Stuck calls — outbound calls whose posthook never arrived ─────────
  // GET ?action=stuck-calls&secret=<INHOUSE_POSTHOOK_SECRET>&hours=24
  //   Lists recent Zoho leads where we triggered an outbound voice call
  //   (Last_Inhouse_Call_ID is set) but never got the completion posthook
  //   (Call_Status is null / Modified_Time hasn't moved past the call
  //   trigger). Scope of "posthooks not arriving" issue.
  if (req.method === "GET" && req.query.action === "stuck-calls") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const token = await getAccessToken();
      // Search for leads with Last_Inhouse_Call_ID set, sorted by Modified
      // time desc. Then filter client-side for missing Call_Status.
      // Note: Zoho's search api doesn't support null/empty negation cleanly,
      // so we fetch the recently-modified set and partition in JS.
      const since = new Date(Date.now() - hours * 3600 * 1000);
      // Zoho search's "not_equal:null" doesn't reliably match custom-field
      // presence — fetch the most-recently-modified leads (page through up
      // to 400) and filter client-side for Last_Inhouse_Call_ID presence.
      // Reliable + works for both the "field doesn't exist" and "field
      // exists but empty" cases.
      const candidates: any[] = [];
      // Check BOTH call-id fields — older calls were stamped under
      // Last_Arrowhead_Call_ID (legacy Arrowhead flow), newer under
      // Last_Inhouse_Call_ID (in-house voice bot). Either one indicates
      // a call was triggered.
      const fieldsList = "id,First_Name,Last_Name,Mobile,Last_Inhouse_Call_ID,Last_Arrowhead_Call_ID,Call_Status,Call_Duration,Lead_Status,Modified_Time,Created_Time";
      for (let page = 1; page <= 4; page++) {
        const r = await fetch(
          `https://www.zohoapis.in/crm/v3/Leads?` +
          `fields=${encodeURIComponent(fieldsList)}` +
          `&per_page=100&page=${page}&sort_by=Modified_Time&sort_order=desc`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
        );
        if (r.status === 204) break;
        if (!r.ok) {
          const txt = (await r.text()).slice(0, 300);
          return res.status(r.status).json({ error: "zoho-list failed", body: txt, page });
        }
        const rawText = await r.text();
        let data: any = null;
        if (rawText.trim()) { try { data = JSON.parse(rawText); } catch {} }
        const rows = (data?.data || []) as any[];
        if (!rows.length) break;
        candidates.push(...rows);
        // Stop early if we've gone past the time window
        const oldest = rows[rows.length - 1]?.Modified_Time;
        if (oldest && new Date(oldest) < since) break;
        const hasMore = data?.info?.more_records;
        if (!hasMore) break;
      }
      // Consider leads with EITHER call-id field set (inhouse OR arrowhead)
      const hasInhouseId = (l: any) => l.Last_Inhouse_Call_ID && String(l.Last_Inhouse_Call_ID).trim() !== "";
      const hasArrowheadId = (l: any) => l.Last_Arrowhead_Call_ID && String(l.Last_Arrowhead_Call_ID).trim() !== "";
      const all = candidates.filter((l) => hasInhouseId(l) || hasArrowheadId(l));

      // "Not Called" is the INITIAL state Deluge stamps when triggering —
      // it is NOT a posthook result. Treat it as stuck. Real posthook
      // outcomes are: Connected, Not Connected, Busy, Switched Off,
      // Pre Site, Virtual Tour, Not Interested.
      const isStuckStatus = (s: string | null | undefined): boolean => {
        const t = String(s || "").trim();
        return !t || t.toLowerCase() === "not called";
      };
      // Partition: posthook_fired (Call_Status set) vs stuck (null/empty)
      const stuck = all.filter((l) => isStuckStatus(l.Call_Status));
      const completed = all.filter((l) => !isStuckStatus(l.Call_Status));
      const recentSince = all.filter((l) => new Date(l.Modified_Time) >= since);
      const recentStuck = stuck.filter((l) => new Date(l.Modified_Time) >= since);
      // Break down by call source so user can see whether issue is in
      // the legacy Arrowhead path, the new in-house path, or both.
      const inhouseAll = all.filter(hasInhouseId);
      const arrowheadAll = all.filter(hasArrowheadId);
      const inhouseStuck = stuck.filter(hasInhouseId);
      const arrowheadStuck = stuck.filter(hasArrowheadId);

      return res.status(200).json({
        window_hours: hours,
        summary: {
          total_with_call_id: all.length,
          posthook_received: completed.length,
          posthook_missing: stuck.length,
          recent_total: recentSince.length,
          recent_stuck: recentStuck.length,
          inhouse_total: inhouseAll.length,
          inhouse_stuck: inhouseStuck.length,
          arrowhead_total: arrowheadAll.length,
          arrowhead_stuck: arrowheadStuck.length,
        },
        diagnosis:
          recentStuck.length === 0
            ? "No stuck calls in window — every recent outbound call got its posthook."
            : recentStuck.length === recentSince.length && recentSince.length > 0
            ? `100% of recent calls are stuck (${recentStuck.length}/${recentSince.length}). Voice bot is either not firing posthooks or firing to wrong URL/secret.`
            : `${recentStuck.length} of ${recentSince.length} recent calls are stuck. Partial failure — possibly lead-lookup mismatch (call_id vs call_sid).`,
        recent_stuck_sample: recentStuck.slice(0, 15).map((l) => ({
          lead_id: l.id,
          name: `${l.First_Name || ""} ${l.Last_Name || ""}`.trim(),
          mobile: l.Mobile,
          inhouse_call_id: l.Last_Inhouse_Call_ID || null,
          arrowhead_call_id: l.Last_Arrowhead_Call_ID || null,
          source: hasInhouseId(l) ? "inhouse" : "arrowhead",
          lead_status: l.Lead_Status,
          modified_time: l.Modified_Time,
        })),
        completed_sample: completed.slice(0, 5).map((l) => ({
          lead_id: l.id,
          inhouse_call_id: l.Last_Inhouse_Call_ID || null,
          arrowhead_call_id: l.Last_Arrowhead_Call_ID || null,
          call_status: l.Call_Status,
          duration: l.Call_Duration,
          modified_time: l.Modified_Time,
        })),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Simulate posthook — verify OUR side works end-to-end ──────────────
  // POST ?action=simulate-posthook&secret=<INHOUSE_POSTHOOK_SECRET>
  // Body: { call_id, phone, duration_seconds, call_outcome, summary }
  //   Fires a fake call_completed payload at our own /inhouse-posthook
  //   endpoint and returns the full chain result. Isolates whether the
  //   break is on the voice-bot side (webhook not firing) or our side
  //   (lookup/Zoho-update failing).
  if (req.method === "POST" && req.query.action === "simulate-posthook") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    const body = (req.body || {}) as any;
    const callId = String(body.call_id || "").trim();
    const phone = String(body.phone || body.phone_number || "").trim();
    if (!callId && !phone) {
      return res.status(400).json({
        error: "Pass at least one of call_id (matching a Zoho Last_Inhouse_Call_ID) or phone.",
        example: { call_id: "call_abc123", phone: "+918700432466", duration_seconds: 45, call_outcome: "CONNECTED" },
      });
    }
    const fakePayload = {
      event: "call_completed",
      call_sid: callId,
      call_id: callId,
      phone_number: phone,
      duration_seconds: Number(body.duration_seconds) || 35,
      call_outcome: body.call_outcome || "CONNECTED",
      summary: body.summary || "[SIMULATED POSTHOOK] Test reach to verify Zoho update path.",
      full_text: body.full_text || "Bot: Hello. Customer: Hi.",
      started_at: new Date(Date.now() - 60_000).toISOString(),
      ended_at: new Date().toISOString(),
    };
    const target = `https://${req.headers.host}/api/relay/inhouse-posthook`;
    try {
      const r = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": expectedSecret,
        },
        body: JSON.stringify(fakePayload),
      });
      const txt = await r.text();
      let parsed: any = null;
      try { parsed = JSON.parse(txt); } catch {}
      return res.status(200).json({
        target,
        request_sent: fakePayload,
        response_status: r.status,
        response_ok: r.ok,
        response_body: parsed || txt.slice(0, 500),
        verdict: r.ok && parsed?.status === "ok" && parsed?.lead_id
          ? "✓ Our posthook chain is HEALTHY. Issue is on voice-bot side (not firing webhooks)."
          : r.ok && parsed?.message?.includes("not found")
          ? "✗ Our endpoint works but lead lookup FAILED. Check that the call_id matches what we stamped (Last_Inhouse_Call_ID in Zoho)."
          : r.status === 401
          ? "✗ Secret rejected — INHOUSE_POSTHOOK_SECRET mismatch."
          : `✗ Posthook returned HTTP ${r.status}. Inspect response_body.`,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Gemini available-models lister ─────────────────────────────────────
  // GET ?action=gemini-models&secret=<INHOUSE_POSTHOOK_SECRET>
  //   Hits Google's /v1beta/models endpoint with our GEMINI_API_KEY and
  //   returns every model the key has access to, plus current GEMINI_MODEL
  //   env var, plus quick-pick suggestions for stable-vs-preview. Used to
  //   pick a stable replacement for gemini-3.x preview when it 503s.
  if (req.method === "GET" && req.query.action === "gemini-models") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    const apiKey = process.env.GEMINI_API_KEY || "";
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`,
      );
      if (!r.ok) {
        return res.status(r.status).json({
          error: "models list failed",
          status: r.status,
          body: (await r.text()).slice(0, 500),
        });
      }
      const data = (await r.json()) as any;
      const models = (data?.models || []) as any[];
      const generationCapable = models.filter((m) =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes("generateContent"),
      );
      // Stable = no "preview" / "exp" in the name. Preview models 503 a lot
      // under load (real-world: gemini-3.x-pro-preview throws "high demand").
      const stableModels = generationCapable.filter((m) =>
        !/preview|exp/i.test(m.name || ""),
      );
      const previewModels = generationCapable.filter((m) =>
        /preview|exp/i.test(m.name || ""),
      );

      const slim = (m: any) => ({
        name: (m.name || "").replace(/^models\//, ""),
        displayName: m.displayName,
        version: m.version,
        inputTokenLimit: m.inputTokenLimit,
        outputTokenLimit: m.outputTokenLimit,
      });

      return res.status(200).json({
        currentEnvModel: process.env.GEMINI_MODEL || "(unset — using code default)",
        codeDefault: "gemini-2.5-pro",
        recommendation: "Use gemini-2.5-pro for quality, gemini-2.5-flash for 3x faster cheaper. Avoid *-preview / *-exp — they 503 under load.",
        stable: stableModels.map(slim),
        preview: previewModels.map(slim),
        totalAccessible: generationCapable.length,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Meta token health check ────────────────────────────────────────────
  // ─── Meta page-subscription audit ───────────────────────────────────────
  // GET ?action=meta-pages-check → for each page our SYSTEM_USER token has
  //   access to, fetches the subscribed_apps list and shows whether our
  //   app is subscribed to the "leadgen" field. This catches the case where
  //   Meta auto-unsubscribes a page after our webhook returned consecutive
  //   5xx errors (which is what happened May 7 when ingest broke briefly
  //   on the new Resubmission fields). If a page shows leadgen=false,
  //   re-subscribe via Meta Business Manager → Page → Apps.
  if (req.method === "GET" && req.query.action === "meta-pages-check") {
    const token = process.env.META_PAGE_ACCESS_TOKEN || "";
    if (!token) return res.status(500).json({ verdict: "MISSING_TOKEN", error: "META_PAGE_ACCESS_TOKEN not set" });
    try {
      // /me/accounts works for SYSTEM_USER tokens — returns ALL pages
      // the system user has admin access to. If empty, the token's
      // permissions are wrong.
      const accountsRes = await fetch(
        `https://graph.facebook.com/v19.0/me/accounts?access_token=${encodeURIComponent(token)}&fields=id,name,access_token&limit=200`,
      );
      const accountsBody = await accountsRes.json();
      if (!accountsRes.ok || accountsBody.error) {
        return res.status(200).json({
          verdict: "ACCOUNTS_FAILED",
          status: accountsRes.status,
          error: accountsBody.error || (await accountsRes.text()).slice(0, 300),
          hint: "If error code 100 'nonexisting field accounts', the token isn't a System User token with the right scopes — needs ads_management + leads_retrieval + pages_show_list.",
        });
      }
      const pages = (accountsBody.data || []) as Array<{ id: string; name: string; access_token?: string }>;
      if (!pages.length) {
        return res.status(200).json({
          verdict: "NO_PAGES",
          message: "Token is valid but has access to ZERO pages. Re-issue a System User token with the right page assignments.",
        });
      }

      // For each page, query its subscribed_apps list
      const results: any[] = [];
      for (const p of pages.slice(0, 30)) {
        const pageToken = p.access_token || token;
        try {
          const sr = await fetch(
            `https://graph.facebook.com/v19.0/${p.id}/subscribed_apps?access_token=${encodeURIComponent(pageToken)}`,
          );
          const sb = await sr.json();
          const apps = (sb?.data || []) as any[];
          results.push({
            page_id: p.id,
            page_name: p.name,
            apps_subscribed: apps.length,
            our_app_subscribed: apps.length > 0,
            leadgen_subscribed: apps.some((a) => (a.subscribed_fields || []).includes("leadgen")),
            apps: apps.map((a) => ({
              app_id: a.id,
              app_name: a.name,
              subscribed_fields: a.subscribed_fields || [],
            })),
            error: sb?.error || null,
          });
        } catch (e: any) {
          results.push({ page_id: p.id, page_name: p.name, error: e.message });
        }
      }

      const fullySubscribed = results.filter((r) => r.leadgen_subscribed);
      const missingLeadgen = results.filter((r) => !r.leadgen_subscribed && !r.error);
      return res.status(200).json({
        verdict: missingLeadgen.length > 0 ? "SOME_PAGES_MISSING_LEADGEN" : "ALL_OK",
        token_scopes_remind: "Token needs: ads_management, leads_retrieval, pages_show_list, pages_manage_metadata",
        pages_checked: results.length,
        pages_with_leadgen: fullySubscribed.length,
        pages_missing_leadgen: missingLeadgen.length,
        fix_action: missingLeadgen.length > 0
          ? "Re-subscribe via Meta Business Manager → Pages → [Page] → Apps → ASBL CRM app → toggle leadgen on. Or via API: POST /{page-id}/subscribed_apps?subscribed_fields=leadgen with the page access_token."
          : null,
        details: results,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Meta recent-leads pull ───────────────────────────────────────────────
  // GET ?action=meta-recent-leads&days=N
  //   For each subscribed page, lists ALL lead-form submissions Meta has on
  //   record in the last N days (default 7). Compares against our Zoho.
  //   If Meta has leads but we don't → webhook delivery failed silently,
  //   and we can backfill by replaying these leadgen IDs through ingest.
  if (req.method === "GET" && req.query.action === "meta-recent-leads") {
    const token = process.env.META_PAGE_ACCESS_TOKEN || "";
    if (!token) return res.status(500).json({ error: "META_PAGE_ACCESS_TOKEN not set" });
    const days = Math.max(1, Math.min(90, Number(req.query.days || 7)));
    const sinceUnix = Math.floor((Date.now() - days * 86400_000) / 1000);
    try {
      // Get pages
      const ar = await fetch(
        `https://graph.facebook.com/v19.0/me/accounts?access_token=${encodeURIComponent(token)}&fields=id,name,access_token`,
      );
      const ab = await ar.json();
      const pages = (ab?.data || []) as Array<{ id: string; name: string; access_token?: string }>;

      const summary: any[] = [];
      const allLeads: any[] = [];
      for (const p of pages) {
        const pageToken = p.access_token || token;
        // Get all forms on this page
        const fr = await fetch(
          `https://graph.facebook.com/v19.0/${p.id}/leadgen_forms?access_token=${encodeURIComponent(pageToken)}&fields=id,name,status,leads_count&limit=50`,
        );
        const fb = await fr.json();
        const forms = (fb?.data || []) as Array<{ id: string; name: string; status: string; leads_count: number }>;

        const pageLeads: any[] = [];
        for (const form of forms.slice(0, 30)) {
          // Get leads created in last `days` days
          const lr = await fetch(
            `https://graph.facebook.com/v19.0/${form.id}/leads?access_token=${encodeURIComponent(pageToken)}&fields=id,created_time,field_data&filtering=[{"field":"time_created","operator":"GREATER_THAN","value":${sinceUnix}}]&limit=200`,
          );
          const lb = await lr.json();
          const leads = (lb?.data || []) as any[];
          for (const lead of leads) {
            const phone = (lead.field_data || []).find((f: any) =>
              /phone/i.test(f.name || ""),
            )?.values?.[0] || "";
            pageLeads.push({
              leadgen_id: lead.id,
              created_time: lead.created_time,
              form_id: form.id,
              form_name: form.name,
              phone,
            });
          }
        }
        summary.push({
          page_id: p.id,
          page_name: p.name,
          forms_count: forms.length,
          leads_in_window: pageLeads.length,
          forms: forms.map((f) => ({
            id: f.id, name: f.name, status: f.status, leads_count: f.leads_count,
          })),
        });
        allLeads.push(...pageLeads.map((l) => ({ ...l, page_name: p.name })));
      }

      return res.status(200).json({
        days_window: days,
        pages_checked: pages.length,
        total_leads_on_meta: allLeads.length,
        summary,
        recent_leads: allLeads.sort((a, b) =>
          String(b.created_time).localeCompare(String(a.created_time)),
        ).slice(0, 50),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // GET ?action=meta-deep-diag&secret=<INHOUSE_POSTHOOK_SECRET>
  //   Deep Meta diagnostic — finds where lead forms actually live.
  //   When the page-level `/leadgen_forms` returns 0 but ads are running,
  //   the forms are usually at the AD ACCOUNT level (created via Ads
  //   Manager's inline "create new form" flow). This endpoint:
  //     1. Lists every page the token has access to
  //     2. Lists every ad account the token has access to
  //     3. For each ad account, lists its lead forms
  //     4. Lists active ads with Lead Generation objective and the
  //        form IDs they're using
  //     5. Cross-references against our META_FORM_IDS_ALLOWLIST so we
  //        can see which incoming forms would be silently dropped
  //   Critical for debugging "ads running but no leads in Zoho" cases.
  if (req.method === "GET" && req.query.action === "meta-deep-diag") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    const metaToken = process.env.META_PAGE_ACCESS_TOKEN || "";
    if (!metaToken || metaToken === "REPLACE_WITH_YOUR_PAGE_ACCESS_TOKEN") {
      return res.status(500).json({ error: "META_PAGE_ACCESS_TOKEN not configured" });
    }

    const allowlistRaw = process.env.META_FORM_IDS_ALLOWLIST || "";
    const allowlist = allowlistRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const allowSet = new Set(allowlist);

    type FormSummary = {
      id: string;
      name: string;
      status?: string;
      created_time?: string;
      page_id?: string;
      page_name?: string;
      ad_account_id?: string;
      in_allowlist: boolean;
    };
    const allFoundForms: FormSummary[] = [];

    const fetchJson = async (url: string): Promise<any> => {
      try {
        const r = await fetch(url);
        const data = await r.json();
        if (!r.ok || data?.error) {
          return { __error: data?.error?.message || `HTTP ${r.status}`, __status: r.status };
        }
        return data;
      } catch (err: any) {
        return { __error: err.message };
      }
    };

    // 1. List pages this token has access to (could be more than just the
    //    one we hardcoded — System User tokens often span multiple pages).
    const pagesData = await fetchJson(
      `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token&limit=50&access_token=${encodeURIComponent(metaToken)}`,
    );
    const pages = (pagesData?.data || []) as any[];

    // 2. List ad accounts this token has access to.
    const adAccountsData = await fetchJson(
      `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_id,account_status&limit=100&access_token=${encodeURIComponent(metaToken)}`,
    );
    const adAccounts = (adAccountsData?.data || []) as any[];

    // 3. For each page, list page-level lead forms.
    const pageFormsResults: Array<{
      page_id: string;
      page_name: string;
      forms_count: number;
      forms: FormSummary[];
      error?: string;
    }> = [];

    for (const page of pages) {
      const pageToken = page.access_token || metaToken;
      const formsData = await fetchJson(
        `https://graph.facebook.com/v19.0/${page.id}/leadgen_forms?fields=id,name,status,created_time&limit=100&access_token=${encodeURIComponent(pageToken)}`,
      );
      if (formsData?.__error) {
        pageFormsResults.push({
          page_id: page.id,
          page_name: page.name,
          forms_count: 0,
          forms: [],
          error: formsData.__error,
        });
        continue;
      }
      const forms = ((formsData?.data || []) as any[]).map((f) => {
        const summary: FormSummary = {
          id: f.id,
          name: f.name,
          status: f.status,
          created_time: f.created_time,
          page_id: page.id,
          page_name: page.name,
          in_allowlist: allowSet.has(f.id),
        };
        allFoundForms.push(summary);
        return summary;
      });
      pageFormsResults.push({
        page_id: page.id,
        page_name: page.name,
        forms_count: forms.length,
        forms,
      });
    }

    // 4. For each ad account, list ad-account-level lead forms (this is
    //    the path Ads Manager uses when you "create new form" inline).
    const adAccountFormsResults: Array<{
      ad_account_id: string;
      ad_account_name: string;
      forms_count: number;
      forms: FormSummary[];
      error?: string;
    }> = [];

    for (const acct of adAccounts.slice(0, 10)) {
      const acctId = acct.id; // already prefixed "act_..."
      const formsData = await fetchJson(
        `https://graph.facebook.com/v19.0/${acctId}/leadgen_forms?fields=id,name,status,created_time,page&limit=100&access_token=${encodeURIComponent(metaToken)}`,
      );
      if (formsData?.__error) {
        adAccountFormsResults.push({
          ad_account_id: acctId,
          ad_account_name: acct.name,
          forms_count: 0,
          forms: [],
          error: formsData.__error,
        });
        continue;
      }
      const forms = ((formsData?.data || []) as any[]).map((f) => {
        const summary: FormSummary = {
          id: f.id,
          name: f.name,
          status: f.status,
          created_time: f.created_time,
          ad_account_id: acctId,
          page_id: f.page?.id,
          page_name: f.page?.name,
          in_allowlist: allowSet.has(f.id),
        };
        allFoundForms.push(summary);
        return summary;
      });
      adAccountFormsResults.push({
        ad_account_id: acctId,
        ad_account_name: acct.name,
        forms_count: forms.length,
        forms,
      });
    }

    // 5. List currently-active LEAD_GENERATION ads (the smoking gun — these
    //    are spending money RIGHT NOW and using a form we may not see).
    const activeLeadAds: Array<{
      ad_account_id: string;
      ad_id: string;
      ad_name: string;
      campaign_objective?: string;
      form_id?: string;
      form_in_allowlist?: boolean;
      running_page_id?: string;
      running_page_in_token_scope?: boolean;
    }> = [];

    for (const acct of adAccounts.slice(0, 5)) {
      const acctId = acct.id;
      // Only ACTIVE ads, with creative.lead_form details + the page_id the
      // ad is running from. The page_id is critical: if it differs from
      // the page our token has access to, we've found the smoking gun.
      const adsData = await fetchJson(
        `https://graph.facebook.com/v19.0/${acctId}/ads?fields=id,name,effective_status,campaign{objective},creative{object_story_spec{page_id,link_data{call_to_action{value}}}}&effective_status=["ACTIVE"]&limit=50&access_token=${encodeURIComponent(metaToken)}`,
      );
      if (adsData?.__error) continue;
      const ads = (adsData?.data || []) as any[];
      for (const ad of ads) {
        const formId = ad?.creative?.object_story_spec?.link_data?.call_to_action?.value?.lead_gen_form_id;
        const adRunningPageId = ad?.creative?.object_story_spec?.page_id;
        if (formId) {
          activeLeadAds.push({
            ad_account_id: acctId,
            ad_id: ad.id,
            ad_name: ad.name,
            campaign_objective: ad?.campaign?.objective,
            form_id: String(formId),
            form_in_allowlist: allowSet.has(String(formId)),
            running_page_id: adRunningPageId ? String(adRunningPageId) : undefined,
            running_page_in_token_scope: adRunningPageId
              ? pages.some((p) => p.id === String(adRunningPageId))
              : undefined,
          } as any);
        }
      }
    }

    // 6. CRITICAL — for each page, check webhook subscription using the
    //    PAGE-level access token (not the System User token). Also resolve
    //    each active ad's form ID directly to see if our token can read
    //    the form metadata. This is the actual smoking gun for "leads not
    //    arriving" cases.
    const subscriptionResults: Array<{
      page_id: string;
      page_name: string;
      subscribed_to_leadgen: boolean;
      subscribed_apps: any[];
      error?: string;
    }> = [];

    for (const page of pages) {
      const pageToken = page.access_token || metaToken;
      const subData = await fetchJson(
        `https://graph.facebook.com/v19.0/${page.id}/subscribed_apps?access_token=${encodeURIComponent(pageToken)}`,
      );
      if (subData?.__error) {
        subscriptionResults.push({
          page_id: page.id,
          page_name: page.name,
          subscribed_to_leadgen: false,
          subscribed_apps: [],
          error: subData.__error,
        });
        continue;
      }
      const apps = (subData?.data || []) as any[];
      const slim = apps.map((a) => ({
        id: a.id,
        name: a.name,
        subscribed_fields: a.subscribed_fields || [],
        has_leadgen: (a.subscribed_fields || []).includes("leadgen"),
      }));
      subscriptionResults.push({
        page_id: page.id,
        page_name: page.name,
        subscribed_to_leadgen: slim.some((a) => a.has_leadgen),
        subscribed_apps: slim,
      });
    }

    // 7. Probe each ACTIVE form ID directly. If our token can't read it,
    //    even an incoming webhook payload would fail when we try to fetch
    //    field_data via /leadgen_id?fields=field_data.
    const formProbes: Array<{
      form_id: string;
      readable: boolean;
      name?: string;
      status?: string;
      page_id?: string;
      error?: string;
    }> = [];
    const uniqueFormIds = [...new Set(activeLeadAds.map((a) => a.form_id).filter(Boolean) as string[])];
    for (const fid of uniqueFormIds) {
      const probe = await fetchJson(
        `https://graph.facebook.com/v19.0/${fid}?fields=id,name,status,page&access_token=${encodeURIComponent(metaToken)}`,
      );
      if (probe?.__error) {
        formProbes.push({ form_id: fid, readable: false, error: probe.__error });
      } else {
        formProbes.push({
          form_id: fid,
          readable: true,
          name: probe.name,
          status: probe.status,
          page_id: probe.page?.id,
        });
        // Also enrich allFoundForms so summary reflects what we can actually read
        allFoundForms.push({
          id: fid,
          name: probe.name || `(form ${fid})`,
          status: probe.status,
          page_id: probe.page?.id,
          page_name: probe.page?.name,
          in_allowlist: allowSet.has(fid),
        });
      }
    }

    // 8. AUTO-FIX option — if ?fix=1 is passed AND a page is missing leadgen
    //    subscription, attempt to subscribe it. Most common root cause when
    //    a fresh System User token is rotated without re-subscribing.
    const fixRequested = String(req.query.fix || "") === "1";
    const subscriptionFixes: Array<{
      page_id: string;
      page_name: string;
      attempted: boolean;
      success: boolean;
      response?: any;
    }> = [];
    if (fixRequested) {
      for (const sub of subscriptionResults) {
        if (sub.subscribed_to_leadgen) continue;
        const page = pages.find((p) => p.id === sub.page_id);
        if (!page) continue;
        const pageToken = page.access_token || metaToken;
        try {
          const r = await fetch(
            `https://graph.facebook.com/v19.0/${page.id}/subscribed_apps?subscribed_fields=leadgen&access_token=${encodeURIComponent(pageToken)}`,
            { method: "POST" },
          );
          const j = await r.json().catch(() => ({}));
          subscriptionFixes.push({
            page_id: page.id,
            page_name: page.name,
            attempted: true,
            success: r.ok && (j as any)?.success === true,
            response: j,
          });
        } catch (err: any) {
          subscriptionFixes.push({
            page_id: page.id,
            page_name: page.name,
            attempted: true,
            success: false,
            response: { error: err.message },
          });
        }
      }
    }

    // Summary verdict
    const totalFormsFound = allFoundForms.length;
    const formsInAllowlist = allFoundForms.filter((f) => f.in_allowlist).length;
    const activeAdsWithUnseenForms = activeLeadAds.filter(
      (ad) => ad.form_id && !allFoundForms.some((f) => f.id === ad.form_id),
    );

    const diagnosis: string[] = [];
    if (!pages.length) diagnosis.push("Token has access to ZERO pages — it may be a user token, not a page/system-user token.");
    if (!adAccounts.length) diagnosis.push("Token has access to ZERO ad accounts — it can't see ad-account-level forms. May need 'ads_management' permission.");
    if (totalFormsFound === 0) diagnosis.push("No lead forms found at page OR ad-account level — but if ads are running, leads are being captured somewhere we can't see. Check Meta Business Manager → Lead Center → CRM Integration to find them.");
    if (allowlist.length && formsInAllowlist === 0 && totalFormsFound > 0) diagnosis.push(`META_FORM_IDS_ALLOWLIST is set (${allowlist.length} IDs) but NONE match the forms found. All incoming leads will be silently dropped! Either clear the env var, or update it to match.`);
    if (activeAdsWithUnseenForms.length) diagnosis.push(`${activeAdsWithUnseenForms.length} active ads use form IDs that are NOT in our visible-forms list. Token doesn't see those forms.`);
    if (!diagnosis.length) diagnosis.push("No obvious config issue detected — leads should be flowing if forms are subscribed to our webhook.");

    // Re-compute diagnosis with new info (subscription + form probes)
    const pagesWithoutLeadgen = subscriptionResults.filter((s) => !s.subscribed_to_leadgen);
    const unreadableForms = formProbes.filter((p) => !p.readable);
    if (pagesWithoutLeadgen.length) {
      diagnosis.unshift(
        `🚨 CRITICAL: ${pagesWithoutLeadgen.length} page(s) NOT subscribed to 'leadgen' webhook ` +
        `(${pagesWithoutLeadgen.map((s) => s.page_name).join(", ")}). ` +
        `New leads from these pages WILL NOT reach our endpoint. ` +
        `Re-run with &fix=1 to auto-subscribe.`,
      );
    }
    if (unreadableForms.length) {
      diagnosis.push(
        `${unreadableForms.length} active form ID(s) cannot be read with this token: ` +
        `${unreadableForms.map((p) => `${p.form_id} (${p.error})`).join("; ")}. ` +
        `Even if webhooks fire, fetching field_data will fail.`,
      );
    }

    return res.status(200).json({
      summary: {
        pages_visible: pages.length,
        ad_accounts_visible: adAccounts.length,
        total_forms_found: totalFormsFound,
        forms_in_allowlist: formsInAllowlist,
        active_lead_ads_found: activeLeadAds.length,
        active_ads_with_unseen_forms: activeAdsWithUnseenForms.length,
        pages_subscribed_to_leadgen: subscriptionResults.filter((s) => s.subscribed_to_leadgen).length,
        active_forms_readable: formProbes.filter((p) => p.readable).length,
        active_forms_unreadable: formProbes.filter((p) => !p.readable).length,
        fix_attempted: fixRequested,
      },
      diagnosis,
      allowlist: { configured: !!allowlist.length, count: allowlist.length },
      pages: pages.map((p) => ({ id: p.id, name: p.name })),
      ad_accounts: adAccounts.map((a) => ({ id: a.id, name: a.name, status: a.account_status })),
      page_level_forms: pageFormsResults,
      ad_account_level_forms: adAccountFormsResults,
      active_lead_ads: activeLeadAds,
      webhook_subscriptions: subscriptionResults,
      active_form_probes: formProbes,
      subscription_fixes: subscriptionFixes,
    });
  }

  // GET ?action=meta-token-check → introspects META_PAGE_ACCESS_TOKEN via
  // Graph API debug_token + /me, returns expiry, app_id, granted scopes,
  // and a clear OK / EXPIRED / INVALID verdict.
  if (req.method === "GET" && req.query.action === "meta-token-check") {
    const token = process.env.META_PAGE_ACCESS_TOKEN || "";
    if (!token || token === "REPLACE_WITH_YOUR_PAGE_ACCESS_TOKEN") {
      return res.status(500).json({ verdict: "MISSING", error: "META_PAGE_ACCESS_TOKEN not set in Vercel env" });
    }
    try {
      // 1. /me — fastest token-validity probe
      const meRes = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${encodeURIComponent(token)}`);
      const meBody = await meRes.json();
      if (!meRes.ok || meBody.error) {
        const errCode = meBody?.error?.code;
        const errSub = meBody?.error?.error_subcode;
        const errMsg = meBody?.error?.message || "unknown";
        const verdict = errCode === 190 ? "EXPIRED_OR_INVALID" : "ERROR";
        return res.status(200).json({
          verdict,
          httpStatus: meRes.status,
          error: { code: errCode, subcode: errSub, message: errMsg },
          hint: errCode === 190
            ? "Meta token expired or revoked. Generate a new long-lived Page Access Token (System User recommended for permanence)."
            : null,
        });
      }
      // 2. debug_token — shows expiry, type, scopes
      let debug: any = null;
      try {
        const dRes = await fetch(`https://graph.facebook.com/v19.0/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`);
        const dBody = await dRes.json();
        if (dBody?.data) {
          const d = dBody.data;
          const expiresAt = d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null;
          const dataAccessExpiresAt = d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000).toISOString() : null;
          const isExpired = d.expires_at && d.expires_at * 1000 < Date.now();
          debug = {
            isValid: !!d.is_valid,
            type: d.type,
            appId: d.app_id,
            userId: d.user_id,
            scopes: d.scopes,
            expiresAt,
            dataAccessExpiresAt,
            isExpired,
            issuedAt: d.issued_at ? new Date(d.issued_at * 1000).toISOString() : null,
          };
        }
      } catch {}
      // 3. Page subscribed_apps — verifies Meta still has us subscribed for
      //    the leadgen field on this page. If we're NOT in this list, leads
      //    will stop coming even though the token is valid.
      let subscribedApps: any = null;
      try {
        const sRes = await fetch(
          `https://graph.facebook.com/v19.0/${meBody.id}/subscribed_apps?access_token=${encodeURIComponent(token)}`
        );
        const sBody = await sRes.json();
        if (sBody?.data) {
          subscribedApps = sBody.data.map((app: any) => ({
            id: app.id,
            name: app.name,
            link: app.link,
            subscribed_fields: app.subscribed_fields || [],
            has_leadgen: (app.subscribed_fields || []).includes("leadgen"),
          }));
        } else if (sBody?.error) {
          subscribedApps = { error: sBody.error };
        }
      } catch (e: any) {
        subscribedApps = { error: e.message };
      }

      // 4. Form-allowlist info — if env var is set, show how many forms
      //    pass through and whether incoming forms might be silently dropped.
      const allowlistRaw = process.env.META_FORM_IDS_ALLOWLIST || "";
      const allowlist = {
        configured: !!allowlistRaw,
        count: allowlistRaw ? allowlistRaw.split(",").filter(Boolean).length : 0,
        sample: allowlistRaw.split(",").map((s: string) => s.trim()).filter(Boolean).slice(0, 3),
      };

      return res.status(200).json({
        verdict: "OK",
        page: { id: meBody.id, name: meBody.name },
        debug,
        subscribed_apps: subscribedApps,
        form_allowlist: allowlist,
      });
    } catch (err: any) {
      return res.status(500).json({ verdict: "FETCH_ERROR", error: err.message });
    }
  }

  // ─── Test Gemini directly (no Periskope/Zoho side effects) ─────────────
  // POST { project, message, customerName?, history? } → returns the same
  // structured Gemini reply the live bot would produce. Useful for verifying
  // KB / offer / inventory grounding after upload.
  if (req.method === "POST" && req.query.action === "test-gemini") {
    const t0 = Date.now();
    try {
      const body = (req.body || {}) as any;
      const project = String(body.project || "LOFT").toUpperCase();
      const message = String(body.message || "").trim();
      const customerName = String(body.customerName || "Test User");
      const history = String(body.history || "no prior conversation");

      if (!message) return res.status(400).json({ error: "message required" });
      if (!KNOWN_PROJECTS.includes(project as any)) {
        return res.status(400).json({ error: `Unknown project: ${project}` });
      }

      // Build PROJECT_CONTEXT exactly like the webhook does
      const parts: string[] = [];
      const facts = await getProjectFacts(project);
      if ((facts as any)?.kb_text?.trim()) {
        parts.push("## PROJECT KNOWLEDGE BASE");
        parts.push((facts as any).kb_text.trim());
      }
      if (facts?.facts_text?.trim()) {
        if (parts.length) parts.push("");
        parts.push("## OFFER DETAILS (manually curated, authoritative for offers/schemes)");
        parts.push(facts.facts_text.trim());
      }
      try {
        const inv = await getInventoryForProject(project);
        if (inv.markdown) {
          if (parts.length) parts.push("");
          parts.push("## CURRENT INVENTORY & PRICING (live from sales sheet)");
          parts.push(inv.markdown);
        }
      } catch {}
      const projectContext = parts.join("\n").trim() || `No KB / inventory available for ${project} yet.`;

      const structuredMessage = [
        `<CUSTOMER>`,
        `Name: ${customerName}`,
        `Phone: 91XXXXXXXX (test)`,
        `</CUSTOMER>`,
        ``,
        `<CURRENT_PROJECT>${project}</CURRENT_PROJECT>`,
        `<LAST_PROJECT>none</LAST_PROJECT>`,
        `<DAYS_SINCE_LAST>first time</DAYS_SINCE_LAST>`,
        ``,
        `<PROJECT_CONTEXT>`,
        projectContext,
        `</PROJECT_CONTEXT>`,
        ``,
        `<CONVERSATION_HISTORY>`,
        history,
        `</CONVERSATION_HISTORY>`,
        ``,
        `<USER_MESSAGE>`,
        message,
        `</USER_MESSAGE>`,
      ].join("\n");

      const reply = await callGemini(structuredMessage, { enableGrounding: false });

      // Apply the same post-processing the production webhook does so this
      // endpoint reflects what the customer would actually see.
      const { sanitizeReply, stripReintroduction } = await import("./_utils/sanitizer");
      const hasHistoryFlag =
        history !== "no prior conversation" && /\byou:\s/.test(history);
      const sanitized = stripReintroduction(sanitizeReply(reply.reply), hasHistoryFlag);

      return res.status(200).json({
        ok: true,
        project,
        message,
        elapsedMs: Date.now() - t0,
        contextSize: projectContext.length,
        hasHistory: hasHistoryFlag,
        gemini: { ...reply, reply_raw: reply.reply, reply: sanitized },
      });
    } catch (err: any) {
      console.error(`[test-gemini] failed: ${err.message}`);
      return res.status(500).json({ error: err.message, elapsedMs: Date.now() - t0 });
    }
  }

  // ─── Step 1 of the large-file upload flow: get a signed upload URL ──────
  // POST { project, doc_type, filename, size_label?, is_kb? }
  //   → { uploadPath, token, storagePath, publicUrl }
  // The browser then PUTs the file directly to `uploadPath`, bypassing
  // Vercel's 4.5 MB request body limit. After upload, browser calls
  // ?action=upload-finalize with the storagePath to record the metadata.
  if (req.method === "POST" && req.query.action === "upload-sign") {
    try {
      const body = req.body as any;
      const project = String(body.project || "").toUpperCase();
      const isKb = !!body.is_kb;
      const docType = isKb ? "kb_source" : String(body.doc_type || "").toLowerCase();
      const filename = String(body.filename || "upload");
      const sizeLabel = body.size_label ? String(body.size_label) : null;

      // v5 strict-meta fields — validate shape so the upload-finalize step
      // can persist them without re-doing validation.
      const unitSizeSftRaw = body.unit_size_sft;
      const facingRaw = body.facing ? String(body.facing).toLowerCase() : null;
      const towerRaw = body.tower ? String(body.tower).trim() : null;

      if (!KNOWN_PROJECTS.includes(project as any)) {
        return res.status(400).json({ error: `Unknown project: ${project}` });
      }
      if (!isKb) {
        const VALID = ["master_plan", "floor_plan", "unit_plan", "price_sheet", "payment_structure", "brochure", "specifications", "amenities"];
        if (!VALID.includes(docType)) return res.status(400).json({ error: `Unknown doc_type: ${docType}` });
        // Multi-slot doc types need a label so the bot can pick the right one
        if ((docType === "unit_plan" || docType === "floor_plan") && !sizeLabel) {
          return res.status(400).json({ error: `size_label required for ${docType} (e.g. "Tower A" / "1695 East")` });
        }
        // unit_plan also requires strict size_sft + facing so v5 doc_meta matches
        if (docType === "unit_plan") {
          const n = typeof unitSizeSftRaw === "number" ? unitSizeSftRaw : parseInt(String(unitSizeSftRaw), 10);
          if (!isFinite(n) || n < 100 || n > 100000) {
            return res.status(400).json({ error: `unit_plan: unit_size_sft (integer 100-100000) required for v5 strict lookup` });
          }
          const VALID_FACING = ["east", "west", "north", "south", "north_east", "north_west", "south_east", "south_west"];
          if (!facingRaw || !VALID_FACING.includes(facingRaw)) {
            return res.status(400).json({ error: `unit_plan: facing required (${VALID_FACING.join(", ")})` });
          }
        }
      }

      const signed = await createSignedUploadUrl({ project, docType, filename, sizeLabel });
      return res.status(200).json({ ok: true, ...signed });
    } catch (err: any) {
      console.error(`[upload-sign] failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Step 2: finalize the upload (after browser has PUT the file) ───────
  // POST { project, filename, mimetype, storage_path, public_url, is_kb,
  //        doc_type?, size_label? }
  // For KB uploads: downloads the file from Supabase, extracts text,
  // saves to project_facts.kb_text. For docs: just inserts a project_documents row.
  if (req.method === "POST" && req.query.action === "upload-finalize") {
    try {
      const body = req.body as any;
      const project = String(body.project || "").toUpperCase();
      const filename = String(body.filename || "");
      const mimeType = String(body.mimetype || "application/octet-stream");
      const storagePath = String(body.storage_path || "");
      const publicUrl = String(body.public_url || "");
      const isKb = !!body.is_kb;

      if (!KNOWN_PROJECTS.includes(project as any)) {
        return res.status(400).json({ error: `Unknown project: ${project}` });
      }
      if (!storagePath) return res.status(400).json({ error: "storage_path required" });

      if (isKb) {
        // Download + extract text
        const buf = await downloadFromStorage(storagePath);
        let extractedText = "";
        if (mimeType === "text/plain" || filename.toLowerCase().endsWith(".txt")) {
          extractedText = buf.toString("utf-8");
        } else if (mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
          extractedText = await extractTextFromPDF(buf);
          if (!extractedText) {
            return res.status(400).json({ error: "PDF text extraction returned empty (image-only PDF?)" });
          }
        } else {
          return res.status(400).json({ error: `Unsupported mimetype: ${mimeType}` });
        }
        const saveRes = await saveProjectKb(project, extractedText, publicUrl);
        if (!saveRes.ok) return res.status(500).json({ error: `Save failed: ${saveRes.error}` });
        return res.status(200).json({ ok: true, project, extractedChars: extractedText.length, publicUrl });
      }

      // Document upload: just insert the row
      const docType = String(body.doc_type || "").toLowerCase();
      const sizeLabel = body.size_label ? String(body.size_label) : null;
      const VALID = ["master_plan", "floor_plan", "unit_plan", "price_sheet", "payment_structure", "brochure", "specifications", "amenities"];
      if (!VALID.includes(docType)) return res.status(400).json({ error: `Unknown doc_type: ${docType}` });

      // Extract text from the just-uploaded PDF so the bot can use it as
      // a fallback KB source when project_facts.kb_text doesn't have an
      // answer. Best-effort — if extraction fails we still record the row.
      let textExtract = "";
      try {
        if (mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
          const buf = await downloadFromStorage(storagePath);
          textExtract = await extractTextFromPDF(buf);
        }
      } catch (err: any) {
        console.warn(`[upload-finalize] PDF text extract failed: ${err.message}`);
      }

      // v5 strict-meta — persist whatever the form supplied. Validation
      // already happened in upload-sign so we just coerce types here.
      const unitSizeSftRaw = body.unit_size_sft;
      const unitSizeSft =
        typeof unitSizeSftRaw === "number"
          ? unitSizeSftRaw
          : (unitSizeSftRaw != null && unitSizeSftRaw !== ""
              ? parseInt(String(unitSizeSftRaw), 10)
              : null);
      const facingRaw = body.facing ? String(body.facing).toLowerCase().trim() : null;
      const towerRaw = body.tower ? String(body.tower).trim() : null;

      const insertBody: any = { project, doc_type: docType, filename, url: publicUrl };
      if (sizeLabel) insertBody.size_label = sizeLabel;
      if (unitSizeSft != null && isFinite(unitSizeSft) && unitSizeSft >= 100) {
        insertBody.unit_size_sft = unitSizeSft;
      }
      if (facingRaw) insertBody.facing = facingRaw;
      if (towerRaw) insertBody.tower = towerRaw;
      if (textExtract) {
        // Cap each PDF's extract at 8000 chars so even 8 doc types per project
        // stay under Gemini's effective input budget when bundled into context.
        insertBody.text_extract = textExtract.slice(0, 8000);
        insertBody.text_extract_chars = textExtract.length;
        insertBody.text_extracted_at = new Date().toISOString();
      }

      const insRes = await fetch(`${SUPABASE_URL}/rest/v1/project_documents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "return=representation",
        },
        body: JSON.stringify(insertBody),
      });
      if (!insRes.ok) {
        return res.status(500).json({ error: `DB insert failed: ${(await insRes.text()).slice(0, 200)}` });
      }
      return res.status(200).json({
        ok: true,
        project, docType, sizeLabel, publicUrl,
        text_extracted: !!textExtract,
        text_extract_chars: textExtract.length,
        record: await insRes.json(),
      });
    } catch (err: any) {
      console.error(`[upload-finalize] failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Save the bot's Gemini system prompt (live — no redeploy needed) ────
  if (req.method === "POST" && req.query.action === "save-prompt") {
    const body = parseFormBody(req.body);
    const prompt = String(body.prompt || "");
    if (prompt.trim().length < 200) {
      return res.status(400).send("Prompt is too short (must be > 200 chars).");
    }
    const result = await setBotSetting("system_prompt", prompt);
    if (!result.ok) {
      res.setHeader("Location", `?view=edit-prompt&msg=${encodeURIComponent("Save failed: " + result.error)}`);
    } else {
      res.setHeader("Location", `?view=edit-prompt&msg=${encodeURIComponent("Saved (" + (prompt.length / 1024).toFixed(1) + " KB). The bot will use this prompt on the next message.")}`);
    }
    return res.status(303).end();
  }

  // ─── Toggle PDF extracts as fallback KB source ─────────────────────────
  // POST ?action=set-pdf-extracts&value=on|off
  // Stored in bot_settings.use_pdf_extracts ("true" / "false"). Default = true.
  if (req.method === "POST" && req.query.action === "set-pdf-extracts") {
    const value = String(req.query.value || "").toLowerCase() === "off" ? "false" : "true";
    await setBotSetting("use_pdf_extracts", value);
    res.setHeader("Location", `?view=dashboard`);
    return res.status(303).end();
  }

  // ─── Backfill text_extract for already-uploaded PDFs ────────────────────
  // POST ?action=backfill-pdf-extracts&secret=<INHOUSE_POSTHOOK_SECRET>
  // Iterates project_documents rows missing text_extract, downloads the file
  // from Supabase Storage, runs PDF text extraction, updates the row.
  if (req.method === "POST" && req.query.action === "backfill-pdf-extracts") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    try {
      // Find all PDF rows missing text_extract
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/project_documents?text_extract=is.null&select=id,project,doc_type,filename,url&limit=200`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = (await r.json()) as Array<any>;
      const results: any[] = [];
      for (const row of rows) {
        const url = String(row.url || "");
        const filename = String(row.filename || "");
        const isPdf = filename.toLowerCase().endsWith(".pdf") || url.toLowerCase().includes(".pdf");
        if (!isPdf) {
          results.push({ id: row.id, skipped: "not a pdf" });
          continue;
        }
        try {
          // Generic public-URL fetch — works for Supabase Storage AND legacy
          // AWS S3 (leads-test-public.s3.ap-south-1.amazonaws.com) URLs
          // that were registered before signed-upload flow existed.
          const fetchRes = await fetch(url);
          if (!fetchRes.ok) {
            results.push({ id: row.id, error: `fetch ${fetchRes.status} for ${url.slice(0, 80)}` });
            continue;
          }
          const ab = await fetchRes.arrayBuffer();
          const buf = Buffer.from(ab);
          let text = "";
          let extractErr = "";
          try {
            text = await extractTextFromPDF(buf);
          } catch (e: any) {
            extractErr = e?.message || String(e);
          }
          if (!text) {
            results.push({
              id: row.id,
              error: `extract returned empty (${extractErr || "no exception thrown"}) for ${url.slice(0, 100)}`,
            });
            continue;
          }
          await fetch(`${SUPABASE_URL}/rest/v1/project_documents?id=eq.${row.id}`, {
            method: "PATCH",
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({
              text_extract: text.slice(0, 8000),
              text_extract_chars: text.length,
              text_extracted_at: new Date().toISOString(),
            }),
          });
          results.push({ id: row.id, project: row.project, doc_type: row.doc_type, chars: text.length, ok: true });
        } catch (err: any) {
          results.push({ id: row.id, error: err.message });
        }
      }
      return res.status(200).json({ processed: results.length, results });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── MongoDB health probe ──────────────────────────────────────────────
  // GET /api/chat-history?action=mongo-diag&secret=<INHOUSE_POSTHOOK_SECRET>
  // Pings the Mongo cluster and lists collections in "Zoho Database".
  // Use this after adding MONGO_URI to Vercel env to confirm connectivity.
  if (req.query.action === "mongo-diag") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    try {
      const { ping, getCollection, COL } = await import("./_utils/mongo");
      const probe = await ping();
      // Also report per-collection counts so we can verify backfills landed
      const counts: Record<string, number> = {};
      if (probe.ok) {
        for (const cname of Object.values(COL)) {
          try {
            const c = await getCollection(cname);
            counts[cname] = await c.estimatedDocumentCount();
          } catch (err: any) {
            counts[cname] = -1;
          }
        }
      }
      return res.status(200).json({ ...probe, counts });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ─── Mongo backfill from Supabase (one-shot per collection) ────────────
  // POST /api/chat-history?action=mongo-backfill&collection=<name>&secret=<...>
  // Copies rows from the named Supabase table to its Mongo equivalent.
  // Idempotent — uses upsert keyed on the natural primary key per collection
  // so re-runs just refresh, never duplicate.
  if (req.method === "POST" && req.query.action === "mongo-backfill") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const collection = String(req.query.collection || "").toLowerCase();
    if (!collection) {
      return res.status(400).json({ error: "?collection=<name> required" });
    }
    try {
      const { getCollection, COL } = await import("./_utils/mongo");

      // ── bot_settings ────────────────────────────────────────────────────
      if (collection === "bot_settings") {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/bot_settings?select=key,value,updated_at&limit=500`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        if (!r.ok) {
          return res.status(500).json({ error: `Supabase fetch failed ${r.status}: ${(await r.text()).slice(0, 200)}` });
        }
        const rows = (await r.json()) as Array<{ key: string; value: string; updated_at: string }>;
        const col = await getCollection(COL.BOT_SETTINGS);
        let upserted = 0;
        for (const row of rows) {
          await col.updateOne(
            { _id: row.key } as any,
            {
              $set: { value: row.value, updated_at: row.updated_at || new Date().toISOString() },
              $setOnInsert: { _id: row.key as any },
            },
            { upsert: true },
          );
          upserted++;
        }
        return res.status(200).json({
          ok: true,
          collection: "bot_settings",
          scanned: rows.length,
          upserted,
          keys: rows.map((r) => r.key),
        });
      }

      // ── user_profiles ───────────────────────────────────────────────────
      if (collection === "user_profiles") {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/user_profiles?select=*&limit=10000`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        if (!r.ok) {
          return res.status(500).json({ error: `Supabase fetch failed ${r.status}: ${(await r.text()).slice(0, 200)}` });
        }
        const rows = (await r.json()) as Array<any>;
        const col = await getCollection(COL.USER_PROFILES);
        let upserted = 0;
        for (const row of rows) {
          const phone = String(row.phone || "").replace(/\D/g, "");
          if (!phone) continue;
          const doc = {
            _id: phone,
            phone,
            name: row.name ?? null,
            budget_cr: row.budget_cr === null || row.budget_cr === undefined ? null : Number(row.budget_cr),
            intent: row.intent ?? null,
            preferred_size_sft: row.preferred_size_sft ?? null,
            preferred_bhk: row.preferred_bhk === null || row.preferred_bhk === undefined ? null : Number(row.preferred_bhk),
            preferred_facing: row.preferred_facing ?? null,
            family_size: row.family_size ?? null,
            work_location: row.work_location ?? null,
            timeline: row.timeline ?? null,
            objections_raised: Array.isArray(row.objections_raised) ? row.objections_raised : [],
            commitments_made: Array.isArray(row.commitments_made) ? row.commitments_made : [],
            docs_sent: Array.isArray(row.docs_sent) ? row.docs_sent : [],
            preferred_language: row.preferred_language ?? null,
            current_project: row.current_project ?? null,
            last_project: row.last_project ?? null,
            last_interaction_at: row.last_interaction_at ?? null,
            funnel_stage: row.funnel_stage || "new",
            created_at: row.created_at ?? null,
            updated_at: row.updated_at ?? null,
          };
          await col.updateOne({ _id: phone as any }, { $set: doc as any }, { upsert: true });
          upserted++;
        }
        return res.status(200).json({
          ok: true, collection: "user_profiles", scanned: rows.length, upserted,
        });
      }

      // ── doc_send_log (append-only — no upsert, just insert) ────────────
      if (collection === "doc_send_log") {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/doc_send_log?select=*&order=created_at.asc&limit=10000`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        if (!r.ok) {
          return res.status(500).json({ error: `Supabase fetch failed ${r.status}: ${(await r.text()).slice(0, 200)}` });
        }
        const rows = (await r.json()) as Array<any>;
        const col = await getCollection(COL.DOC_SEND_LOG);
        // Dedupe by Supabase id so re-running doesn't double-insert. Use the
        // original id as _id (number → string).
        let upserted = 0;
        for (const row of rows) {
          const _id = row.id ? `sb_${row.id}` : undefined;
          if (!_id) continue;
          const doc = {
            _id,
            created_at: row.created_at,
            phone: row.phone,
            project: row.project,
            doc_type: row.doc_type,
            doc_meta: row.doc_meta,
            matched_url: row.matched_url,
            matched_file: row.matched_file,
            reply_text: row.reply_text,
            outcome: row.outcome,
            block_reason: row.block_reason,
            sizes_in_reply: row.sizes_in_reply || [],
          };
          await col.updateOne({ _id: _id as any }, { $set: doc as any }, { upsert: true });
          upserted++;
        }
        return res.status(200).json({
          ok: true, collection: "doc_send_log", scanned: rows.length, upserted,
        });
      }

      return res.status(400).json({
        error: `Unknown collection: ${collection}`,
        supported: ["bot_settings", "user_profiles", "doc_send_log"],
        note: "More collections added as each Phase ships.",
      });
    } catch (err: any) {
      console.error(`[mongo-backfill ${collection}] failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Backfill v5 strict columns from existing size_label text ──────────
  // GET/POST ?action=backfill-doc-meta&secret=<INHOUSE_POSTHOOK_SECRET>[&dry=1][&doc_type=unit_plan][&project=LOFT]
  //
  // For every project_documents row where (unit_size_sft / facing / tower)
  // are NULL but size_label contains parseable hints (e.g. "1695 East",
  // "Tower A 3BHK", "1870 west facing"), populate the strict cols. The v5
  // bot's doc_meta lookup is equality-only, so without this older rows
  // become invisible to it.
  //
  // Pass &dry=1 to preview without writing. The response includes per-row
  // outcome so you can audit which rows still need manual cleanup.
  if (req.query.action === "backfill-doc-meta") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    const dry = req.query.dry === "1" || req.query.dry === "true";
    const docTypeFilter = String(req.query.doc_type || "").toLowerCase();
    const projectFilter = String(req.query.project || "").toUpperCase();

    try {
      // Pull rows that are CANDIDATES for backfill:
      //   - at least one of (unit_size_sft, facing, tower) is null
      //   - size_label is not empty
      // Postgrest doesn't have an OR-of-is.null elegantly, so we just fetch
      // size_label-bearing rows and filter in-app — volume is manageable
      // (a few hundred rows max in production).
      const params: string[] = [
        `size_label=not.is.null`,
        `select=id,project,doc_type,size_label,unit_size_sft,facing,tower,filename`,
        `order=fetched_at.desc`,
        `limit=2000`,
      ];
      if (docTypeFilter) params.push(`doc_type=eq.${encodeURIComponent(docTypeFilter)}`);
      if (projectFilter) params.push(`project=eq.${encodeURIComponent(projectFilter)}`);

      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/project_documents?${params.join("&")}`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      if (!r.ok) {
        const t = await r.text();
        return res.status(500).json({ error: `fetch failed ${r.status}: ${t.slice(0, 200)}` });
      }
      const rows = (await r.json()) as Array<any>;

      const VALID_FACING = new Set([
        "east", "west", "north", "south",
        "north_east", "north_west", "south_east", "south_west",
      ]);

      // ── Parsers ────────────────────────────────────────────────────────
      const parseUnitSize = (text: string): number | null => {
        const m = text.match(/\b(\d{3,5})\s*(?:sft|sqft|sq\.?\s*ft)?\b/i);
        if (!m) return null;
        const n = parseInt(m[1], 10);
        return n >= 300 && n <= 10000 ? n : null;
      };
      const parseFacing = (text: string): string | null => {
        const t = text.toLowerCase();
        // Compound first to avoid double-matches
        if (/\b(north[\s_-]?east|ne[\s\b])/i.test(t)) return "north_east";
        if (/\b(north[\s_-]?west|nw[\s\b])/i.test(t)) return "north_west";
        if (/\b(south[\s_-]?east|se[\s\b])/i.test(t)) return "south_east";
        if (/\b(south[\s_-]?west|sw[\s\b])/i.test(t)) return "south_west";
        if (/\beast\b/i.test(t)) return "east";
        if (/\bwest\b/i.test(t)) return "west";
        if (/\bnorth\b/i.test(t)) return "north";
        if (/\bsouth\b/i.test(t)) return "south";
        return null;
      };
      const parseTower = (text: string): string | null => {
        // "Tower A" / "Tower-B" / "Tower 1" / standalone "A" only if size_label is JUST a single token like "Tower A"
        const m = text.match(/\btower[\s_-]*([A-Za-z0-9]+)\b/i);
        if (m) return m[1].length === 1 ? m[1].toUpperCase() : m[1];
        return null;
      };

      const results: any[] = [];
      let updated = 0;
      let skipped = 0;
      let alreadyOk = 0;

      for (const row of rows) {
        const haystack = String(row.size_label || "") + " " + String(row.filename || "");
        const parsedSize = row.unit_size_sft ?? parseUnitSize(haystack);
        const parsedFacingRaw = row.facing ?? parseFacing(haystack);
        const parsedFacing = parsedFacingRaw && VALID_FACING.has(String(parsedFacingRaw).toLowerCase())
          ? String(parsedFacingRaw).toLowerCase()
          : null;
        const parsedTower = row.tower ?? parseTower(haystack);

        const delta: any = {};
        if (!row.unit_size_sft && parsedSize) delta.unit_size_sft = parsedSize;
        if (!row.facing && parsedFacing) delta.facing = parsedFacing;
        if (!row.tower && parsedTower) delta.tower = parsedTower;

        if (Object.keys(delta).length === 0) {
          if (row.unit_size_sft || row.facing || row.tower) {
            alreadyOk++;
            continue;
          }
          skipped++;
          results.push({
            id: row.id, project: row.project, doc_type: row.doc_type,
            size_label: row.size_label, skipped: "no parseable hints",
          });
          continue;
        }

        if (dry) {
          results.push({
            id: row.id, project: row.project, doc_type: row.doc_type,
            size_label: row.size_label, would_update: delta,
          });
          updated++;
          continue;
        }

        try {
          const upd = await fetch(`${SUPABASE_URL}/rest/v1/project_documents?id=eq.${row.id}`, {
            method: "PATCH",
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify(delta),
          });
          if (upd.ok) {
            updated++;
            results.push({ id: row.id, project: row.project, doc_type: row.doc_type, updated: delta });
          } else {
            results.push({ id: row.id, error: `PATCH ${upd.status}: ${(await upd.text()).slice(0, 200)}` });
          }
        } catch (err: any) {
          results.push({ id: row.id, error: err.message });
        }
      }

      return res.status(200).json({
        dry,
        scanned: rows.length,
        already_ok: alreadyOk,
        updated,
        skipped,
        filter: {
          doc_type: docTypeFilter || "(all)",
          project: projectFilter || "(all)",
        },
        results: results.slice(0, 200),  // cap response size
        truncated_to: results.length > 200 ? 200 : null,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Reset prompt to hardcoded default (deletes DB override) ────────────
  if (req.method === "POST" && req.query.action === "reset-prompt") {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/bot_settings?key=eq.system_prompt`, {
        method: "DELETE",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: "return=minimal" },
      });
      res.setHeader("Location", `?view=edit-prompt&msg=${encodeURIComponent("Reset to hardcoded default.")}`);
    } catch (err: any) {
      res.setHeader("Location", `?view=edit-prompt&msg=${encodeURIComponent("Reset failed: " + err.message)}`);
    }
    return res.status(303).end();
  }

  // ─── Delete a document row by id ────────────────────────────────────────
  if (req.method === "POST" && req.query.action === "delete-doc") {
    const id = String(req.query.id || "");
    if (!id) return res.status(400).json({ error: "id required" });
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/project_documents?id=eq.${id}`, {
        method: "DELETE",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "return=minimal",
        },
      });
      res.setHeader("Location", `?view=dashboard`);
      return res.status(303).end();
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
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
    // Send a message via Lazybot (default fallthrough — last resort, no action matched)
    // Defensive: req.body can be undefined if Vercel didn't parse it
    // (e.g. wrong content-type, empty body, internal POST). Without this
    // guard, the destructure throws TypeError "Cannot destructure of undefined".
    const body = (req.body || {}) as { phone?: string; message?: string };
    const { phone, message } = body;
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
