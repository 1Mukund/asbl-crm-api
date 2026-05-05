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
    sb(`project_documents?select=id,project,doc_type,size_label,filename,url,fetched_at&order=fetched_at.desc&limit=200`),
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
    { key: "price_sheet", label: "Price Sheet" },
    { key: "payment_structure", label: "Payment Structure" },
    { key: "brochure", label: "Brochure" },
    { key: "specifications", label: "Specifications" },
    { key: "amenities", label: "Amenities" },
  ];

  // Multi-PDF slots — one row per label (e.g. tower / unit size).
  // The bot fuzzy-matches by label when a customer asks for a specific one.
  const MULTI_SLOTS: Array<{ key: string; title: string; placeholder: string }> = [
    { key: "floor_plan", title: "Floor Plans", placeholder: "tower label e.g. Tower A" },
    { key: "unit_plan", title: "Unit Plans", placeholder: "size label e.g. 1695 East" },
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
    const labelHeader = docType === "floor_plan" ? "Tower" : "Size";
    const list = items.map((p) => `<tr>
      <td>${esc(p.size_label || "—")}</td>
      <td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.filename || "open")}</a></td>
      <td>
        <form method="POST" action="?action=delete-doc&id=${esc(p.id)}" style="display:inline" onsubmit="return confirm('Delete ${esc(title)} ${esc(p.size_label || '')} for ${esc(project)}?')">
          <button type="submit" class="btn-delete">delete</button>
        </form>
      </td>
    </tr>`).join("");

    return `<div class="unit-plans">
      <div class="doc-slot-label">${esc(title)} <span class="${items.length ? "ok" : "missing"}">${items.length ? "●" : "○"}</span> <span style="color:#888;font-weight:normal">(${items.length})</span></div>
      ${items.length ? `<table class="unit-table">
        <tr><th>${esc(labelHeader)} label</th><th>File</th><th></th></tr>
        ${list}
      </table>` : `<div class="empty-inline">no ${esc(title.toLowerCase())} uploaded yet</div>`}
      <div class="add-unit-row">
        <input type="text" id="multi-${esc(project)}-${esc(docType)}" placeholder="${esc(placeholder)}" class="size-input" />
        <button type="button" class="btn-upload" onclick="pickMulti('${esc(project)}', '${esc(docType)}', '${esc(title)}')">+ Add ${esc(title.toLowerCase().slice(0, -1))} PDF</button>
      </div>
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
  if (!sizeLabel) {
    alert('Enter a label first (e.g. "Tower A" for floor plans, "1695 East" for unit plans)');
    input?.focus();
    return;
  }
  _ctx = { kind: 'multi', project, docType, sizeLabel, label: title + ' ' + sizeLabel };
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
            content: (n.Note_Content || "").slice(0, 500),
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
              content: (n.Note_Content || "").slice(0, 500),
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

  // ─── Meta token health check ────────────────────────────────────────────
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
      return res.status(200).json({
        verdict: "OK",
        page: { id: meBody.id, name: meBody.name },
        debug,
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
      return res.status(200).json({
        ok: true,
        project,
        message,
        elapsedMs: Date.now() - t0,
        contextSize: projectContext.length,
        gemini: reply,
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

      const insertBody: any = { project, doc_type: docType, filename, url: publicUrl };
      if (sizeLabel) insertBody.size_label = sizeLabel;

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
      return res.status(200).json({ ok: true, project, docType, sizeLabel, publicUrl, record: await insRes.json() });
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
