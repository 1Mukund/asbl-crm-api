import type { VercelRequest, VercelResponse } from "@vercel/node";
import { listAllProjectFacts, getProjectFacts, saveProjectFacts, saveProjectKb, KNOWN_PROJECTS } from "./_utils/project_facts";
import { getAllInventoryRows, getInventoryForProject, refreshInventoryCache, INVENTORY_SHEET_URL, InventoryRow } from "./_utils/inventory_sheet";
import { uploadToStorage, extractTextFromPDF, decodeBase64Text, decodeBase64Buffer, createSignedUploadUrl, downloadFromStorage } from "./_utils/storage_upload";
import { callGemini, ANANDITA_SYSTEM_PROMPT } from "./_utils/gemini_chat";
import { getBotSetting, setBotSetting } from "./_utils/bot_settings";
import { listAllDocs, insertDoc, updateDocFields, deleteDoc, upsertDocBySupabaseId } from "./_utils/project_documents";

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

  // Authoritative project portfolio (ready-to-move / possession) — shown in
  // an editable card so the PM can update it without a deploy.
  let portfolioText = "";
  try {
    const { getPortfolioOverview } = await import("./_utils/project_facts");
    portfolioText = await getPortfolioOverview();
  } catch {}

  // All tables Mongo-backed as of Phase 8.
  const { getRecentActivity, getInboundIntentStats, listConversationPhones } = await import("./_utils/whatsapp_messages");
  const { listAllProfiles } = await import("./_utils/user_profile");
  const { getRecentCronRuns } = await import("./_utils/ops_collections");
  const [factsRows, msgs24h, intentAgg, cronRows, docRows, inventory, profiles, convPhones] = await Promise.all([
    listAllProjectFacts(),
    getRecentActivity(since24h, 300),
    getInboundIntentStats(since24h),
    getRecentCronRuns(20),
    listAllDocs({ limit: 200 }),
    getAllInventoryRows().catch((err: any) => {
      console.error("[Dashboard] Inventory fetch failed:", err.message);
      return { rows: [], fetchedAt: 0 };
    }),
    listAllProfiles(2000),
    listConversationPhones(5000),
  ]);
  // Convert aggregated intent stats to the row-shape the rest of the dashboard expects
  const intentRows = intentAgg.flatMap((r: any) => Array(r.count).fill({ intent: r.intent, project: r.project }));

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
      phoneMap.set(key, { phone: key, lastMsg: m.message, project: m.project ?? null, intent: m.intent ?? null, count: 1, lastTime: m.created_at });
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
      const docId = String((existing as any)._id ?? existing.id ?? "");
      return `<div class="doc-slot filled">
        <div class="doc-slot-label">${esc(label)} <span class="ok">●</span></div>
        <div class="doc-slot-file">
          <a href="${esc(existing.url)}" target="_blank" rel="noopener">${esc(existing.filename || "open")}</a>
          <form method="POST" action="?action=delete-doc&id=${encodeURIComponent(docId)}" style="display:inline" onsubmit="return confirm('Delete ${esc(label)} for ${esc(project)}?')">
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
      const docId = String((p as any)._id ?? p.id ?? "");
      const strictParts: string[] = [];
      if (p.unit_size_sft) strictParts.push(`${p.unit_size_sft} sft`);
      if (p.facing) strictParts.push(String(p.facing));
      if (p.tower) strictParts.push(`Tower ${p.tower}`);
      const strictTag = (p as any).applies_to_all
        ? `<span style="color:#1a7f37;font-weight:600">★ ALL units</span>`
        : (strictParts.length
            ? `<span style="color:#1a7f37">${esc(strictParts.join(" · "))}</span>`
            : `<span style="color:#a00">— missing —</span>`);
      return `<tr>
        <td>${esc(p.size_label || "—")}</td>
        <td>${strictTag}</td>
        <td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.filename || "open")}</a></td>
        <td>
          <form method="POST" action="?action=delete-doc&id=${encodeURIComponent(docId)}" style="display:inline" onsubmit="return confirm('Delete ${esc(title)} ${esc(p.size_label || '')} for ${esc(project)}?')">
            <button type="submit" class="btn-delete">delete</button>
          </form>
        </td>
      </tr>`;
    }).join("");

    // v5 strict inputs — these are what the bot's doc_meta matches against.
    // unit_plan: size + facing + tower. floor_plan: tower. price_sheet:
    // operator can optionally set strict keys per-config OR tick "applies
    // to all units" so a single price sheet serves every price request.
    const wantsSize   = docType === "unit_plan" || docType === "price_sheet";
    const wantsFacing = docType === "unit_plan" || docType === "price_sheet";
    const wantsTower  = docType === "unit_plan" || docType === "floor_plan" || docType === "price_sheet";
    const wantsAllToggle = docType === "price_sheet";

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
        ${wantsSize ? `<input type="number" id="multi-${esc(project)}-${esc(docType)}-size" placeholder="size sft (e.g. 1695)" min="100" max="100000" class="size-input" style="width:150px" />` : ""}
        ${wantsFacing ? `<select id="multi-${esc(project)}-${esc(docType)}-facing" class="size-input" style="width:130px">${facingOptions}</select>` : ""}
        ${wantsTower ? `<input type="text" id="multi-${esc(project)}-${esc(docType)}-tower" placeholder="tower/config" class="size-input" style="width:110px" />` : ""}
        ${wantsAllToggle ? `<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap"><input type="checkbox" id="multi-${esc(project)}-${esc(docType)}-all" /> applies to ALL units</label>` : ""}
        <button type="button" class="btn-upload" onclick="pickMulti('${esc(project)}', '${esc(docType)}', '${esc(title)}')">+ Add ${esc(title.toLowerCase().slice(0, -1))} PDF</button>
      </div>
      ${wantsAllToggle ? `<div class="proj-help" style="font-size:11px;margin-top:4px">Tick <strong>"applies to ALL units"</strong> when the project has one price sheet for everything — the bot will send it for ANY price request, no per-config match needed. Otherwise set strict keys (size / facing / config) for per-config sheets.</div>`
        : ((wantsSize || wantsFacing || wantsTower) ? `<div class="proj-help" style="font-size:11px;margin-top:4px">Strict fields are what the v5 bot matches on. The legacy label is kept for the storage filename.</div>` : "")}
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
    <a href="?view=unique-leads">Unique Leads</a>
    <a href="?view=edit-prompt">Bot Prompt</a>
    <a href="?view=users">Users</a>
    <a href="?view=audit">Audit Log</a>
    <a href="?action=logout">Logout</a>
  </nav>
  <div class="meta">Loaded: ${new Date().toLocaleString("en-IN")} · <a href="javascript:location.reload()" style="color:var(--primary)">↻ refresh</a></div>
</header>
<main class="container">
  <h1 class="page-title">Operations Dashboard</h1>
  <p class="page-sub">Live view of project KB, offers, inventory, document library, conversations and bot configuration.</p>

  <div class="grid">

  <div class="card full" id="portfolio">
    <h2>0. Project Portfolio — Ready-to-Move &amp; Possession (authoritative)</h2>
    <div class="proj-help">
      The bot injects this into <strong>every</strong> reply as ground-truth for "ready to move" /
      possession / "which project" questions. Edit and Save — live within ~60 seconds, no deploy.
      <br><strong>Keep it accurate:</strong> the bot will quote possession dates and the ready-to-move
      project (Spectra) straight from here.
    </div>
    <textarea id="pf-text" style="width:100%;min-height:220px;font-family:ui-monospace,monospace;font-size:13px;padding:10px;border:1px solid var(--border,#ccc);border-radius:6px;box-sizing:border-box">${esc(portfolioText)}</textarea>
    <div style="margin-top:10px;display:flex;gap:10px;align-items:center">
      <button class="btn-primary" onclick="savePortfolio(this)">Save portfolio</button>
      <span id="pf-msg" style="font-size:13px;color:#888"></span>
    </div>
  </div>

  <div class="card full" id="ops">
    <h2>0b. Ops &amp; Diagnostics</h2>
    <div class="proj-help">
      Health checks for the WhatsApp + calling + followup pipeline. Click a button to run it live.
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <button class="btn-mini" onclick="ops('storage-freshness', this)">📦 Storage freshness (are writes landing?)</button>
      <button class="btn-mini" onclick="ops('cron-runs&task=prd-cadence', this)">🔁 Followups ticking? (cron runs)</button>
      <button class="btn-mini" onclick="ops('cron-runs&task=mongo-sync', this)">🗂️ Mongo sync status</button>
      <button class="btn-mini" onclick="ops('callback-log', this)">📞 Callback log (why a call did/didn't fire)</button>
      <button class="btn-mini" onclick="ops('audit-project-docs', this)">📄 Document audit (per project)</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      <input id="lead-phone" type="text" placeholder="phone e.g. 98xxxxxxxx" style="padding:7px;border:1px solid var(--border,#ccc);border-radius:6px;min-width:200px" />
      <button class="btn-mini" onclick="leadMatch(this)">🔎 Lead match test (does the bot find this Zoho lead?)</button>
    </div>
    <pre id="ops-out" style="background:var(--surface-muted,#f6f6f6);padding:12px;border-radius:6px;font-size:12px;max-height:420px;overflow:auto;white-space:pre-wrap;margin:0">Click a button above to run a check…</pre>
  </div>

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

  ${(() => {
    // ── Bot Override (per-phone kill-switch) ─────────────────────────────
    // Lists EVERY phone we've exchanged a WhatsApp message with (from the
    // whatsapp_messages collection — 1 doc per phone), merged with
    // user_profiles for bot_enabled + name + funnel. Earlier this only
    // listed user_profiles (phones that messaged US) so most outbound-only
    // numbers were invisible.
    const profByPhone = new Map<string, any>();
    for (const p of profiles) profByPhone.set(String(p.phone).replace(/\D/g, ""), p);

    // Union of conversation phones + any profile-only phones (lazy-created
    // via direct toggle but no messages yet).
    const seen = new Set<string>();
    const merged: Array<{
      phone: string; name: string; project: string; funnel: string;
      botEnabled: boolean; lastMs: number; lastStr: string; ago: string;
      inbound: number; outbound: number; total: number;
    }> = [];
    const pushRow = (phone: string, conv: any | null) => {
      const clean = String(phone).replace(/\D/g, "");
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      const prof = profByPhone.get(clean);
      const lastIso = conv?.last_message_at || prof?.last_interaction_at || prof?.created_at || null;
      const lastMs = lastIso ? new Date(lastIso).getTime() : 0;
      merged.push({
        phone: clean,
        name: prof?.name || "",
        project: prof?.current_project || prof?.last_project || "",
        funnel: prof?.funnel_stage || "—",
        botEnabled: prof ? prof.bot_enabled !== false : true,
        lastMs,
        lastStr: lastIso ? new Date(lastIso).toLocaleString("en-IN") : "—",
        ago: lastIso ? timeAgo(lastIso) : "—",
        inbound: conv?.inbound_count ?? 0,
        outbound: conv?.outbound_count ?? 0,
        total: conv?.total_count ?? 0,
      });
    };
    for (const c of convPhones) pushRow(c.phone, c);
    for (const p of profiles) pushRow(String(p.phone), null);
    merged.sort((a, b) => b.lastMs - a.lastMs);

    const totalPhones = merged.length;
    const disabledCount = merged.filter((m) => !m.botEnabled).length;

    const rowsHtml = merged.map((m) => {
      const stateChip = !m.botEnabled
        ? `<span style="color:#a00;font-weight:600">● OFF</span>`
        : `<span style="color:#080;font-weight:600">● ON</span>`;
      const toggleTarget = !m.botEnabled ? "1" : "0";
      const toggleLabel = !m.botEnabled ? "Turn ON" : "Turn OFF";
      const toggleClass = !m.botEnabled ? "btn-primary" : "btn-danger";
      const confirmMsg = !m.botEnabled
        ? `Re-enable bot for ${m.phone}?`
        : `Turn OFF bot for ${m.phone}? Incoming messages will be logged but the bot will NOT reply.`;
      const nameStr = [m.name, m.project ? `(${m.project})` : ""].filter(Boolean).join(" ").trim() || "—";
      // data-* attrs power the client-side filter
      return `<tr class="bo-row" data-phone="${esc(m.phone)}" data-name="${esc(m.name.toLowerCase())}" data-project="${esc((m.project || '').toLowerCase())}" data-status="${m.botEnabled ? 'on' : 'off'}">
        <td><code>${esc(m.phone)}</code></td>
        <td>${esc(nameStr)}</td>
        <td>${esc(m.funnel)}</td>
        <td style="white-space:nowrap">${esc(m.lastStr)} <span style="color:#888">(${esc(m.ago)})</span></td>
        <td style="text-align:center"><a href="?view=chat&amp;phone=${encodeURIComponent(m.phone)}" title="View full WhatsApp conversation">${m.inbound}/${m.outbound} 💬</a></td>
        <td>${stateChip}</td>
        <td>
          <form method="POST" action="?action=toggle-bot&amp;phone=${encodeURIComponent(m.phone)}&amp;enabled=${toggleTarget}" style="display:inline" onsubmit="return confirm('${esc(confirmMsg)}')">
            <button type="submit" class="${toggleClass}">${toggleLabel}</button>
          </form>
        </td>
      </tr>`;
    }).join("");

    return `<div class="card full" id="bot-override">
    <h2>4b. Bot Override — Per-Phone Kill Switch (${totalPhones} phones · ${disabledCount} disabled)</h2>
    <div class="card-help">
      Switch the WhatsApp bot ON / OFF for any phone we've messaged. When OFF,
      incoming messages are still logged but the bot does NOT reply — silent
      until flipped back ON. Lists every conversation (inbound + outbound),
      newest first.
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      <input type="text" id="bo-search" placeholder="🔍 search phone / name / project" oninput="boFilter()" style="flex:1;min-width:240px;padding:8px;border:1px solid var(--border,#ccc);border-radius:6px" />
      <select id="bo-status" onchange="boFilter()" style="padding:8px;border:1px solid var(--border,#ccc);border-radius:6px">
        <option value="all">All (${totalPhones})</option>
        <option value="on">Bot ON</option>
        <option value="off">Bot OFF (${disabledCount})</option>
      </select>
      <span id="bo-count" style="color:#888;font-size:13px"></span>
    </div>
    ${rowsHtml ? `<table id="bo-table">
      <tr><th>Phone</th><th>Name / Project</th><th>Funnel</th><th>Last interaction</th><th>In/Out</th><th>Bot</th><th>Action</th></tr>
      ${rowsHtml}
    </table>` : `<div class="empty">No conversations yet.</div>`}
    <script>
    function boFilter() {
      var q = (document.getElementById('bo-search').value || '').toLowerCase().trim();
      var st = document.getElementById('bo-status').value;
      var rows = document.querySelectorAll('#bo-table tr.bo-row');
      var shown = 0;
      rows.forEach(function(r) {
        var hay = (r.getAttribute('data-phone') + ' ' + r.getAttribute('data-name') + ' ' + r.getAttribute('data-project'));
        var matchQ = !q || hay.indexOf(q) !== -1;
        var matchS = st === 'all' || r.getAttribute('data-status') === st;
        var show = matchQ && matchS;
        r.style.display = show ? '' : 'none';
        if (show) shown++;
      });
      document.getElementById('bo-count').textContent = shown + ' shown';
    }
    boFilter();
    </script>
  </div>`;
  })()}

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
// ── Portfolio editor + Ops/diagnostics (session-authed via cookie) ──
async function savePortfolio(btn) {
  var t = (document.getElementById('pf-text').value || '').trim();
  var msg = document.getElementById('pf-msg');
  if (t.length < 30) { msg.textContent = 'Too short.'; msg.style.color = '#a00'; return; }
  btn.disabled = true; msg.style.color = '#888'; msg.textContent = 'Saving…';
  try {
    var r = await fetch('?action=portfolio-save', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t }),
    });
    var j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'save failed');
    msg.style.color = '#080'; msg.textContent = 'Saved ✓ (live within ~60s)';
  } catch (e) { msg.style.color = '#a00'; msg.textContent = 'Error: ' + e.message; }
  btn.disabled = false;
}
async function ops(action, btn) {
  var out = document.getElementById('ops-out');
  out.textContent = 'Running ' + action + ' …';
  if (btn) btn.disabled = true;
  try {
    var r = await fetch('?action=' + action, { credentials: 'include' });
    var j = await r.json();
    out.textContent = JSON.stringify(j, null, 2);
  } catch (e) { out.textContent = 'Error: ' + e.message; }
  if (btn) btn.disabled = false;
}
function leadMatch(btn) {
  var p = (document.getElementById('lead-phone').value || '').replace(/\\D/g, '');
  if (p.length < 10) { document.getElementById('ops-out').textContent = 'Enter a valid phone.'; return; }
  ops('zoho-lead-match-test&phone=' + encodeURIComponent(p), btn);
}

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
  const allEl = document.getElementById('multi-' + project + '-' + docType + '-all');
  const unitSizeSft = sizeEl ? parseInt(sizeEl.value, 10) : NaN;
  const facing = facingEl ? facingEl.value.trim() : '';
  const tower = towerEl ? towerEl.value.trim() : '';
  const appliesToAll = allEl ? !!allEl.checked : false;

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

  // price_sheet: if "applies to all" is ticked, no per-config keys needed and
  // the size_label can default. Otherwise require at least a label.
  if (docType === 'price_sheet' && appliesToAll) {
    _ctx = {
      kind: 'multi', project, docType,
      sizeLabel: sizeLabel || 'All Units',
      label: title + ' (all units)',
      unit_size_sft: null, facing: null, tower: null,
      applies_to_all: true,
    };
    _fileInput.accept = '.pdf,application/pdf';
    _fileInput.value = '';
    _fileInput.click();
    return;
  }

  if (!sizeLabel) {
    alert('Enter a label first (e.g. "Tower A" for floor plans, "1695 East" for unit plans, or tick "applies to ALL units" for a single price sheet)');
    input?.focus();
    return;
  }

  _ctx = {
    kind: 'multi', project, docType, sizeLabel,
    label: title + ' ' + sizeLabel,
    unit_size_sft: isFinite(unitSizeSft) ? unitSizeSft : null,
    facing: facing || null,
    tower: tower || null,
    applies_to_all: appliesToAll,
  };
  _fileInput.accept = '.pdf,application/pdf';
  _fileInput.value = '';
  _fileInput.click();
}

function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => reject(new Error('file read failed'));
    r.readAsDataURL(file);
  });
}

async function uploadFile(ctx, file, btn) {
  // Files now go to Mongo GridFS via our own endpoint (no Supabase). The
  // base64 POST goes through Vercel, which caps the request body at ~4.5 MB,
  // so the raw file must be under ~3.3 MB. Floor plans / unit plans / price
  // sheets are well within this; very large brochures should be compressed.
  if (file.size > 3.3 * 1024 * 1024) {
    alert('File is ' + (file.size/1024/1024).toFixed(1) + ' MB. Max ~3.3 MB per file (server limit). Please compress the PDF and try again.');
    return;
  }
  const oldText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }

  const isKb = ctx.kind === 'kb';
  const mimetype = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/plain');

  try {
    const base64 = await _fileToBase64(file);
    if (btn) btn.textContent = isKb ? 'Extracting…' : 'Uploading…';

    if (isKb) {
      const r = await fetch('?action=upload-kb', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: ctx.project, filename: file.name, mimetype, base64_content: base64 }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'kb upload failed');
      alert('KB uploaded: ' + (j.extractedChars || j.text_extract_chars || '?') + ' chars extracted for ' + ctx.project);
    } else {
      const docReq = { project: ctx.project, doc_type: ctx.docType, filename: file.name, mimetype, base64_content: base64 };
      if (ctx.sizeLabel) docReq.size_label = ctx.sizeLabel;
      if (ctx.unit_size_sft !== undefined) docReq.unit_size_sft = ctx.unit_size_sft;
      if (ctx.facing !== undefined) docReq.facing = ctx.facing;
      if (ctx.tower !== undefined) docReq.tower = ctx.tower;
      if (ctx.applies_to_all !== undefined) docReq.applies_to_all = ctx.applies_to_all;
      const r = await fetch('?action=upload-doc', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(docReq),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'doc upload failed');
      alert(ctx.label + ' uploaded for ' + ctx.project + ' (stored in Mongo, ' + (j.text_extract_chars || 0) + ' chars extracted)');
    }
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

// ── Unique-Leads view ─────────────────────────────────────────────────────
//
// Same person can exist as multiple Zoho lead records — one per project
// they enquired about. This page dedupes by phone (Mobile) and shows the
// most-recently-modified record per phone, plus chips for every project
// that phone appears in.
//
// Cap at 5000 leads (25 × 200) to stay inside Vercel's serverless time
// budget. Sort=Modified_Time desc so the latest activity is always
// covered; the tail that gets dropped is long-dormant only.
async function fetchRecentLeadsForDedup(maxRecords = 5000): Promise<any[]> {
  const { getAccessToken } = await import("./_utils/zoho");
  const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
  const token = await getAccessToken();
  const fields = [
    "id", "First_Name", "Last_Name", "Mobile", "Email",
    "ASBL_Project", "Lead_Status", "Lead_Source",
    "PRD_Stage", "PRD_Status", "PRD_Last_Action_Time",
    "Created_Time", "Modified_Time",
    "Master_Lead_ID", "Project_Lead_ID",
  ].join(",");

  const out: any[] = [];
  const perPage = 200;
  let page = 1;
  while (out.length < maxRecords) {
    const r = await fetch(
      `${ZOHO_API_BASE}/Leads?fields=${fields}&per_page=${perPage}&page=${page}&sort_by=Modified_Time&sort_order=desc`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );
    if (r.status === 204) break;
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Zoho list page ${page} failed: ${r.status} ${text.slice(0, 200)}`);
    }
    const j = await r.json() as any;
    const arr: any[] = j?.data || [];
    if (!arr.length) break;
    out.push(...arr);
    if (!j?.info?.more_records) break;
    page++;
  }
  return out.slice(0, maxRecords);
}

async function renderUniqueLeadsPage(): Promise<string> {
  let leads: any[] = [];
  let fetchError = "";
  try {
    leads = await fetchRecentLeadsForDedup(5000);
  } catch (err: any) {
    fetchError = err.message;
  }

  // Group by normalized phone (digits only) so +91-, +91 with-spaces, etc.
  // collapse together.
  const byPhone = new Map<string, any[]>();
  let withoutPhone = 0;
  for (const l of leads) {
    const phone = String(l.Mobile || "").replace(/\D/g, "");
    if (!phone) { withoutPhone++; continue; }
    let arr = byPhone.get(phone);
    if (!arr) { arr = []; byPhone.set(phone, arr); }
    arr.push(l);
  }

  type UniqRow = {
    phone: string; canonical: any; name: string; email: string;
    projects: string[]; duplicateCount: number;
    lastModifiedMs: number; lastModifiedStr: string;
  };
  const rows: UniqRow[] = [];
  byPhone.forEach((arr, phone) => {
    arr.sort((a, b) =>
      new Date(b.Modified_Time || 0).getTime() - new Date(a.Modified_Time || 0).getTime()
    );
    const canonical = arr[0];
    const projects = Array.from(new Set(
      arr.map(x => String(x.ASBL_Project || "").trim()).filter(Boolean),
    ));
    const last = canonical.Modified_Time || canonical.Created_Time || null;
    rows.push({
      phone,
      canonical,
      name: [canonical.First_Name, canonical.Last_Name].filter(Boolean).join(" ").trim() || "—",
      email: String(canonical.Email || "").trim(),
      projects,
      duplicateCount: arr.length,
      lastModifiedMs: last ? new Date(last).getTime() : 0,
      lastModifiedStr: last ? new Date(last).toLocaleString("en-IN") : "—",
    });
  });
  rows.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);

  const allProjects = Array.from(new Set(rows.flatMap(r => r.projects))).sort();
  const totalRecords = leads.length;
  const uniquePhones = rows.length;
  const duplicatePhones = rows.filter(r => r.duplicateCount > 1).length;
  const totalDuplicateRecords = rows
    .filter(r => r.duplicateCount > 1)
    .reduce((s, r) => s + r.duplicateCount, 0);

  const ZOHO_BASE = "https://crm.zoho.in";
  const projectChip = (p: string) =>
    `<span class="proj-chip">${esc(p)}</span>`;

  const tableRows = rows.map(r => {
    const dupBadge = r.duplicateCount > 1
      ? `<span class="dup-badge">${r.duplicateCount}×</span>`
      : "";
    const stage = String(r.canonical.PRD_Stage || "").trim() || "—";
    const status = String(r.canonical.PRD_Status || "").trim() || "—";
    const leadStatus = String(r.canonical.Lead_Status || "").trim() || "—";
    const canonicalLink = `${ZOHO_BASE}/crm/tab/Leads/${esc(r.canonical.id)}`;
    const projChips = r.projects.map(projectChip).join(" ");
    const projectsLower = r.projects.map(p => p.toLowerCase()).join("|");
    const hayBlob = `${r.phone} ${r.name.toLowerCase()} ${r.email.toLowerCase()} ${projectsLower}`;
    return `<tr class="uniq-row"
      data-hay="${esc(hayBlob)}"
      data-projects="${esc(projectsLower)}"
      data-dup="${r.duplicateCount > 1 ? "1" : "0"}">
      <td><code>${esc(r.phone)}</code></td>
      <td>${esc(r.name)} ${dupBadge}</td>
      <td>${esc(r.email || "—")}</td>
      <td>${projChips || "—"}</td>
      <td><strong>${esc(stage)}</strong> · ${esc(status)}<br><span style="color:#888;font-size:12px">${esc(leadStatus)}</span></td>
      <td style="white-space:nowrap">${esc(r.lastModifiedStr)}<br><span style="color:#888;font-size:12px">${esc(timeAgo(r.canonical.Modified_Time || r.canonical.Created_Time))}</span></td>
      <td><a href="${canonicalLink}" target="_blank" rel="noopener" class="btn-mini">Open ↗</a></td>
    </tr>`;
  }).join("");

  const projectFilterChips = allProjects.map(p =>
    `<label class="proj-filter-chip"><input type="checkbox" value="${esc(p.toLowerCase())}" onchange="uniqFilter()"/> ${esc(p)}</label>`,
  ).join(" ");

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Unique Leads — ASBL CRM</title>
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
${SHARED_STYLE}
<style>
.proj-chip{display:inline-block;padding:2px 8px;border-radius:10px;background:#e8edf3;color:#222;font-size:12px;margin:2px 2px 2px 0;border:1px solid #cdd5dd}
.dup-badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:10px;background:#ffd8d8;color:#a00;font-size:11px;font-weight:600}
.proj-filter-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:14px;background:#f3f5f8;border:1px solid #d6dce3;cursor:pointer;font-size:13px;margin:3px}
.proj-filter-chip input{margin:0}
.stat{display:inline-block;padding:8px 12px;border-radius:8px;background:#f3f5f8;margin-right:8px;font-size:14px}
.stat strong{display:block;font-size:18px}
</style>
</head><body>
<header class="topbar">
  <div class="brand"><a href="?view=dashboard">ASBL CRM</a></div>
  <nav>
    <a href="?view=dashboard">Dashboard</a>
    <a href="?view=unique-leads" style="color:var(--primary);font-weight:600">Unique Leads</a>
    <a href="?view=edit-prompt">Bot Prompt</a>
    <a href="?view=users">Users</a>
    <a href="?view=audit">Audit Log</a>
    <a href="?action=logout">Logout</a>
  </nav>
  <div class="meta">Loaded: ${new Date().toLocaleString("en-IN")} · <a href="javascript:location.reload()" style="color:var(--primary)">↻ refresh</a></div>
</header>
<main class="container">
  <h1 class="page-title">Unique Leads (deduplicated by phone)</h1>
  <p class="page-sub">
    Same person can exist as multiple Zoho lead records — one per project they enquired about.
    This view picks the <strong>most recently modified</strong> record per phone and chips every
    project that phone appears in.
    ${withoutPhone > 0 ? `<em>${withoutPhone} record${withoutPhone === 1 ? "" : "s"} skipped — no phone.</em>` : ""}
  </p>

  ${fetchError ? `<div class="card full" style="border-color:#d33;color:#a00"><strong>Zoho fetch error:</strong> ${esc(fetchError)}</div>` : ""}

  <div class="card full" style="border-color:#7aaad6">
    <h2 style="margin-top:0">⚙️ Sync to Zoho (so you can filter in Zoho directly)</h2>
    <div class="card-help">
      Yeh page existing leads ko dedupe karke yahaan dikhata hai. <strong>Zoho ke andar
      hi filter karna ho</strong> to yeh 3 step ek baar karo:
      <ol style="margin:8px 0 8px 18px">
        <li>Click <strong>Step 1 — Create field</strong> below. Yeh <code>Is_Unique_Lead</code> (boolean)
            field Zoho ke Leads module pe banayega.</li>
        <li>Click <strong>Step 2 — Sync flags</strong>. Yeh saare leads pe flag set karega
            (most-recently-modified per phone = true, baaki = false). Hourly cron isko
            auto-refresh karta rahega.</li>
        <li>Zoho UI me jao → <em>Leads → All Leads dropdown → Create View</em>. Naam do
            "Unique Leads". Filter criterion: <strong>Is Unique Lead = true</strong>. Save.
            Wahaan se yeh hamesha ek-click filter ban jayega.</li>
      </ol>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button type="button" id="step1-btn" class="btn-primary" onclick="ulStep1()">Step 1 — Create field</button>
      <button type="button" id="step2-btn" class="btn-primary" onclick="ulStep2()">Step 2 — Sync flags now</button>
      <span id="ul-status" style="color:#555;font-size:13px"></span>
    </div>
    <pre id="ul-result" style="display:none;background:#f3f5f8;padding:10px;border-radius:6px;margin-top:10px;font-size:12px;max-height:200px;overflow:auto;white-space:pre-wrap"></pre>
  </div>

  <div class="card full">
    <div style="margin-bottom:14px">
      <span class="stat"><strong>${totalRecords.toLocaleString("en-IN")}</strong> Records pulled</span>
      <span class="stat"><strong>${uniquePhones.toLocaleString("en-IN")}</strong> Unique phones</span>
      <span class="stat"><strong>${duplicatePhones.toLocaleString("en-IN")}</strong> With duplicates</span>
      <span class="stat"><strong>${totalDuplicateRecords.toLocaleString("en-IN")}</strong> Duplicate records (combined)</span>
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      <input type="text" id="uniq-search" placeholder="🔍 search phone / name / email / project" oninput="uniqFilter()" style="flex:1;min-width:280px;padding:8px;border:1px solid var(--border,#ccc);border-radius:6px" />
      <label style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:#fff5e6;border:1px solid #f0c36d;border-radius:6px;cursor:pointer">
        <input type="checkbox" id="uniq-dup-only" onchange="uniqFilter()"/> Show only phones with duplicates
      </label>
      <span id="uniq-count" style="color:#888;font-size:13px"></span>
    </div>

    <div style="margin-bottom:14px">
      <strong style="font-size:13px;color:#555">Filter by project:</strong>
      ${projectFilterChips || `<span style="color:#888;font-size:13px">No projects found</span>`}
      <button type="button" class="btn-mini" onclick="uniqClearProjects()" style="margin-left:8px">Clear</button>
    </div>

    ${rows.length === 0
      ? `<div class="empty">No leads found.</div>`
      : `<table id="uniq-table">
          <tr><th>Phone</th><th>Name</th><th>Email</th><th>Projects</th><th>Latest Stage / Status</th><th>Last modified</th><th></th></tr>
          ${tableRows}
        </table>`}
  </div>
</main>

<script>
function uniqFilter() {
  var q = (document.getElementById('uniq-search').value || '').toLowerCase().trim();
  var dupOnly = document.getElementById('uniq-dup-only').checked;
  var checked = Array.prototype.filter.call(
    document.querySelectorAll('.proj-filter-chip input'),
    function(c) { return c.checked; }
  ).map(function(c) { return c.value; });
  var rows = document.querySelectorAll('#uniq-table tr.uniq-row');
  var shown = 0;
  rows.forEach(function(r) {
    var hay = r.getAttribute('data-hay');
    var projs = r.getAttribute('data-projects');
    var matchQ = !q || hay.indexOf(q) !== -1;
    var matchDup = !dupOnly || r.getAttribute('data-dup') === '1';
    var matchProj = checked.length === 0 || checked.some(function(p) { return projs.indexOf(p) !== -1; });
    var show = matchQ && matchDup && matchProj;
    r.style.display = show ? '' : 'none';
    if (show) shown++;
  });
  document.getElementById('uniq-count').textContent = shown + ' shown';
}
function uniqClearProjects() {
  document.querySelectorAll('.proj-filter-chip input').forEach(function(c) { c.checked = false; });
  uniqFilter();
}
async function ulCall(action, btn, label) {
  var prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  document.getElementById('ul-status').textContent = 'Running…';
  try {
    // Field create endpoint is GET-only on the dashboard, sync is GET-OK too.
    var r = await fetch('/api/chat-history?action=' + action, { method: 'GET', credentials: 'include' });
    var txt = await r.text();
    var j; try { j = JSON.parse(txt); } catch (e) { j = { raw: txt }; }
    var pre = document.getElementById('ul-result');
    pre.style.display = 'block';
    pre.textContent = JSON.stringify(j, null, 2);
    document.getElementById('ul-status').textContent = r.ok ? '✓ Done — see response below' : ('✗ HTTP ' + r.status);
    if (action === 'mark-unique-leads' && r.ok) {
      // After sync, reload the page so the table reflects fresh state.
      setTimeout(function() { location.reload(); }, 1500);
    }
  } catch (e) {
    document.getElementById('ul-status').textContent = '✗ ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}
function ulStep1() {
  if (!confirm('Create the Is_Unique_Lead boolean field on the Zoho Leads module? (Safe: idempotent — already-exists is a no-op.)')) return;
  ulCall('zoho-create-unique-lead-field', document.getElementById('step1-btn'), 'Creating…');
}
function ulStep2() {
  if (!confirm('Sync Is_Unique_Lead flags on all Zoho leads now? (Up to ~30s for 5000 leads. Idempotent — only PATCHes records where the value differs.)')) return;
  ulCall('mark-unique-leads', document.getElementById('step2-btn'), 'Syncing…');
}
uniqFilter();
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

// ─── Login / register page ─────────────────────────────────────────────────
function renderLoginPage(flash: string, mode: string): string {
  const isRegister = mode === "register";
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ASBL CRM — ${isRegister ? "Register" : "Login"}</title>
<link rel="preconnect" href="https://rsms.me/"><link rel="stylesheet" href="https://rsms.me/inter/inter.css">
${SHARED_STYLE}
</head><body class="page-narrow">
<main class="container" style="max-width:420px;margin-top:8vh">
  <h1 class="page-title" style="text-align:center">ASBL CRM</h1>
  <p class="page-sub" style="text-align:center">${isRegister ? "Create an account — an admin will approve it" : "Sign in to the operations dashboard"}</p>
  ${flash ? `<div class="card" style="border-left:3px solid var(--primary);padding:10px 14px;margin-bottom:14px">${esc(flash)}</div>` : ""}
  <div class="card">
    <form method="POST" action="?action=${isRegister ? "register" : "login"}">
      <label style="display:block;margin-bottom:6px;font-size:13px">Email</label>
      <input type="email" name="email" required placeholder="you@asblloft.com" style="width:100%;padding:10px;margin-bottom:14px;border:1px solid var(--border,#ccc);border-radius:6px" />
      <label style="display:block;margin-bottom:6px;font-size:13px">Password</label>
      <input type="password" name="password" required minlength="6" placeholder="••••••••" style="width:100%;padding:10px;margin-bottom:18px;border:1px solid var(--border,#ccc);border-radius:6px" />
      <button type="submit" class="btn-primary" style="width:100%;padding:11px">${isRegister ? "Register" : "Log in"}</button>
    </form>
  </div>
  <p style="text-align:center;margin-top:16px;font-size:13px">
    ${isRegister
      ? `Already have an account? <a href="?view=login&mode=login">Log in</a>`
      : `No account? <a href="?view=login&mode=register">Register</a>`}
  </p>
</main>
</body></html>`;
}

// ─── Admin: user approvals page ─────────────────────────────────────────────
async function renderUsersPage(adminEmail: string): Promise<string> {
  const { listUsers } = await import("./_utils/dashboard_auth");
  const users = await listUsers();
  const rows = users.map((u) => {
    const statusChip =
      u.status === "approved" ? `<span style="color:#080;font-weight:600">approved</span>` :
      u.status === "pending"  ? `<span style="color:#c80;font-weight:600">pending</span>` :
      `<span style="color:#a00;font-weight:600">rejected</span>`;
    const actions = u.role === "admin" ? `<em style="color:#888">admin</em>` : `
      ${u.status !== "approved" ? `<form method="POST" action="?action=approve-user&email=${encodeURIComponent(u.email)}" style="display:inline"><button type="submit" class="btn-primary">Approve</button></form>` : ""}
      ${u.status !== "rejected" ? `<form method="POST" action="?action=reject-user&email=${encodeURIComponent(u.email)}" style="display:inline;margin-left:6px" onsubmit="return confirm('Reject ${esc(u.email)}?')"><button type="submit" class="btn-danger">Reject</button></form>` : ""}`;
    return `<tr>
      <td>${esc(u.email)}</td>
      <td>${esc(u.role)}</td>
      <td>${statusChip}</td>
      <td>${esc(u.created_at ? new Date(u.created_at).toLocaleString("en-IN") : "—")}</td>
      <td>${esc(u.approved_by || "—")}</td>
      <td>${actions}</td>
    </tr>`;
  }).join("");
  const pending = users.filter((u) => u.status === "pending").length;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>ASBL CRM — Users</title>
<link rel="preconnect" href="https://rsms.me/"><link rel="stylesheet" href="https://rsms.me/inter/inter.css">${SHARED_STYLE}</head>
<body><header class="topbar">
  <div class="brand"><a href="?view=dashboard">ASBL CRM</a></div>
  <nav><a href="?view=dashboard">← Dashboard</a> <a href="?view=audit">Audit Log</a> <a href="?action=logout">Logout</a></nav>
  <div class="meta">${esc(adminEmail)}</div>
</header>
<main class="container">
  <h1 class="page-title">User Access (${pending} pending)</h1>
  <p class="page-sub">Approve or reject dashboard accounts. Only approved users can log in.</p>
  <div class="card full"><table>
    <tr><th>Email</th><th>Role</th><th>Status</th><th>Registered</th><th>Approved by</th><th>Action</th></tr>
    ${rows || `<tr><td colspan="6"><em>No users yet</em></td></tr>`}
  </table></div>
</main></body></html>`;
}

// ─── Admin: audit log page ──────────────────────────────────────────────────
async function renderAuditPage(): Promise<string> {
  const { listAuditLogs } = await import("./_utils/audit");
  const logs = await listAuditLogs(300);
  const rows = logs.map((l) => {
    const detailsStr = l.details ? esc(JSON.stringify(l.details).slice(0, 200)) : "";
    return `<tr>
      <td style="white-space:nowrap">${esc(new Date(l.ts).toLocaleString("en-IN"))}</td>
      <td>${esc(l.actor_email)}</td>
      <td><code>${esc(l.action)}</code></td>
      <td>${esc(l.target)}</td>
      <td>${esc(l.summary)}${detailsStr ? `<br><span style="color:#888;font-size:11px">${detailsStr}</span>` : ""}</td>
      <td style="color:#888">${esc(l.ip || "—")}</td>
    </tr>`;
  }).join("");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>ASBL CRM — Audit Log</title>
<link rel="preconnect" href="https://rsms.me/"><link rel="stylesheet" href="https://rsms.me/inter/inter.css">${SHARED_STYLE}</head>
<body><header class="topbar">
  <div class="brand"><a href="?view=dashboard">ASBL CRM</a></div>
  <nav><a href="?view=dashboard">← Dashboard</a> <a href="?view=users">Users</a> <a href="?action=logout">Logout</a></nav>
</header>
<main class="container">
  <h1 class="page-title">Audit Log (last ${logs.length})</h1>
  <p class="page-sub">Every change made through the dashboard — who, what, when, where. Append-only.</p>
  <div class="card full"><table>
    <tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Summary</th><th>IP</th></tr>
    ${rows || `<tr><td colspan="6"><em>No audit entries yet</em></td></tr>`}
  </table></div>
</main></body></html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Allow iframe embedding from Zoho
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ─── PUBLIC doc-file serve (BEFORE the auth gate) ───────────────────────
  //   Streams a PDF stored in Mongo GridFS straight to the caller. Periskope
  //   fetches this URL server-side to attach the document to a WhatsApp
  //   message, so it MUST be public (no session, no secret) and return the
  //   raw bytes with the right Content-Type. The id is an opaque GridFS
  //   ObjectId, not guessable. This is what makes the bot independent of any
  //   external object store (Supabase etc.).
  //   GET /api/chat-history?action=doc-file&id=<gridfsId>
  if (req.method === "GET" && req.query.action === "doc-file") {
    try {
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ error: "id required" });
      const { getFile } = await import("./_utils/mongo_files");
      const f = await getFile(id);
      if (!f) return res.status(404).json({ error: "file not found" });
      res.setHeader("Content-Type", f.contentType || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${(f.filename || "document.pdf").replace(/"/g, "")}"`);
      res.setHeader("Content-Length", String(f.buffer.length));
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.status(200).send(f.buffer);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Dashboard authentication gate ──────────────────────────────────────
  // The HTML dashboard + its mutating form actions require a logged-in
  // session (cookie). The curl/admin API endpoints keep their own
  // ?secret=INHOUSE_POSTHOOK_SECRET auth and are NOT gated here. Webhooks
  // and ingest live in other files, unaffected.
  {
    const auth = await import("./_utils/dashboard_auth");
    const { logAudit, clientIp } = await import("./_utils/audit");
    const view = String(req.query.view || "");
    const action = String(req.query.action || "");
    const session = auth.getSessionFromCookies(req.headers.cookie as string | undefined);

    // Views + actions that make up the dashboard UI surface (session-gated)
    const DASHBOARD_VIEWS = new Set(["dashboard", "edit-prompt", "edit-facts", "audit", "users", "unique-leads", "chat"]);
    const DASHBOARD_ACTIONS = new Set([
      "save-prompt", "reset-prompt", "save-facts", "delete-doc", "toggle-bot",
      "refresh-inventory", "set-pdf-extracts", "upload-sign", "upload-finalize",
      "upload-kb", "upload-doc", "approve-user", "reject-user",
      "mark-unique-leads", "zoho-create-unique-lead-field",
      "zoho-create-call-scheduling-fields",
      "site-visit-leads-csv",
      "sync-prompt-to-hardcoded",
      "audit-project-docs",
      "send-doc-test",
      "export-all-kb",
      // Ops/diagnostics + portfolio — surfaced on the dashboard. Session-gated
      // here (so the logged-in dashboard can call them via cookie) AND
      // secret-capable (so curl/automation still works).
      "portfolio-get", "portfolio-save", "callback-log", "zoho-lead-match-test",
      "storage-freshness", "cron-runs", "mongo-sync-leads", "set-followup-pause",
      "set-ops-flag", "reactivation-upload", "reactivation-check",
      "zoho-add-leadsource-option", "zoho-create-reactivation-field",
      "zoho-create-inncircles-flag-fields",
      "sender-stats", "message-rows",
    ]);
    const ADMIN_ONLY = new Set(["audit", "users", "approve-user", "reject-user"]);
    // Actions that are session-gated for dashboard use BUT also accept a
    // valid ?secret=INHOUSE_POSTHOOK_SECRET for curl/automation. Their own
    // handlers do a (session OR secret) check; the top gate must therefore
    // let a valid secret pass instead of short-circuiting with 401.
    // Bug R5 (2026-06-26): send-doc-test / audit-project-docs / export-all-kb
    // were in DASHBOARD_ACTIONS, so the top gate demanded a session and
    // returned 401 on a valid secret before the handler ever ran.
    const SECRET_CAPABLE_ACTIONS = new Set([
      "send-doc-test", "audit-project-docs", "export-all-kb",
      "sync-prompt-to-hardcoded", "mark-unique-leads",
      "zoho-create-unique-lead-field", "zoho-create-call-scheduling-fields",
      "periskope-doc-diag", "portfolio-get", "portfolio-save",
      "callback-log", "zoho-lead-match-test", "storage-freshness",
      "cron-runs", "mongo-sync-leads", "set-followup-pause", "sender-stats",
      "message-rows", "set-ops-flag", "reactivation-upload", "reactivation-check",
      "zoho-add-leadsource-option", "zoho-create-reactivation-field",
      "zoho-create-inncircles-flag-fields",
    ]);
    const incomingSecretTop =
      (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecretTop = process.env.INHOUSE_POSTHOOK_SECRET || "";
    const hasValidSecret = !!expectedSecretTop && incomingSecretTop === expectedSecretTop;

    // ── Public auth endpoints (no session needed) ──
    if (req.method === "GET" && view === "login") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(renderLoginPage(String(req.query.msg || ""), String(req.query.mode || "login")));
    }
    if (req.method === "POST" && action === "login") {
      const body = parseFormBody(req.body);
      const result = await auth.authenticate(String(body.email || ""), String(body.password || ""));
      if (!result.ok || !result.user) {
        await logAudit({ actor_email: String(body.email || "(unknown)"), action: "login-failed", target: "dashboard", summary: result.error || "login failed", ip: clientIp(req) });
        res.setHeader("Location", `?view=login&mode=login&msg=${encodeURIComponent(result.error || "Login failed")}`);
        return res.status(303).end();
      }
      const token = auth.createSessionToken(result.user.email, result.user.role);
      res.setHeader("Set-Cookie", auth.buildSessionCookie(token));
      await logAudit({ actor_email: result.user.email, action: "login", target: "dashboard", summary: `${result.user.role} logged in`, ip: clientIp(req) });
      res.setHeader("Location", `?view=dashboard`);
      return res.status(303).end();
    }
    if (req.method === "POST" && action === "register") {
      const body = parseFormBody(req.body);
      const result = await auth.registerUser(String(body.email || ""), String(body.password || ""));
      if (!result.ok) {
        res.setHeader("Location", `?view=login&mode=register&msg=${encodeURIComponent(result.error || "Registration failed")}`);
        return res.status(303).end();
      }
      await logAudit({ actor_email: String(body.email || ""), action: "register", target: "dashboard", summary: "new user registered — awaiting admin approval", ip: clientIp(req) });
      res.setHeader("Location", `?view=login&mode=login&msg=${encodeURIComponent("Registered! An admin must approve your account before you can log in.")}`);
      return res.status(303).end();
    }
    if (action === "logout") {
      res.setHeader("Set-Cookie", auth.buildLogoutCookie());
      res.setHeader("Location", `?view=login&msg=${encodeURIComponent("Logged out")}`);
      return res.status(303).end();
    }

    // ── Gate dashboard surfaces ──
    const needsAuth = DASHBOARD_VIEWS.has(view) || DASHBOARD_ACTIONS.has(action);
    // A valid shared secret bypasses the session requirement, but ONLY for
    // actions explicitly marked secret-capable (so curl/automation works
    // while real dashboard form actions like save-prompt still need a login).
    const secretBypassesGate = hasValidSecret && SECRET_CAPABLE_ACTIONS.has(action);
    if (needsAuth && !secretBypassesGate) {
      if (!session) {
        if (req.method === "GET") {
          res.setHeader("Location", `?view=login&msg=${encodeURIComponent("Please log in")}`);
          return res.status(303).end();
        }
        return res.status(401).json({ error: "Not authenticated — log in to the dashboard first" });
      }
      const isAdminSurface = ADMIN_ONLY.has(view) || ADMIN_ONLY.has(action);
      if (isAdminSurface && session.role !== "admin") {
        if (req.method === "GET") {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          return res.status(403).send(`<pre>403 — admin only. You are logged in as ${esc(session.email)} (${esc(session.role)}).</pre>`);
        }
        return res.status(403).json({ error: "admin only" });
      }
    }

    // ── Admin views: user approvals + audit log ──
    if (req.method === "GET" && view === "users") {
      const html = await renderUsersPage(session!.email);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(html);
    }
    if (req.method === "GET" && view === "audit") {
      const html = await renderAuditPage();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(html);
    }
    if (req.method === "POST" && (action === "approve-user" || action === "reject-user")) {
      const targetEmail = String(req.query.email || "");
      const status = action === "approve-user" ? "approved" : "rejected";
      const ok = await auth.setUserStatus(targetEmail, status as any, session!.email);
      await logAudit({ actor_email: session!.email, action, target: `user/${targetEmail}`, summary: `${session!.email} set ${targetEmail} → ${status}`, ip: clientIp(req) });
      res.setHeader("Location", `?view=users`);
      return res.status(303).end();
    }

    // Stash session + audit helper on the request for downstream handlers
    (req as any)._session = session;
  }

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

  // ─── Chat transcript view (HTML) — read the actual WhatsApp conversation ──
  //   GET /api/chat-history?view=chat&phone=<phone>
  //   Renders every inbound/outbound message for a phone from Mongo
  //   whatsapp_messages as WhatsApp-style bubbles. This is what was missing:
  //   messages were always stored, but there was no way to READ them in the UI.
  if (req.method === "GET" && req.query.view === "chat") {
    try {
      const rawPhone = String(req.query.phone || "").replace(/\D/g, "");
      if (rawPhone.length < 10) return res.status(400).send(`<pre>valid ?phone= required</pre>`);
      const { getMessagesForPhone } = await import("./_utils/whatsapp_messages");
      const msgs = await getMessagesForPhone(rawPhone, { limit: 1000 });
      let prof: any = null;
      try {
        const { getCollection, COL } = await import("./_utils/mongo");
        const pc = await getCollection(COL.USER_PROFILES);
        prof = await pc.findOne({ _id: rawPhone as any } as any) || await pc.findOne({ phone: rawPhone } as any);
      } catch {}
      const name = prof?.name || "";
      const bubbles = msgs.length ? msgs.map((m) => {
        const out = m.direction === "outbound";
        const when = m.created_at ? new Date(m.created_at).toLocaleString("en-IN") : "";
        const meta = [m.project, m.intent].filter(Boolean).join(" · ");
        return `<div style="display:flex;justify-content:${out ? "flex-end" : "flex-start"};margin:6px 0">
          <div style="max-width:72%;background:${out ? "#dcf8c6" : "#fff"};border:1px solid #e0e0e0;border-radius:10px;padding:8px 11px;box-shadow:0 1px 1px rgba(0,0,0,.06)">
            <div style="font-size:14px;color:#111;white-space:pre-wrap;word-break:break-word">${esc(m.message || "")}</div>
            <div style="font-size:10px;color:#888;margin-top:4px;text-align:right">${out ? "Anandita" : (name || "Customer")}${meta ? " · " + esc(meta) : ""} · ${esc(when)}</div>
          </div>
        </div>`;
      }).join("") : `<div class="empty" style="padding:40px;text-align:center;color:#888">No messages stored for this number.</div>`;
      const inCount = msgs.filter((m) => m.direction === "inbound").length;
      const outCount = msgs.filter((m) => m.direction === "outbound").length;
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Chat — ${esc(name || rawPhone)}</title>
        <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#ece5dd}
        .hdr{position:sticky;top:0;background:#075e54;color:#fff;padding:12px 16px;display:flex;align-items:center;gap:12px}
        .hdr a{color:#fff;text-decoration:none;font-size:20px}.hdr .nm{font-weight:600}.hdr .sub{font-size:12px;opacity:.85}
        .wrap{max-width:780px;margin:0 auto;padding:14px 14px 60px}</style></head>
        <body>
        <div class="hdr"><a href="?view=dashboard" title="Back">←</a>
          <div><div class="nm">${esc(name || rawPhone)}</div><div class="sub">${esc(rawPhone)} · ${msgs.length} messages (${inCount} in / ${outCount} out)</div></div>
        </div>
        <div class="wrap">${bubbles}</div>
        </body></html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(html);
    } catch (err: any) {
      return res.status(500).send(`<pre>Chat view error: ${err.message}</pre>`);
    }
  }

  // Unique-Leads view (HTML) — dedupes Zoho leads by phone, shows one
  // canonical row per phone with chips for every project that phone
  // appears in. Useful when sales wants to see one human even though we
  // have N project records for that human.
  if (req.method === "GET" && req.query.view === "unique-leads") {
    try {
      const html = await renderUniqueLeadsPage();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(html);
    } catch (err: any) {
      return res.status(500).send(`<pre>Unique-Leads error: ${err.message}</pre>`);
    }
  }

  // site-visit-leads-csv — CSV download of every lead currently marked as
  // Pre Site / Virtual Tour / Post Site / Site Visit Done. Approximates
  // "konse din mark kia" using Modified_Time (caveat: any modification
  // after the status change shifts Modified_Time forward — accurate for
  // recent marks, drifts for old leads that got resubmitted/edited).
  //
  // GET /api/chat-history?action=site-visit-leads-csv             (90 days lookback)
  // GET /api/chat-history?action=site-visit-leads-csv&days=30     (custom range)
  // GET /api/chat-history?action=site-visit-leads-csv&format=html (browser preview)
  if (req.method === "GET" && req.query.action === "site-visit-leads-csv") {
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    const authedBySecret = !!expectedSecret && incomingSecret === expectedSecret;
    if (!session && !authedBySecret) {
      return res.status(401).json({ error: "Unauthorized — log in OR pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }

    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();

      const daysBack = Math.max(1, Math.min(365, Number(req.query.days) || 90));
      const cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;

      // Status values that count as "Pre Site / Virtual Tour / Post Site".
      // Match case-insensitively against Lead_Status AND PRD_Stage so a
      // lead in either column gets caught.
      const TARGET_KEYWORDS = [
        "pre site",
        "pre site visit",
        "virtual tour",
        "post site",
        "site visit done",
        "site visited",
        "site visit booked",
      ];
      const matches = (s: any): string => {
        const v = String(s || "").trim().toLowerCase();
        return TARGET_KEYWORDS.find((k) => v.includes(k)) || "";
      };

      const fields = [
        "id", "First_Name", "Last_Name", "Mobile", "Email",
        "ASBL_Project", "Lead_Status", "Lead_Source",
        "PRD_Stage", "PRD_Status", "PRD_Last_Action_Time", "PRD_Last_Action",
        "Site_Visit_Date",
        "Created_Time", "Modified_Time",
        "Master_Lead_ID", "Project_Lead_ID",
      ].join(",");

      // Paginate Zoho (sort Modified_Time desc so we hit the recent ones
      // first; stop when we cross cutoff).
      const out: any[] = [];
      const perPage = 200;
      const MAX_PAGES = 25;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await fetch(
          `${ZOHO_API_BASE}/Leads?fields=${fields}&per_page=${perPage}&page=${page}&sort_by=Modified_Time&sort_order=desc`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
        );
        if (r.status === 204) break;
        if (!r.ok) {
          const text = (await r.text()).slice(0, 200);
          return res.status(r.status).json({ error: "zoho-list failed", page, body: text });
        }
        const j = await r.json() as any;
        const arr: any[] = j?.data || [];
        if (!arr.length) break;
        // Check if oldest in this page is past cutoff — stop pagination
        const oldestMs = arr.reduce((acc, l) => {
          const t = new Date(l.Modified_Time || 0).getTime();
          return Math.min(acc, t);
        }, Date.now());
        for (const l of arr) {
          const matched = matches(l.Lead_Status) || matches(l.PRD_Stage);
          if (!matched) continue;
          const modMs = new Date(l.Modified_Time || 0).getTime();
          if (modMs < cutoffMs) continue;
          out.push({ ...l, _matched_keyword: matched });
        }
        if (!j?.info?.more_records) break;
        if (oldestMs < cutoffMs) break; // no point pulling older pages
      }

      // Sort matched results: newest Modified_Time first.
      out.sort((a, b) =>
        new Date(b.Modified_Time || 0).getTime() - new Date(a.Modified_Time || 0).getTime(),
      );

      // ── Fetch ACCURATE status-change time per lead ─────────────────────
      // Modified_Time is useless for this report — cron jobs (mark-unique-leads,
      // prd-cadence) touch every lead daily, so every Modified_Time is "today".
      // The real "kab mark hua" lives in Zoho's modification_history API.
      // We walk the history newest-first and look for the latest entry where
      // Lead_Status OR PRD_Stage flipped to one of our target keywords.
      //
      // 1 API call per matched lead → cap at 400 leads and run batches of
      // 5 in parallel to stay under Vercel's 60s budget. Leads outside the
      // cap fall back to Modified_Time (flagged with "~" in the CSV).
      const MAX_DETAIL = 400;
      const BATCH_SIZE = 5;
      const detailScope = out.slice(0, MAX_DETAIL);
      const droppedFromDetail = Math.max(0, out.length - MAX_DETAIL);
      const actualChangeTimes = new Map<string, string>();
      let historyApiOk = true; // toggles false if endpoint 4xx-es on first probe

      const fetchStatusChangeTime = async (leadId: string): Promise<string | null> => {
        try {
          const r = await fetch(
            `${ZOHO_API_BASE}/Leads/${leadId}/_modification_history?per_page=200`,
            { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
          );
          if (r.status === 401 || r.status === 403 || r.status === 404) {
            historyApiOk = false;
            return null;
          }
          if (r.status === 204 || !r.ok) return null;
          const j = await r.json() as any;
          const entries = (j?.data || []) as any[];
          // Walk newest-first; first hit on Lead_Status or Stage wins.
          for (const entry of entries) {
            const fields = (entry?.field_history || entry?.fields_changed || []) as any[];
            for (const f of fields) {
              const apiName = f?.api_name || f?.field || "";
              if (apiName === "Lead_Status" || apiName === "Stage" || apiName === "PRD_Stage") {
                const t = entry?.modified_time || entry?.time || entry?.changed_at;
                if (t) return t;
              }
            }
          }
          return null;
        } catch {
          return null;
        }
      };

      for (let i = 0; i < detailScope.length; i += BATCH_SIZE) {
        const batch = detailScope.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (l) => ({ id: l.id, t: await fetchStatusChangeTime(l.id) })),
        );
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.t) {
            actualChangeTimes.set(r.value.id, r.value.t);
          }
        }
        // Early-exit if first batch hit auth — endpoint not available on plan
        if (!historyApiOk && i === 0) break;
      }

      // Re-filter detailScope by ACCURATE time against the lookback window.
      // Leads where we got a real change time: keep only if within window.
      // Leads where we have no real change time: keep with fallback flag.
      const enriched = detailScope
        .map((l) => {
          const actual = actualChangeTimes.get(l.id) || null;
          const ts = actual || l.Modified_Time || null;
          const tsMs = ts ? new Date(ts).getTime() : 0;
          return { lead: l, actual, ts, tsMs };
        })
        .filter((e) => {
          if (e.actual) return e.tsMs >= cutoffMs;
          return true; // keep without real change time — flagged in row
        })
        .sort((a, b) => b.tsMs - a.tsMs);

      // ── Build rows ────────────────────────────────────────────────────
      const ZOHO_BASE = "https://crm.zoho.in";
      const fmtIstDate = (iso: string | null) => {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        // Use Intl to get IST date + time
        const dateFmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Kolkata",
          year: "numeric", month: "2-digit", day: "2-digit",
        }).format(d);
        const timeFmt = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit", minute: "2-digit", hour12: false,
        }).format(d);
        return { date: dateFmt, time: timeFmt };
      };

      const rows = enriched.map((e) => {
        const l = e.lead;
        const mod = fmtIstDate(e.ts) as any;
        const name = [l.First_Name, l.Last_Name].filter(Boolean).join(" ").trim() || "—";
        const sv = fmtIstDate(l.Site_Visit_Date) as any;
        const dateSuffix = e.actual ? "" : " (approx)";
        return {
          "Marked Date (IST)": (mod?.date || "") + dateSuffix,
          "Marked Time (IST)": mod?.time || "",
          "Lead Name": name,
          "Phone": String(l.Mobile || ""),
          "Email": String(l.Email || ""),
          "Project": String(l.ASBL_Project || ""),
          "Lead Status": String(l.Lead_Status || ""),
          "PRD Stage": String(l.PRD_Stage || ""),
          "PRD Status": String(l.PRD_Status || ""),
          "Site Visit Date": sv?.date || "",
          "Last Action": String(l.PRD_Last_Action || ""),
          "Lead Source": String(l.Lead_Source || ""),
          "Zoho URL": `${ZOHO_BASE}/crm/tab/Leads/${l.id}`,
        };
      });

      const wantHtml = String(req.query.format || "").toLowerCase() === "html";
      const todayIst = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());

      if (wantHtml) {
        // Browser preview — table grouped by date
        const byDate = new Map<string, any[]>();
        for (const r of rows) {
          const k = r["Marked Date (IST)"] || "(unknown)";
          let arr = byDate.get(k);
          if (!arr) { arr = []; byDate.set(k, arr); }
          arr.push(r);
        }
        const sortedDates = Array.from(byDate.keys()).sort().reverse();
        const sections = sortedDates.map((dk) => {
          const arr = byDate.get(dk)!;
          const trs = arr.map((r) => `<tr>
            <td>${esc(r["Marked Time (IST)"])}</td>
            <td>${esc(r["Lead Name"])}</td>
            <td><code>${esc(r["Phone"])}</code></td>
            <td>${esc(r["Project"])}</td>
            <td><strong>${esc(r["Lead Status"])}</strong></td>
            <td>${esc(r["PRD Stage"])} / ${esc(r["PRD Status"])}</td>
            <td>${esc(r["Site Visit Date"])}</td>
            <td><a href="${r["Zoho URL"]}" target="_blank" rel="noopener">Open ↗</a></td>
          </tr>`).join("");
          return `<h2 style="margin-top:24px">${esc(dk)} <span style="color:#888;font-weight:normal;font-size:14px">(${arr.length} marked)</span></h2>
            <table>
              <tr><th>Time</th><th>Name</th><th>Phone</th><th>Project</th><th>Lead Status</th><th>PRD</th><th>Site Visit Date</th><th></th></tr>
              ${trs}
            </table>`;
        }).join("");
        const downloadHref = `?action=site-visit-leads-csv&days=${daysBack}`;
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pre Site / Virtual Tour / Post Site Leads</title>
${SHARED_STYLE}
</head><body>
<header class="topbar">
  <div class="brand"><a href="?view=dashboard">ASBL CRM</a></div>
  <nav><a href="?view=dashboard">← Dashboard</a></nav>
</header>
<main class="container">
  <h1 class="page-title">Pre Site / Virtual Tour / Post Site marks (last ${daysBack} days)</h1>
  <p class="page-sub">
    ${rows.length} leads shown. <a href="${downloadHref}" class="btn-primary" style="text-decoration:none;display:inline-block;padding:6px 14px;border-radius:6px">⬇ Download CSV</a>
    <span style="color:#888;font-size:13px;margin-left:14px">
      Marked Date = actual Lead_Status / Stage change time from Zoho's
      modification history. Rows tagged "<em>(approx)</em>" fell back to
      Modified_Time because we couldn't get the precise change time
      (history beyond ${MAX_DETAIL} leads OR history-API unavailable).
      ${droppedFromDetail > 0 ? `<br>Note: ${droppedFromDetail} match${droppedFromDetail === 1 ? "" : "es"} beyond the ${MAX_DETAIL}-lead detail cap were dropped — bump &days=N down to a tighter window if you need them.` : ""}
      ${!historyApiOk ? `<br><strong style="color:#a00">⚠ Modification-history API returned 401/403/404 — falling back to Modified_Time for all rows. Likely a Zoho plan / scope issue.</strong>` : ""}
    </span>
  </p>
  ${rows.length ? sections : `<div class="empty">No leads matched in the last ${daysBack} days.</div>`}
</main></body></html>`;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).send(html);
      }

      // ── CSV mode ───────────────────────────────────────────────────────
      const cols = [
        "Marked Date (IST)", "Marked Time (IST)", "Lead Name", "Phone", "Email",
        "Project", "Lead Status", "PRD Stage", "PRD Status",
        "Site Visit Date", "Last Action", "Lead Source", "Zoho URL",
      ];
      const csvEscape = (v: any): string => {
        const s = String(v ?? "");
        if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };
      const headerLine = cols.map(csvEscape).join(",");
      const bodyLines = rows.map((r) =>
        cols.map((c) => csvEscape((r as any)[c])).join(","),
      );
      const csv = [headerLine, ...bodyLines].join("\n");

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="site-visit-leads-${todayIst}-${daysBack}d.csv"`,
      );
      res.setHeader("Cache-Control", "no-store");
      // Excel sniffs the BOM for UTF-8 detection
      return res.status(200).send("﻿" + csv);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // mark-unique-leads — full sweep that sets Is_Unique_Lead=true on the
  // most-recently-modified record per phone and false on the rest. Driven
  // both by manual admin trigger (this endpoint) and the hourly cron task
  // (/api/cron/followup?task=mark-unique-leads). Idempotent.
  //
  // GET  ?action=mark-unique-leads&secret=<INHOUSE_POSTHOOK_SECRET>     (dashboard button via JS fetch)
  // POST ?action=mark-unique-leads&secret=<INHOUSE_POSTHOOK_SECRET>     (same body)
  if ((req.method === "GET" || req.method === "POST") && req.query.action === "mark-unique-leads") {
    // Auth via session (dashboard) OR shared secret (curl / cron).
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    const authedBySecret = !!expectedSecret && incomingSecret === expectedSecret;
    if (!session && !authedBySecret) {
      return res.status(401).json({ error: "Unauthorized — log in OR pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    try {
      const { syncUniqueLeadFlags } = await import("./_utils/unique_leads");
      const r = await syncUniqueLeadFlags();
      return res.status(200).json({ ok: true, ...r });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message });
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
    if (result.ok) {
      const { logAudit, clientIp } = await import("./_utils/audit");
      const sess = (req as any)._session;
      await logAudit({
        actor_email: sess?.email || "(unknown)",
        action: "save-facts",
        target: `project_facts/${project}`,
        summary: `${sess?.email || "?"} edited ${project} offer text (${(factsText.length / 1024).toFixed(1)} KB)`,
        ip: clientIp(req),
      });
    }
    const msg = result.ok ? `Saved (${(factsText.length / 1024).toFixed(1)} KB).` : `Error: ${result.error}`;
    res.setHeader("Location", `?view=edit-facts&project=${encodeURIComponent(project)}&msg=${encodeURIComponent(msg)}`);
    return res.status(303).end();
  }

  // ─── leads-export — CSV of Mongo `leads` filtered by lead_received_at ─────
  // Secret-gated (curl-friendly, for Excel). One row per lead whose
  // lead_received_at is on/after ?since=YYYY-MM-DD:
  //   Phone Number, Source Lead Id, Project, Lead recieved at
  //
  //   GET /api/chat-history?action=leads-export&since=2026-07-17&secret=<INHOUSE_POSTHOOK_SECRET>
  //
  // lead_received_at is stored as an ISO-8601 string, so a lexicographic $gte on
  // the date prefix is chronologically correct ("2026-07-25T..." >= "2026-07-17").
  // The cutoff is compared against the stored UTC ISO value; pass a full
  // "2026-07-16T18:30:00Z" for an IST-midnight cutoff instead of UTC-midnight.
  if (req.method === "GET" && req.query.action === "leads-export") {
    const incomingSecret =
      (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    const sess = (req as any)._session;
    if (!sess && (!expectedSecret || incomingSecret !== expectedSecret)) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=..." });
    }
    const since = String(req.query.since || "").trim();
    if (!since) {
      return res
        .status(400)
        .json({ error: "since=YYYY-MM-DD required (e.g. since=2026-07-17)" });
    }
    // ?enrich=zoho → also fetch each lead's Zoho Created_Time (the TRUE original
    // arrival — immune to the lead_received_at resubmit-clobber). Batched 100
    // ids/call; use &page=&pageSize= to bound the Zoho calls per request so a
    // large set never trips the 60s function limit.
    const enrichZoho = String(req.query.enrich || "") === "zoho";
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 100000, 1), 100000);
    const page = Math.max(Number(req.query.page) || 0, 0);
    try {
      const { getCollection, COL } = await import("./_utils/mongo");
      const col = await getCollection(COL.LEADS);
      const rows = (await col
        .find(
          { lead_received_at: { $gte: since } } as any,
          {
            projection: {
              _id: 0,
              phone: 1,
              source_lead_id: 1,
              project: 1,
              lead_received_at: 1,
              // first_received_at is the origin-immutable arrival (only present on
              // leads created after the born-immutable fix; blank for older docs).
              first_received_at: 1,
              zoho_lead_id: 1,
            },
          },
        )
        .sort({ lead_received_at: 1 })
        .skip(page * pageSize)
        .limit(pageSize)
        .toArray()) as any[];

      // Optional Zoho Created_Time enrichment — bulk GET by ids (max 100/call).
      const createdByZohoId: Record<string, string> = {};
      if (enrichZoho) {
        const { getAccessToken } = await import("./_utils/zoho");
        const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
        const token = await getAccessToken();
        const ids = [
          ...new Set(rows.map((r) => r.zoho_lead_id).filter(Boolean).map(String)),
        ];
        for (let i = 0; i < ids.length; i += 100) {
          const batch = ids.slice(i, i + 100);
          try {
            const zr = await fetch(
              `${ZOHO_API_BASE}/Leads?ids=${batch.join(",")}&fields=id,Created_Time`,
              { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
            );
            const zj = (await zr.json().catch(() => ({}))) as any;
            for (const rec of zj?.data || []) {
              if (rec?.id) createdByZohoId[String(rec.id)] = rec.Created_Time || "";
            }
          } catch (e: any) {
            console.error(`[leads-export] Zoho batch fetch failed: ${e.message}`);
          }
        }
      }

      const csvEsc = (v: any) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const cols = [
        "Phone Number",
        "Source Lead Id",
        "Project",
        "Lead recieved at",
        "First received at",
        "Zoho Lead Id",
      ];
      if (enrichZoho) cols.push("Zoho Created Time");
      const header = cols.join(",");
      const lines = rows.map((r) => {
        const base = [
          r.phone,
          r.source_lead_id,
          r.project,
          r.lead_received_at,
          r.first_received_at,
          r.zoho_lead_id,
        ];
        if (enrichZoho) base.push(createdByZohoId[String(r.zoho_lead_id)] || "");
        return base.map(csvEsc).join(",");
      });
      // Header only on the first page so paginated pulls concatenate cleanly.
      const csv = (page === 0 ? [header, ...lines] : lines).join("\n") + "\n";
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="leads_since_${since.slice(0, 10)}${enrichZoho ? "_enriched" : ""}_p${page}.csv"`,
      );
      return res.status(200).send(csv);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
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

      // Store the original source file in Mongo GridFS (NOT Supabase) for
      // reference/backup. The bot only ever uses extractedText (kb_text), so
      // even if this fails the KB still works — but GridFS keeps us off any
      // external store. Best-effort; never block the KB save on it.
      let kbPdfUrl = "";
      try {
        const { storeFile, fileServeUrl } = await import("./_utils/mongo_files");
        const fid = await storeFile(decodeBase64Buffer(base64), filename, mimeType, { project, kind: "kb_source" });
        kbPdfUrl = fileServeUrl(fid);
      } catch (e: any) {
        console.warn(`[upload-kb] source-file store failed (non-fatal): ${e.message}`);
      }

      // Save extracted KB text + source URL into project_facts.kb_text
      // (kept SEPARATE from facts_text so curated OFFER details are never overwritten)
      const saveResult = await saveProjectKb(project, extractedText, kbPdfUrl);
      if (!saveResult.ok) {
        return res.status(500).json({ error: `Save failed: ${saveResult.error}` });
      }

      return res.status(200).json({
        ok: true,
        project,
        extractedChars: extractedText.length,
        publicUrl: kbPdfUrl,
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

      // Store the PDF binary in Mongo GridFS (NOT Supabase) and serve it from
      // our own public endpoint. This removes the external-storage dependency
      // that caused every doc to break when the Supabase project was deleted.
      const { storeFile, fileServeUrl } = await import("./_utils/mongo_files");
      const fileBuf = decodeBase64Buffer(base64);
      const fileId = await storeFile(fileBuf, filename, mimeType, { project, doc_type: docType, size_label: sizeLabel });
      const publicUrl = fileServeUrl(fileId);

      // Insert row in project_documents (metadata only; binary is in GridFS)
      const insertBody: any = {
        project,
        doc_type: docType,
        filename,
        url: publicUrl,
        file_id: fileId,
        storage: "mongo_gridfs",
      };
      if (sizeLabel) insertBody.size_label = sizeLabel;
      // Strict-lookup meta from the dashboard form (multi-slot docs)
      if (body.unit_size_sft != null && body.unit_size_sft !== "") insertBody.unit_size_sft = Number(body.unit_size_sft);
      if (body.facing) insertBody.facing = String(body.facing).toLowerCase();
      if (body.tower) insertBody.tower = String(body.tower);
      if (body.applies_to_all === true || body.applies_to_all === "true") insertBody.applies_to_all = true;

      // Extract text from the PDF (binary already in memory) so it feeds the
      // bot's KB / grounding. Best-effort — never block the upload on it.
      let extractChars = 0;
      try {
        if ((mimeType || "").includes("pdf") || filename.toLowerCase().endsWith(".pdf")) {
          const text = await extractTextFromPDF(fileBuf);
          if (text && text.trim()) {
            insertBody.text_extract = text.slice(0, 8000);
            insertBody.text_extract_chars = text.length;
            insertBody.text_extracted_at = new Date().toISOString();
            extractChars = text.length;
          }
        }
      } catch (err: any) {
        console.warn(`[upload-doc] text extract failed (non-fatal): ${err.message}`);
      }

      let insertedId: string;
      try {
        insertedId = await insertDoc(insertBody);
      } catch (err: any) {
        return res.status(500).json({ error: `DB insert failed: ${err.message}` });
      }
      const inserted = { _id: insertedId, ...insertBody };
      return res.status(200).json({
        ok: true,
        project,
        docType,
        sizeLabel,
        storage: "mongo_gridfs",
        publicUrl,
        text_extract_chars: extractChars,
        record: { ...inserted, text_extract: undefined },
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

      // Pull last 5 WhatsApp messages to summarise prior intent (Phase 4: Mongo)
      let lastWaIntent: string | null = null;
      let lastWaMessage: string | null = null;
      try {
        const { getLastMessagesWithIntent } = await import("./_utils/whatsapp_messages");
        const rows = await getLastMessagesWithIntent(phone, 5);
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

      const fields = "id,First_Name,Last_Name,Mobile,Email,ASBL_Project,Lead_Status,Lead_Source,Last_Intent,Call_Status,Call_Duration,Total_Call_Duration_Secs,Last_Inhouse_Call_ID,Last_Arrowhead_Call_ID,Master_Lead_ID,Project_Lead_ID,Created_Time,Modified_Time,PRD_Stage,PRD_Status,PRD_Last_Action_Time,Chatbot_Attempt_Count,Chatbot_Follow_up_Count,SS_Call_Attempt_Count";

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
  // ─── Create the 7 per-section time-spent Zoho fields (Inncircles) ───────
  //   GET ?action=zoho-create-timespent-fields&secret=<INHOUSE_POSTHOOK_SECRET>
  //   Idempotent — skips any api_name that already exists. Decimal number
  //   fields on the Leads module.
  if (req.method === "GET" && req.query.action === "zoho-create-timespent-fields") {
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
      if (!fr.ok) return res.status(fr.status).json({ error: "field-list failed", body: (await fr.text()).slice(0, 500) });
      const fj = (await fr.json()) as any;
      const existingApis = new Set((fj?.fields || []).map((f: any) => f.api_name));
      const desired = [
        { api: "Home_Timespent",          label: "Home Timespent" },
        { api: "Plans_Timespent",         label: "Plans Timespent" },
        { api: "Price_Timespent",         label: "Price Timespent" },
        { api: "Location_Timespent",      label: "Location Timespent" },
        { api: "Specification_Timespent", label: "Specification Timespent" },
        { api: "Amenities_Timespent",     label: "Amenities Timespent" },
        { api: "Media_Timespent",         label: "Media Timespent" },
      ];
      const results: any[] = [];
      for (const d of desired) {
        if (existingApis.has(d.api)) { results.push({ api: d.api, status: "already_exists" }); continue; }
        // Zoho requires `length` alongside `decimal_place` for double fields
        // (length = total digits incl. decimals, must be > decimal_place),
        // else the create call 400s. 16 is Zoho's max for decimal fields.
        const body = { fields: [{ field_label: d.label, data_type: "double", length: 16, decimal_place: 2 }] };
        const cr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await cr.json().catch(() => ({}));
        const ok = cr.status >= 200 && cr.status < 300;
        results.push({ api: d.api, label: d.label, status: ok ? "created" : "failed", http_status: cr.status, response: ok ? "ok" : j });
      }
      return res.status(200).json({ ok: true, module: "Leads", results });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

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

  // ─── Backfill Last_Inhouse_Call_ID for leads stuck due to PATCH bug ─────
  // GET/POST ?action=backfill-inhouse-call-id&secret=<INHOUSE_POSTHOOK_SECRET>&dry=1|0&days=N
  //
  // Until 2026-06-03 the relay handler bundled Lead_Status+Last_Inhouse_Call_ID
  // in a single PATCH. Zoho's blueprint rejected the whole PATCH whenever
  // Lead_Status couldn't be set directly from the lead's current state →
  // Last_Inhouse_Call_ID was silently dropped on EVERY trigger after T=0.
  // This endpoint walks recent leads, finds the latest "Arrowhead Call — <uuid>"
  // note attached to each, and PATCHes Last_Inhouse_Call_ID with that uuid.
  // Posthook lookup now works again for these backfilled leads.
  //
  // Defaults: dry=1 (REPORT ONLY, no writes), days=30, limit=2000.
  if ((req.method === "GET" || req.method === "POST") && req.query.action === "backfill-inhouse-call-id") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    const dry = String(req.query.dry ?? "1") !== "0"; // default DRY
    const days = Math.max(1, Math.min(90, Number(req.query.days ?? 30)));
    const limit = Math.max(1, Math.min(5000, Number(req.query.limit ?? 2000)));

    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZBASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();
      const HDR = { Authorization: `Zoho-oauthtoken ${token}` };

      // 1. List recent leads, last N days, paginated. Pull only the fields we need.
      const sinceDate = new Date(Date.now() - days * 86400_000).toISOString();
      const FIELDS = "id,First_Name,Last_Name,Mobile,Last_Inhouse_Call_ID,Last_Arrowhead_Call_ID,SS_Call_Attempt_Count,PRD_Stage,PRD_Status,Modified_Time,Created_Time";
      const candidates: any[] = [];
      const PAGE_SIZE = 200;
      for (let page = 1; page <= Math.ceil(limit / PAGE_SIZE); page++) {
        const u = `${ZBASE}/Leads?fields=${FIELDS}&per_page=${PAGE_SIZE}&page=${page}&sort_by=Modified_Time&sort_order=desc`;
        const r = await fetch(u, { headers: HDR });
        if (r.status === 204) break;
        if (!r.ok) {
          return res.status(r.status).json({ error: "Zoho leads list failed", body: (await r.text()).slice(0, 500) });
        }
        const j = (await r.json()) as any;
        const rows: any[] = j?.data || [];
        // Stop when we hit a lead older than sinceDate
        let hitOld = false;
        for (const row of rows) {
          if (row.Modified_Time && row.Modified_Time < sinceDate) { hitOld = true; break; }
          candidates.push(row);
        }
        if (hitOld || !j?.info?.more_records) break;
      }

      // 2. Filter for stuck leads: empty Last_Inhouse_Call_ID + (SS counter>0 OR PRD_Status set)
      const stuckLeads = candidates.filter(
        (l) =>
          (!l.Last_Inhouse_Call_ID || String(l.Last_Inhouse_Call_ID).trim() === "") &&
          (Number(l.SS_Call_Attempt_Count ?? 0) > 0 || l.PRD_Status === "SS" || l.PRD_Status === "CF"),
      );

      // 3. For each, fetch notes and find latest "Arrowhead Call — <uuid>" (no recording suffix)
      const CALL_NOTE_RE = /Arrowhead Call\s*[—-]+\s*([a-f0-9-]{36})\s*$/i;
      const planned: any[] = [];
      const noNote: any[] = [];
      const updated: any[] = [];
      const failed: any[] = [];

      // Cap how many we process to keep response under Vercel timeout
      const PROCESS_CAP = 200;
      const toProcess = stuckLeads.slice(0, PROCESS_CAP);

      for (const lead of toProcess) {
        try {
          // Fetch notes for this lead via search (Parent_Id criteria).
          // Zoho returns 204 No Content when there are NO matching notes —
          // calling .json() on an empty body throws "Unexpected end of
          // JSON input". Read text first, only parse when non-empty.
          const noteR = await fetch(
            `${ZBASE}/Notes/search?criteria=(Parent_Id:equals:${lead.id})&fields=Note_Title,Created_Time`,
            { headers: HDR },
          );
          let callId: string | null = null;
          let noteId: string | null = null;
          if (noteR.ok && noteR.status !== 204) {
            const txt = await noteR.text();
            if (txt.trim()) {
              let nj: any = null;
              try { nj = JSON.parse(txt); } catch {}
              const notes: any[] = nj?.data || [];
              // Sort by Created_Time desc, find first match
              notes.sort((a, b) => String(b.Created_Time || "").localeCompare(String(a.Created_Time || "")));
              for (const n of notes) {
                const m = CALL_NOTE_RE.exec(String(n.Note_Title || ""));
                if (m) { callId = m[1]; noteId = n.id; break; }
              }
            }
          }

          if (!callId) {
            noNote.push({ lead_id: lead.id, name: [lead.First_Name, lead.Last_Name].filter(Boolean).join(" "), mobile: lead.Mobile });
            continue;
          }

          planned.push({
            lead_id: lead.id,
            name: [lead.First_Name, lead.Last_Name].filter(Boolean).join(" "),
            mobile: lead.Mobile,
            ss_count: lead.SS_Call_Attempt_Count,
            prd_status: lead.PRD_Status,
            backfill_call_id: callId,
            source_note: noteId,
          });

          if (!dry) {
            const pr = await fetch(`${ZBASE}/Leads`, {
              method: "PATCH",
              headers: { ...HDR, "Content-Type": "application/json" },
              body: JSON.stringify({ data: [{ id: lead.id, Last_Inhouse_Call_ID: callId }] }),
            });
            const pj = await pr.json().catch(() => ({}));
            const pjData = (pj as any)?.data?.[0];
            if (pr.ok && pjData?.status === "success") {
              updated.push({ lead_id: lead.id, call_id: callId });
            } else {
              failed.push({ lead_id: lead.id, call_id: callId, error: pjData || pj || `HTTP ${pr.status}` });
            }
          }
        } catch (err: any) {
          failed.push({ lead_id: lead.id, error: err.message });
        }
      }

      return res.status(200).json({
        timestamp: new Date().toISOString(),
        dry_run: dry,
        scope: { days, limit, processed: toProcess.length, candidates_total: candidates.length, stuck_total: stuckLeads.length, process_cap: PROCESS_CAP },
        planned_count: planned.length,
        no_callable_note_count: noNote.length,
        updated_count: updated.length,
        failed_count: failed.length,
        planned: planned.slice(0, 50),
        no_note_sample: noNote.slice(0, 10),
        updated_sample: updated.slice(0, 50),
        failed_sample: failed.slice(0, 10),
        hint: dry
          ? "Dry run — pass &dry=0 to apply. Re-run if stuck_total > process_cap to chunk."
          : `Applied. ${updated.length} stamped, ${failed.length} failed.`,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Backfill completed-call data (transcript / recording / outcome) ────
  // GET ?action=backfill-call-completions&secret=<INHOUSE_POSTHOOK_SECRET>&dry=1|0&days=14&limit=200
  //
  // The posthook auth-mismatch saga (whk_...ca3d vs cd98...aa41) caused a
  // window of completed calls whose webhook delivery 401-rejected — their
  // transcript / recording_url / call_outcome never reached Zoho. Their
  // Last_Inhouse_Call_ID IS stamped (relay → bot trigger worked), but the
  // posthook-driven downstream updates (Call_Status, Note, Call log) are
  // missing.
  //
  // This endpoint:
  //   1. Walks Zoho leads with Last_Inhouse_Call_ID set + Call_Status in
  //      (null, "Not Called") — they got triggered but never reconciled.
  //   2. For each, GETs the bot's /api/calls/<call_id> (built by dev
  //      2026-06-08) which returns the same shape the call_completed
  //      webhook would have sent.
  //   3. Synthetically POSTs that payload to our own /api/relay/inhouse-
  //      posthook with the matching secret — the existing posthook handler
  //      then does the proper Zoho write + Mongo mirror + Note + Call log.
  //   4. Returns per-lead status. Idempotent — re-runnable safely.
  if ((req.method === "GET" || req.method === "POST") && req.query.action === "backfill-call-completions") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    const dry = String(req.query.dry ?? "1") !== "0";
    const days = Math.max(1, Math.min(60, Number(req.query.days ?? 14)));
    const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 200)));

    const BOT_BASE_URL = (process.env.ASBL_VOICEBOT_URL || "https://angad-bot.onrender.com").replace(/\/+$/, "");
    const BOT_API_KEY = process.env.ASBL_VOICEBOT_API_KEY || "";
    const SELF_BASE_URL = process.env.SELF_PUBLIC_URL || "https://asbl-crm-api.vercel.app";

    if (!BOT_API_KEY) {
      return res.status(500).json({ error: "ASBL_VOICEBOT_API_KEY env var missing — required for bot's GET /api/calls/<id>" });
    }

    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZBASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();
      const HDR = { Authorization: `Zoho-oauthtoken ${token}` };

      // 1. List leads with any backfill key but no reconciliation yet.
      const sinceDate = new Date(Date.now() - days * 86400_000).toISOString();
      const FIELDS = "id,First_Name,Last_Name,Mobile,Last_Inhouse_Call_ID,Last_Arrowhead_Call_ID,Call_Status,Call_Duration,Modified_Time";
      const candidates: any[] = [];
      const PAGE_SIZE = 200;
      for (let page = 1; page <= Math.ceil(limit / PAGE_SIZE); page++) {
        const u = `${ZBASE}/Leads?fields=${FIELDS}&per_page=${PAGE_SIZE}&page=${page}&sort_by=Modified_Time&sort_order=desc`;
        const r = await fetch(u, { headers: HDR });
        if (r.status === 204) break;
        if (!r.ok) {
          return res.status(r.status).json({ error: "Zoho leads list failed", body: (await r.text()).slice(0, 500) });
        }
        const j = (await r.json()) as any;
        const rows: any[] = j?.data || [];
        let hitOld = false;
        for (const row of rows) {
          if (row.Modified_Time && row.Modified_Time < sinceDate) { hitOld = true; break; }
          candidates.push(row);
        }
        if (hitOld || !j?.info?.more_records) break;
      }

      // Filter: has any backfill key, no proper Call_Status reconciliation yet.
      const stuck = candidates.filter((l) => {
        const hasInhouseId = l.Last_Inhouse_Call_ID && String(l.Last_Inhouse_Call_ID).trim() !== "";
        const hasArrowheadId = l.Last_Arrowhead_Call_ID && String(l.Last_Arrowhead_Call_ID).trim() !== "";
        const notReconciled = !l.Call_Status || l.Call_Status === "Not Called";
        return (hasInhouseId || hasArrowheadId) && notReconciled;
      });

      const PROCESS_CAP = 100;
      const toProcess = stuck.slice(0, PROCESS_CAP);

      const results: any[] = [];
      let appliedCount = 0;
      let inProgressCount = 0;       // bot 204 — call still initiated/dialing
      let notFoundOnBotCount = 0;    // bot 404 — call_id unknown to bot
      let botAuthFailedCount = 0;    // bot 401 — our bearer doesn't match bot's env
      let botFetchFailedCount = 0;   // any other non-2xx
      let posthookFailedCount = 0;   // our posthook returned non-2xx
      let dryCount = 0;

      for (const lead of toProcess) {
        const leadId = lead.id;
        const phone = lead.Mobile;
        const inhouseCallId = lead.Last_Inhouse_Call_ID ? String(lead.Last_Inhouse_Call_ID).trim() : "";
        const externalScheduleId = lead.Last_Arrowhead_Call_ID ? String(lead.Last_Arrowhead_Call_ID).trim() : "";

        // Per dev 2026-06-08: prefer external_schedule_id (stable across
        // Plivo connected-call requestUuid → CallUUID promotion). Bot's
        // GET /api/calls/<id> accepts either, but external_schedule_id
        // hits every lookup priority. Fall back to call_id only if no
        // external_schedule_id stored (legacy leads from before the
        // 2026-06-08 stamp-both-fields fix).
        const lookupKey = externalScheduleId || inhouseCallId;
        const lookupKeyType = externalScheduleId ? "external_schedule_id" : "call_id";
        const callId = inhouseCallId || externalScheduleId; // for results display

        try {
          // 2. Fetch call data from bot
          const botUrl = `${BOT_BASE_URL}/api/calls/${encodeURIComponent(lookupKey)}`;
          const botRes = await fetch(botUrl, {
            method: "GET",
            headers: { Authorization: `Bearer ${BOT_API_KEY}` },
          });

          // 204: call still in-progress on bot side — not a failure, retry later
          if (botRes.status === 204) {
            inProgressCount++;
            results.push({ lead_id: leadId, call_id: callId, phone, status: "in_progress_on_bot", code: 204, lookup: lookupKeyType });
            continue;
          }
          // 404: bot doesn't know this call_id — data permanently lost, skip
          if (botRes.status === 404) {
            notFoundOnBotCount++;
            results.push({ lead_id: leadId, call_id: callId, phone, status: "call_not_found_on_bot", code: 404, lookup: lookupKeyType, lookup_key: lookupKey });
            continue;
          }
          // 401: our ASBL_VOICEBOT_API_KEY doesn't match bot's env — abort whole run
          if (botRes.status === 401) {
            botAuthFailedCount++;
            return res.status(500).json({
              error: "Bot rejected our Bearer token — ASBL_VOICEBOT_API_KEY mismatch with bot's env. Fix Vercel env to match what dev set on Render.",
              first_failed_call: callId,
              partial_results: results,
            });
          }
          if (!botRes.ok) {
            botFetchFailedCount++;
            const txt = (await botRes.text()).slice(0, 200);
            results.push({ lead_id: leadId, call_id: callId, phone, status: "bot_fetch_failed", code: botRes.status, body: txt });
            continue;
          }

          // 200 — full call data. Guard against empty body just in case.
          const rawTxt = await botRes.text();
          if (!rawTxt.trim()) {
            inProgressCount++;
            results.push({ lead_id: leadId, call_id: callId, phone, status: "empty_body_treated_as_in_progress" });
            continue;
          }
          let callData: any = null;
          try { callData = JSON.parse(rawTxt); } catch {
            botFetchFailedCount++;
            results.push({ lead_id: leadId, call_id: callId, phone, status: "bot_returned_non_json", body: rawTxt.slice(0, 200) });
            continue;
          }

          if (dry) {
            dryCount++;
            results.push({
              lead_id: leadId,
              call_id: callId,
              phone,
              status: "would_apply",
              outcome: callData?.call_outcome,
              duration: callData?.duration_seconds,
              has_transcript: Boolean(callData?.transcript || callData?.full_text),
              has_recording: Boolean(callData?.recording_url),
            });
            continue;
          }

          // 3. Ensure event field set so posthook handler routes correctly
          if (!callData.event) callData.event = "call_completed";
          if (!callData.call_id) callData.call_id = callId;

          // 4. Synthetic POST to our own posthook with the proper secret
          const phRes = await fetch(`${SELF_BASE_URL}/api/relay/inhouse-posthook`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Webhook-Secret": expectedSecret,
            },
            body: JSON.stringify(callData),
          });
          const phJson = await phRes.json().catch(() => ({}));

          if (phRes.ok) {
            appliedCount++;
            results.push({
              lead_id: leadId,
              call_id: callId,
              phone,
              status: "applied",
              outcome: callData?.call_outcome,
              duration: callData?.duration_seconds,
              posthook_response: phJson,
            });
          } else {
            posthookFailedCount++;
            results.push({
              lead_id: leadId,
              call_id: callId,
              phone,
              status: "posthook_failed",
              code: phRes.status,
              error: phJson,
            });
          }
        } catch (err: any) {
          results.push({ lead_id: leadId, call_id: callId, phone, status: "exception", error: err.message });
        }
      }

      return res.status(200).json({
        timestamp: new Date().toISOString(),
        dry_run: dry,
        scope: {
          days,
          limit,
          candidates_total: candidates.length,
          stuck_total: stuck.length,
          process_cap: PROCESS_CAP,
          processed: toProcess.length,
        },
        applied_count: appliedCount,
        would_apply_count: dryCount,
        in_progress_count: inProgressCount,
        call_not_found_on_bot_count: notFoundOnBotCount,
        bot_auth_failed_count: botAuthFailedCount,
        bot_fetch_failed_count: botFetchFailedCount,
        posthook_failed_count: posthookFailedCount,
        results_sample: results.slice(0, 25),
        hint: dry
          ? "Dry run — pass &dry=0 to actually backfill. Re-run after a few min if in_progress_count > 0."
          : `Applied ${appliedCount}. in-progress=${inProgressCount}, not-found=${notFoundOnBotCount}, bot-fail=${botFetchFailedCount}, posthook-fail=${posthookFailedCount}.`,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Backfill PRD state from Zoho into Mongo `leads` collection ─────────
  // GET/POST ?action=backfill-prd-state&secret=<INHOUSE_POSTHOOK_SECRET>&dry=1|0&days=N
  //
  // One-time backfill after the 2026-06-03 write-through change. Every PRD
  // update site now mirrors to Mongo on the fly, but existing leads have
  // empty PRD fields in Mongo. This endpoint walks recent Zoho leads and
  // copies their PRD state into Mongo. Idempotent — safe to re-run.
  //
  // Defaults: dry=1 (REPORT ONLY), days=60, limit=2000.
  if ((req.method === "GET" || req.method === "POST") && req.query.action === "backfill-prd-state") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    const dry = String(req.query.dry ?? "1") !== "0";
    const days = Math.max(1, Math.min(120, Number(req.query.days ?? 60)));
    const limit = Math.max(1, Math.min(5000, Number(req.query.limit ?? 2000)));

    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const { mirrorLeadStateToMongo } = await import("./_utils/supabase");
      const ZBASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();
      const HDR = { Authorization: `Zoho-oauthtoken ${token}` };

      const sinceDate = new Date(Date.now() - days * 86400_000).toISOString();
      const FIELDS = [
        "id",
        "PRD_Stage", "PRD_Status", "PRD_Last_Action", "PRD_Last_Action_Time",
        "Chatbot_Attempt_Count", "Chatbot_Follow_up_Count", "SS_Call_Attempt_Count",
        "Call_Status", "Call_Duration", "Total_Call_Duration_Secs",
        "Last_Inhouse_Call_ID", "Last_Arrowhead_Call_ID",
        "Lead_Status", "Site_Visit_Date", "Last_Recording_URL",
        "Call_Attempt_Count", "Last_Call_At",
        "Modified_Time",
      ].join(",");

      const PAGE_SIZE = 200;
      const candidates: any[] = [];
      for (let page = 1; page <= Math.ceil(limit / PAGE_SIZE); page++) {
        const u = `${ZBASE}/Leads?fields=${FIELDS}&per_page=${PAGE_SIZE}&page=${page}&sort_by=Modified_Time&sort_order=desc`;
        const r = await fetch(u, { headers: HDR });
        if (r.status === 204) break;
        if (!r.ok) {
          return res.status(r.status).json({ error: "Zoho leads list failed", body: (await r.text()).slice(0, 500) });
        }
        const j = (await r.json()) as any;
        const rows: any[] = j?.data || [];
        let hitOld = false;
        for (const row of rows) {
          if (row.Modified_Time && row.Modified_Time < sinceDate) { hitOld = true; break; }
          candidates.push(row);
        }
        if (hitOld || !j?.info?.more_records) break;
      }

      // Filter to leads that actually have PRD state to mirror (skip blanks)
      const withState = candidates.filter((l) =>
        l.PRD_Stage || l.PRD_Status || l.SS_Call_Attempt_Count || l.Chatbot_Attempt_Count ||
        l.Last_Inhouse_Call_ID || l.Call_Status,
      );

      let updated = 0;
      let skipped = 0;
      const failures: any[] = [];

      if (!dry) {
        for (const lead of withState) {
          try {
            const fields: Record<string, any> = {};
            for (const k of [
              "PRD_Stage", "PRD_Status", "PRD_Last_Action", "PRD_Last_Action_Time",
              "Chatbot_Attempt_Count", "Chatbot_Follow_up_Count", "SS_Call_Attempt_Count",
              "Call_Status", "Call_Duration", "Total_Call_Duration_Secs",
              "Last_Inhouse_Call_ID", "Last_Arrowhead_Call_ID",
              "Lead_Status", "Site_Visit_Date", "Last_Recording_URL",
              "Call_Attempt_Count", "Last_Call_At",
            ]) {
              if (lead[k] !== undefined && lead[k] !== null) fields[k] = lead[k];
            }
            if (!Object.keys(fields).length) { skipped++; continue; }
            await mirrorLeadStateToMongo(lead.id, fields);
            updated++;
          } catch (err: any) {
            failures.push({ lead_id: lead.id, error: err.message });
          }
        }
      }

      return res.status(200).json({
        timestamp: new Date().toISOString(),
        dry_run: dry,
        scope: { days, limit, candidates_total: candidates.length, with_state_total: withState.length },
        updated_count: updated,
        skipped_count: skipped,
        failed_count: failures.length,
        failed_sample: failures.slice(0, 10),
        sample_with_state: withState.slice(0, 5).map((l) => ({
          lead_id: l.id,
          prd_stage: l.PRD_Stage,
          prd_status: l.PRD_Status,
          ss_count: l.SS_Call_Attempt_Count,
          last_inhouse_call_id: l.Last_Inhouse_Call_ID,
          modified: l.Modified_Time,
        })),
        hint: dry ? "Dry run — pass &dry=0 to apply." : `Done. ${updated} mirrored, ${failures.length} failed.`,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Arrowhead cleanup audit ─────────────────────────────────────────────
  // GET ?action=arrowhead-cleanup-audit&secret=<INHOUSE_POSTHOOK_SECRET>
  //   Probes Zoho settings APIs for everything still named "Arrowhead":
  //   workflow rules, custom functions, custom buttons, fields. Tries
  //   multiple endpoint variants because Zoho's v3 settings API surface
  //   isn't fully documented — captures status + raw body of each probe.
  //   Used 2026-05-30 to plan the Arrowhead → in-house migration cleanup.
  if (req.method === "GET" && req.query.action === "arrowhead-cleanup-audit") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZBASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();
      const HDR = { Authorization: `Zoho-oauthtoken ${token}` };

      async function probe(label: string, path: string) {
        try {
          const r = await fetch(`${ZBASE}${path}`, { headers: HDR });
          const txt = await r.text();
          let body: any = null;
          if (txt.trim()) { try { body = JSON.parse(txt); } catch { body = txt.slice(0, 500); } }
          return { label, path, status: r.status, ok: r.ok, body };
        } catch (err: any) {
          return { label, path, status: 0, ok: false, body: { error: err.message } };
        }
      }

      // Try every documented variant; whatever returns 200 wins.
      const probes = await Promise.all([
        probe("workflow_rules_v1", "/settings/automation/actions/workflow_rules?module=Leads"),
        probe("workflow_rules_v2", "/settings/workflow_rules?module=Leads"),
        probe("workflow_rules_v3", "/settings/automation/rules?module=Leads"),
        probe("functions",         "/settings/functions?category=standalone"),
        probe("functions_all",     "/settings/functions"),
        probe("custom_buttons",    "/settings/custom_buttons?module=Leads"),
        probe("related_lists",     "/settings/related_lists?module=Leads"),
        probe("fields_leads",      "/settings/fields?module=Leads"),
        probe("blueprint",         "/settings/automation/blueprint?module=Leads"),
        probe("scoring_rules",     "/settings/automation/actions/scoring_rules?module=Leads"),
      ]);

      // Filter every result for the keyword "arrowhead" to narrow down
      // which APIs returned actionable info.
      function findArrowhead(obj: any, path: string[] = []): Array<{ path: string; snippet: string }> {
        const out: Array<{ path: string; snippet: string }> = [];
        if (obj == null) return out;
        if (typeof obj === "string") {
          if (/arrowhead/i.test(obj)) {
            out.push({ path: path.join("."), snippet: obj.slice(0, 200) });
          }
          return out;
        }
        if (Array.isArray(obj)) {
          for (let i = 0; i < obj.length; i++) out.push(...findArrowhead(obj[i], [...path, String(i)]));
          return out;
        }
        if (typeof obj === "object") {
          for (const k of Object.keys(obj)) out.push(...findArrowhead(obj[k], [...path, k]));
          return out;
        }
        return out;
      }

      const arrowheadHits = probes
        .filter((p) => p.ok)
        .map((p) => ({ probe: p.label, hits: findArrowhead(p.body) }))
        .filter((p) => p.hits.length > 0);

      // For each workflow probe that worked, extract structured rule list
      // with key fields (name, active, execute_on, actions).
      const workflowProbe = probes.find((p) => p.label.startsWith("workflow_rules") && p.ok);
      let workflowRules: any[] = [];
      if (workflowProbe && Array.isArray(workflowProbe.body?.workflow_rules)) {
        workflowRules = workflowProbe.body.workflow_rules.map((w: any) => ({
          id: w.id,
          name: w.name,
          active: w.active,
          execute_on: w.execute_on,
          trigger: w.trigger,
          modified_time: w.modified_time,
          arrowhead_match: /arrowhead/i.test(JSON.stringify(w)),
        }));
      }

      // Likewise for functions
      const fnProbe = probes.find((p) => p.label.startsWith("functions") && p.ok);
      let customFns: any[] = [];
      if (fnProbe && Array.isArray(fnProbe.body?.functions)) {
        customFns = fnProbe.body.functions.map((f: any) => ({
          id: f.id,
          name: f.name || f.display_name,
          category: f.category,
          arrowhead_match: /arrowhead/i.test(JSON.stringify(f)),
        }));
      }

      // Buttons
      const btnProbe = probes.find((p) => p.label === "custom_buttons" && p.ok);
      let customBtns: any[] = [];
      if (btnProbe && Array.isArray(btnProbe.body?.custom_buttons)) {
        customBtns = btnProbe.body.custom_buttons.map((b: any) => ({
          id: b.id,
          name: b.name,
          display_label: b.display_label,
          arrowhead_match: /arrowhead/i.test(JSON.stringify(b)),
        }));
      }

      // Field check
      const fieldsProbe = probes.find((p) => p.label === "fields_leads" && p.ok);
      let arrowheadFields: any[] = [];
      if (fieldsProbe && Array.isArray(fieldsProbe.body?.fields)) {
        arrowheadFields = fieldsProbe.body.fields
          .filter((f: any) => /arrowhead/i.test(f.api_name || "") || /arrowhead/i.test(f.field_label || ""))
          .map((f: any) => ({
            api_name: f.api_name,
            field_label: f.field_label,
            data_type: f.data_type,
            custom: f.custom_field,
          }));
      }

      return res.status(200).json({
        timestamp: new Date().toISOString(),
        probe_results: probes.map((p) => ({
          label: p.label,
          path: p.path,
          status: p.status,
          ok: p.ok,
          body_size: typeof p.body === "string" ? p.body.length : JSON.stringify(p.body || {}).length,
        })),
        workflow_rules: workflowRules,
        workflow_rules_arrowhead_only: workflowRules.filter((w) => w.arrowhead_match),
        custom_functions: customFns,
        custom_functions_arrowhead_only: customFns.filter((f) => f.arrowhead_match),
        custom_buttons: customBtns,
        custom_buttons_arrowhead_only: customBtns.filter((b) => b.arrowhead_match),
        arrowhead_fields_on_leads: arrowheadFields,
        all_arrowhead_hits_across_probes: arrowheadHits,
        raw_probes_full: probes,
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
  // zoho-create-call-scheduling-fields — adds the Zoho field the v3 calling
  // state machine writes:
  //   Next_Call_At  (datetime)  — when cron should fire next call
  //
  // Idempotent: skipped if already exists. Used during fresh Zoho setup.
  // (v2's Consecutive_Missed_Count + Aggressive_Tree_Start_At fields are
  //  still present on existing leads from earlier setup; v3 doesn't read
  //  or write them, but they're harmless legacy columns.)
  if (req.method === "GET" && req.query.action === "zoho-create-call-scheduling-fields") {
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    const authedBySecret = !!expectedSecret && incomingSecret === expectedSecret;
    if (!session && !authedBySecret) {
      return res.status(401).json({ error: "Unauthorized — log in OR pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
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
      const fj = await fr.json() as any;
      const allFields = (fj?.fields || []) as any[];
      const existingApis = new Set(allFields.map((f: any) => f.api_name));

      // v3 only needs Next_Call_At. (v2 had 3 fields; legacy 2 are no-op now.)
      const desired: Array<{ api: string; spec: Record<string, any> }> = [
        { api: "Next_Call_At", spec: { field_label: "Next Call At", data_type: "datetime" } },
      ];
      const toCreate = desired.filter((d) => !existingApis.has(d.api));
      const skipped = desired.filter((d) => existingApis.has(d.api)).map((d) => d.api);

      if (!toCreate.length) {
        return res.status(200).json({
          status: "all_already_exist",
          existing: skipped,
          next_step: "Fields ready. The posthook will populate them on every call completion. No further setup required.",
        });
      }

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
      const created = results
        .filter((r) => r.http_status >= 200 && r.http_status < 300)
        .map((r) => r.api_name);
      const failedAuth = results.some((r) => r.http_status === 401 || r.http_status === 403);
      return res.status(200).json({
        status: "attempted",
        created,
        skipped,
        results,
        next_step: created.length
          ? "Field created. Posthook will populate Next_Call_At on every call completion."
          : failedAuth
          ? "Zoho refresh token likely lacks ZohoCRM.settings.fields.CREATE scope. Add manually: Setup → Customization → Modules → Leads → Fields → + New Field → DateTime → name 'Next Call At'."
          : "Create attempt completed but no field was added — check `results` for details.",
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // zoho-create-unique-lead-field — standalone (session-or-secret auth) so the
  // dashboard "Step 1" button can call it via cookie. Idempotent: skips if
  // Is_Unique_Lead already exists.
  if (req.method === "GET" && req.query.action === "zoho-create-unique-lead-field") {
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    const authedBySecret = !!expectedSecret && incomingSecret === expectedSecret;
    if (!session && !authedBySecret) {
      return res.status(401).json({ error: "Unauthorized — log in OR pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
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
      const fj = await fr.json() as any;
      const allFields = (fj?.fields || []) as any[];
      const hasIt = allFields.some((f: any) => f.api_name === "Is_Unique_Lead");
      if (hasIt) {
        return res.status(200).json({
          status: "already_exists",
          existing: allFields
            .filter((f: any) => f.api_name === "Is_Unique_Lead")
            .map((f: any) => ({ api_name: f.api_name, field_label: f.field_label, data_type: f.data_type, custom_field: f.custom_field })),
          next_step: "Run Step 2 (Sync flags) to populate Is_Unique_Lead, then create the Zoho Custom View: Leads → All Leads dropdown → Create View → name 'Unique Leads' → criterion Is Unique Lead = true → Save.",
        });
      }
      const cr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: [{ field_label: "Is Unique Lead", data_type: "boolean" }] }),
      });
      return res.status(cr.status).json({
        attempted: true,
        http_status: cr.status,
        response: await cr.json().catch(() => ({})),
        next_step: cr.ok
          ? "Field created. Now run Step 2 (Sync flags), then create the Zoho Custom View 'Unique Leads' (criterion: Is Unique Lead = true)."
          : "Field create failed. If 401/403, add the field manually: Setup → Customization → Modules → Leads → Fields → + New Field → Checkbox → name 'Is Unique Lead'.",
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

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
      // Lead with the authoritative cross-project portfolio status, just like
      // production getProjectContextText() does, so the sandbox mirrors the
      // real bot (ready-to-move / possession answers, cross-sell).
      try {
        const { getPortfolioOverview } = await import("./_utils/project_facts");
        const po = await getPortfolioOverview();
        if (po) {
          parts.push("## ASBL PORTFOLIO STATUS (authoritative — applies to EVERY reply)");
          parts.push(po);
          parts.push("");
        }
      } catch {}
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
      const appliesToAll = body.applies_to_all === true || body.applies_to_all === "true";

      const insertBody: any = { project, doc_type: docType, filename, url: publicUrl };
      if (sizeLabel) insertBody.size_label = sizeLabel;
      if (unitSizeSft != null && isFinite(unitSizeSft) && unitSizeSft >= 100) {
        insertBody.unit_size_sft = unitSizeSft;
      }
      if (facingRaw) insertBody.facing = facingRaw;
      if (towerRaw) insertBody.tower = towerRaw;
      if (appliesToAll) insertBody.applies_to_all = true;
      if (textExtract) {
        // Cap each PDF's extract at 8000 chars so even 8 doc types per project
        // stay under Gemini's effective input budget when bundled into context.
        insertBody.text_extract = textExtract.slice(0, 8000);
        insertBody.text_extract_chars = textExtract.length;
        insertBody.text_extracted_at = new Date().toISOString();
      }

      // Phase 6: Mongo insert
      let insertedId: string;
      try {
        insertedId = await insertDoc(insertBody);
      } catch (err: any) {
        return res.status(500).json({ error: `DB insert failed: ${err.message}` });
      }
      {
        const { logAudit, clientIp } = await import("./_utils/audit");
        const sess = (req as any)._session;
        await logAudit({
          actor_email: sess?.email || "(unknown)",
          action: "upload-doc",
          target: `project_documents/${insertedId}`,
          summary: `${sess?.email || "?"} uploaded ${project} ${docType}${sizeLabel ? ` "${sizeLabel}"` : ""}${appliesToAll ? " (applies to ALL units)" : ""}`,
          details: { project, doc_type: docType, size_label: sizeLabel, filename, applies_to_all: appliesToAll || false },
          ip: clientIp(req),
        });
      }
      return res.status(200).json({
        ok: true,
        project, docType, sizeLabel, publicUrl,
        text_extracted: !!textExtract,
        text_extract_chars: textExtract.length,
        record: { _id: insertedId, ...insertBody },
      });
    } catch (err: any) {
      console.error(`[upload-finalize] failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── FULL Zoho -> Mongo lead sync (in-house CRM source-of-truth) ────────
  //   ADDITIVE — copies Zoho leads into Mongo `leads` so the CRM (and later
  //   the bot) can read everything from Mongo. Touches NO bot/call/WhatsApp/
  //   followup logic; it only reads Zoho and writes Mongo.
  //   GET ?action=mongo-sync-leads&secret=...        -> backfill ALL leads
  //   GET ?action=mongo-sync-leads&since=<ISO>&secret -> only modified-since
  //   Returns counts; safe to re-run (idempotent upsert).
  if (req.method === "GET" && req.query.action === "mongo-sync-leads") {
    try {
      const { runZohoLeadSync } = await import("./_utils/supabase");
      const since = req.query.since ? String(req.query.since) : undefined;
      const maxPages = req.query.max_pages ? Number(req.query.max_pages) : undefined;
      const result = await runZohoLeadSync({ since, maxPages });
      return res.status(200).json({
        ok: true,
        mode: since ? `incremental since ${since}` : "full backfill",
        ...result,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Cron runs: are followups (prd-cadence) actually ticking? ───────────
  //   GET ?action=cron-runs&secret=...[&task=prd-cadence&limit=30]
  //   Reads cron_log newest-first. The new cold/ghost WhatsApp followups do
  //   NOT write follow_up_log (that's the OLD system); they're counted in the
  //   prd-cadence run result as chatbot_ticks. This shows whether they fire.
  if (req.method === "GET" && req.query.action === "cron-runs") {
    try {
      const { getCollection, COL } = await import("./_utils/mongo");
      const col = await getCollection(COL.CRON_LOG);
      const limit = Math.min(Number(req.query.limit) || 30, 200);
      const q: any = {};
      if (req.query.task) q.task = String(req.query.task);
      const rows = await col.find(q).sort({ ran_at: -1 }).limit(limit).toArray();
      const runs = (rows as any[]).map((r) => ({
        task: r.task,
        ran_at: r.ran_at,
        duration_ms: r.duration_ms,
        error: r.error || null,
        // surface the followup-relevant counters when present
        scanned: r.result?.scanned ?? null,
        chatbot_ticks: r.result?.chatbot_ticks ?? null,
        ss_call_ticks: r.result?.ss_call_ticks ?? null,
        exhaustion_closes: r.result?.exhaustion_closes ?? null,
      }));
      const totalTicks = runs.reduce((s, r) => s + (Number(r.chatbot_ticks) || 0), 0);
      return res.status(200).json({ ok: true, count: runs.length, total_chatbot_ticks_in_window: totalTicks, runs });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Sender message stats (per Periskope sender number) ─────────────────
  //   GET ?action=sender-stats&secret=...
  //   Read-only aggregation over whatsapp_messages + dead_senders. Powers the
  //   "messages per sender / by date / first switch-off (block)" sheet.
  //   - outbound counted per sender (our Periskope numbers)
  //   - per (sender, date) outbound counts
  //   - "proactive" proxy = outbound in buckets with ZERO inbound (never-
  //     replied leads) — approximates cold follow-ups (the system doesn't
  //     tag follow-ups explicitly)
  //   - dead_senders with first_dead_at (treated as the block time)
  // ─── Raw per-message rows (for deep sender analytics / Excel) ───────────
  //   GET ?action=message-rows&secret=...
  //   Flattens whatsapp_messages into compact rows so richer analytics can be
  //   computed client-side: per-number × day × time distinct users, message
  //   character lengths, per-number daily inbounds, and concurrency (one
  //   number replying to multiple users at once). Inbound has no sender field,
  //   so it's attributed to the conversation's sticky sender.
  //   Row: { s: sender, p: customer_phone, t: epoch_ms, d: "o"|"i", l: char_len }
  if (req.method === "GET" && req.query.action === "message-rows") {
    try {
      const { getCollection, COL } = await import("./_utils/mongo");
      const wa = await getCollection(COL.WHATSAPP_MESSAGES);
      // sticky sender map (phone -> our sender number) for inbound attribution
      const sticky: Record<string, string> = {};
      try {
        const sm = await getCollection(COL.WHATSAPP_SENDER_MAP);
        for (const s of (await sm.find({} as any).toArray()) as any[]) {
          const ph = String(s._id || s.phone || "").replace(/\D/g, "");
          if (ph && s.sender) sticky[ph] = String(s.sender);
        }
      } catch {}
      const parseTs = (raw: any): number => {
        if (raw == null) return 0;
        if (typeof raw === "number" && isFinite(raw)) return raw;
        const n = Number(raw); if (isFinite(n) && n > 1e12) return n;
        const t = new Date(raw).getTime(); return isFinite(t) ? t : 0;
      };
      const docs = await wa.find({} as any).toArray();
      const rows: any[] = [];
      for (const d of docs as any[]) {
        const phone = String(d._id || "").replace(/\D/g, "");
        const byDate = d.by_date || {};
        for (const b of Object.values(byDate) as any[]) {
          for (const o of (b?.outbound || [])) {
            rows.push({ s: String(o?.sender || "(unknown)"), p: phone, t: parseTs(o?.time), d: "o", l: String(o?.msg ?? "").length });
          }
          for (const inb of (b?.inbound || [])) {
            rows.push({ s: sticky[phone] || "(unknown)", p: phone, t: parseTs(inb?.time), d: "i", l: String(inb?.msg ?? "").length });
          }
        }
      }
      return res.status(200).json({ ok: true, buckets: docs.length, count: rows.length, rows });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "GET" && req.query.action === "sender-stats") {
    try {
      const { getCollection, COL } = await import("./_utils/mongo");
      const wa = await getCollection(COL.WHATSAPP_MESSAGES);
      const docs = await wa.find({} as any).toArray();
      const perSender: Record<string, number> = {};
      const perSenderInbound: Record<string, number> = {}; // by bucket sticky? no sender on inbound; skip
      const perSenderProactive: Record<string, number> = {};
      const perSenderDate: Record<string, number> = {}; // `${sender}__${date}`
      let totalOutbound = 0, totalInbound = 0;
      for (const d of docs as any[]) {
        const byDate = d.by_date || {};
        let bucketInbound = 0;
        for (const b of Object.values(byDate) as any[]) bucketInbound += (b?.inbound?.length || 0);
        const bucketHasInbound = bucketInbound > 0;
        for (const [date, b] of Object.entries(byDate) as any[]) {
          totalInbound += (b?.inbound?.length || 0);
          for (const o of (b?.outbound || [])) {
            const s = String(o?.sender || "(unknown)");
            perSender[s] = (perSender[s] || 0) + 1;
            perSenderDate[`${s}__${date}`] = (perSenderDate[`${s}__${date}`] || 0) + 1;
            if (!bucketHasInbound) perSenderProactive[s] = (perSenderProactive[s] || 0) + 1;
            totalOutbound++;
          }
        }
      }
      const senders = Object.entries(perSender)
        .map(([sender, outbound]) => ({ sender, outbound, proactive_outbound_approx: perSenderProactive[sender] || 0 }))
        .sort((a, b) => b.outbound - a.outbound);
      const bySenderDate = Object.entries(perSenderDate)
        .map(([k, outbound]) => { const [sender, date] = k.split("__"); return { sender, date, outbound }; })
        .sort((a, b) => a.sender.localeCompare(b.sender) || a.date.localeCompare(b.date));

      const ds = await getCollection(COL.DEAD_SENDERS);
      const deadDocs = await ds.find({} as any).toArray();
      const dead_senders = (deadDocs as any[])
        .map((d) => ({
          sender: String(d._id),
          first_dead_at: d.first_dead_at || d.dead_at || null,
          last_dead_at: d.dead_at || null,
          consecutive_failures: d.consecutive_failures || 0,
          flagged_permanent: !!d.alerted_permanent,
        }))
        .sort((a, b) => String(a.first_dead_at).localeCompare(String(b.first_dead_at)));

      return res.status(200).json({
        ok: true,
        phone_buckets_scanned: docs.length,
        total_outbound: totalOutbound,
        total_inbound: totalInbound,
        senders,
        by_sender_date: bySenderDate,
        dead_senders,
        notes: {
          proactive_outbound_approx: "outbound to buckets with zero inbound (never-replied leads) — a proxy for cold follow-ups; the system does not tag follow-ups explicitly",
          dead_senders: "only currently-failing senders are retained; a sender's doc is deleted on its next successful send, so recovered senders are not listed here. first_dead_at = start of the current failure streak (treated as the block time).",
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Pause / resume WhatsApp follow-ups (calls unaffected) ──────────────
  //   GET ?action=set-followup-pause&paused=true|false&secret=...
  //   Sets bot_settings.whatsapp_followups_paused. The prd-cadence cron reads
  //   it each tick — pausing skips cold/ghost chatbot sends while calls keep
  //   running. No deploy needed to pause or resume.
  if (req.query.action === "set-followup-pause") {
    try {
      const { getBotSetting, setBotSetting } = await import("./_utils/bot_settings");
      if (req.query.paused === undefined) {
        const row = await getBotSetting("whatsapp_followups_paused");
        return res.status(200).json({ ok: true, whatsapp_followups_paused: row?.value === "true" });
      }
      const paused = String(req.query.paused) === "true";
      const result = await setBotSetting("whatsapp_followups_paused", paused ? "true" : "false");
      if (!result.ok) return res.status(500).json({ error: result.error });
      return res.status(200).json({
        ok: true,
        whatsapp_followups_paused: paused,
        note: paused
          ? "WhatsApp cold/ghost follow-ups PAUSED. Calls still run. Resume with &paused=false."
          : "WhatsApp follow-ups RESUMED.",
        effective: "next prd-cadence tick (within ~15 min)",
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── set-ops-flag — generic toggle for the temporary ops switches ───────
  //   GET  ?action=set-ops-flag&secret=...                → read all flags
  //   GET  ?action=set-ops-flag&key=<k>&value=<v>&secret= → set one flag
  //   Whitelisted keys only. Effective on the next prd-cadence tick (~15 min).
  //     whatsapp_born_paused    true/false  — skip T=0 WhatsApp greeting
  //     whatsapp_followups_paused true/false — skip cold/ghost follow-ups
  //     calls_delayed_batched   true/false  — defer T=0 call to born+delay +
  //                                           fire never-called leads in batches
  //     first_call_delay_min    <int min>   — defer window (default 30)
  //     first_call_batch_size   <int>       — first-calls per tick (default 15)
  if (req.query.action === "set-ops-flag") {
    const OPS_FLAGS = new Set([
      "whatsapp_born_paused",
      "whatsapp_followups_paused",
      "calls_delayed_batched",
      "calls_paused",
      "first_call_delay_min",
      "first_call_batch_size",
      "automation_frozen", // MASTER kill-switch — freezes ingest/cron/posthook/reactive/T=0
    ]);
    try {
      const { getBotSetting, setBotSetting } = await import("./_utils/bot_settings");
      const key = String(req.query.key || "").trim();
      const value = req.query.value;
      if (!key) {
        const all: Record<string, string | null> = {};
        for (const k of OPS_FLAGS) all[k] = (await getBotSetting(k))?.value ?? null;
        return res.status(200).json({ ok: true, flags: all });
      }
      if (!OPS_FLAGS.has(key)) {
        return res.status(400).json({ error: `unknown flag '${key}'`, allowed: [...OPS_FLAGS] });
      }
      if (value === undefined) {
        return res.status(200).json({ ok: true, key, value: (await getBotSetting(key))?.value ?? null });
      }
      const v = String(value);
      const result = await setBotSetting(key, v);
      if (!result.ok) return res.status(500).json({ error: result.error });
      // Audit-log the flag flip (this changes outbound behaviour). Only on a
      // successful write; never block the toggle on an audit failure.
      const { logAudit, clientIp } = await import("./_utils/audit");
      await logAudit({
        actor_email: (req as any)._session?.email || "curl(secret)",
        action: "set-ops-flag",
        target: `bot_settings/${key}`,
        summary: `${key} = "${v}"`,
        ip: clientIp(req),
      }).catch(() => {});
      return res.status(200).json({
        ok: true, key, value: v,
        effective: "next prd-cadence tick (within ~15 min)",
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── reactivation-upload — load the manual-reactivation phone allowlist ──
  //   POST ?action=reactivation-upload&secret=...
  //     body: { wipe?: true, rows: [{ phone, latest_project?, masterleadid? }, ...] }
  //   Normalizes each phone; when an Inncircles-webhook lead's phone is on this
  //   list, its source is flipped Inncircles M1 -> Manual Reactivation at ingest.
  if (req.method === "POST" && req.query.action === "reactivation-upload") {
    try {
      const body = (req.body || {}) as any;
      const rows: any[] = Array.isArray(body.rows) ? body.rows : (Array.isArray(body) ? body : []);
      if (!rows.length) return res.status(400).json({ error: "rows[] required" });
      const { loadReactivationList } = await import("./_utils/reactivation");
      const out = await loadReactivationList(rows, { wipe: !!body.wipe, added_at: new Date().toISOString() });
      return res.status(200).json({
        ok: true,
        received: rows.length,
        inserted: out.inserted,
        skipped_count: out.skipped.length,
        skipped_sample: out.skipped.slice(0, 10),
        wiped: out.wiped,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── reactivation-check — verify the list / test a phone ────────────────
  //   GET ?action=reactivation-check&secret=...            → count + sample
  //   GET ?action=reactivation-check&phone=<any>&secret=.. → is this phone on it?
  if (req.method === "GET" && req.query.action === "reactivation-check") {
    try {
      const { getCollection, COL } = await import("./_utils/mongo");
      const col = await getCollection(COL.REACTIVATION_LIST);
      const phone = String(req.query.phone || "").trim();
      if (phone) {
        const { getReactivationEntry } = await import("./_utils/reactivation");
        const entry = await getReactivationEntry(phone);
        return res.status(200).json({ ok: true, phone, on_list: !!entry, entry: entry || null });
      }
      const total = await col.estimatedDocumentCount();
      const sample = await col.find({} as any).limit(5).toArray();
      return res.status(200).json({ ok: true, total, sample });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── zoho-add-leadsource-option — add "Manual Reactivation" to the Zoho
  //     Lead_Source picklist (idempotent; appends, preserving all existing
  //     values). Run once before the reactivation push.
  //   GET ?action=zoho-add-leadsource-option&secret=...
  //       &value=Manual Reactivation   (defaults to that)
  if (req.method === "GET" && req.query.action === "zoho-add-leadsource-option") {
    try {
      const optionVal = String(req.query.value || "Manual Reactivation").trim();
      const { getAccessToken } = await import("./_utils/zoho");
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();
      const fr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      if (!fr.ok) return res.status(fr.status).json({ error: "field-list failed", body: (await fr.text()).slice(0, 400) });
      const fj = (await fr.json()) as any;
      const field = (fj?.fields || []).find((f: any) => f.api_name === "Lead_Source");
      if (!field) return res.status(404).json({ error: "Lead_Source field not found" });
      const existing: any[] = field.pick_list_values || [];
      if (existing.some((v) => v.actual_value === optionVal || v.display_value === optionVal)) {
        return res.status(200).json({ ok: true, status: "already_exists", value: optionVal, options: existing.map((v) => v.actual_value) });
      }
      // Preserve each existing option OBJECT verbatim (incl. its id / sequence /
      // colour) — Zoho matches existing picklist values by id. Rebuilding them
      // as bare {display_value, actual_value} makes Zoho treat them as new.
      const pick_list_values = existing
        .map((v) => ({ ...v }))
        .concat([{ display_value: optionVal, actual_value: optionVal }]);
      const pr = await fetch(`${ZOHO_API_BASE}/settings/fields/${field.id}?module=Leads`, {
        method: "PATCH",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: [{ id: field.id, pick_list_values }] }),
      });
      const pj = await pr.json().catch(() => ({}));
      const ok = pr.status >= 200 && pr.status < 300;
      return res.status(ok ? 200 : pr.status).json({ ok, status: ok ? "added" : "failed", value: optionVal, http_status: pr.status, response: pj });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── zoho-sync-prd-stage-picklist — copy every Lead_Status picklist value
  //     into the PRD_Stage picklist so PRD_Stage can hold the Lead_Status value
  //     VERBATIM (the two become the same field, no mapping). Idempotent — run
  //     once before the reconcile-stage-from-status backfill.
  //   GET ?action=zoho-sync-prd-stage-picklist&secret=$INHOUSE_POSTHOOK_SECRET
  if (req.method === "GET" && req.query.action === "zoho-sync-prd-stage-picklist") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=" });
    }
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();
      const fr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      if (!fr.ok) return res.status(fr.status).json({ error: "field-list failed", body: (await fr.text()).slice(0, 400) });
      const fj = (await fr.json()) as any;
      const fields = fj?.fields || [];
      const leadStatusField = fields.find((f: any) => f.api_name === "Lead_Status");
      const prdStageField = fields.find((f: any) => f.api_name === "PRD_Stage");
      if (!leadStatusField) return res.status(404).json({ error: "Lead_Status field not found" });
      if (!prdStageField) return res.status(404).json({ error: "PRD_Stage field not found" });

      const lsValues: string[] = (leadStatusField.pick_list_values || [])
        .map((v: any) => String(v.actual_value ?? v.display_value ?? "").trim())
        .filter(Boolean);
      const prdExisting: any[] = prdStageField.pick_list_values || [];
      const prdValuesSet = new Set(prdExisting.map((v) => String(v.actual_value ?? v.display_value ?? "").trim()));

      const toAdd = lsValues.filter((v) => !prdValuesSet.has(v));
      if (!toAdd.length) {
        return res.status(200).json({ ok: true, status: "already_synced", lead_status_values: lsValues, prd_stage_values: Array.from(prdValuesSet) });
      }
      // Preserve existing PRD_Stage option objects verbatim (id / sequence /
      // colour) so Zoho matches them by id; append the missing Lead_Status ones.
      const pick_list_values = prdExisting
        .map((v) => ({ ...v }))
        .concat(toAdd.map((v) => ({ display_value: v, actual_value: v })));
      const pr = await fetch(`${ZOHO_API_BASE}/settings/fields/${prdStageField.id}?module=Leads`, {
        method: "PATCH",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: [{ id: prdStageField.id, pick_list_values }] }),
      });
      const pj = await pr.json().catch(() => ({}));
      const ok = pr.status >= 200 && pr.status < 300;
      return res.status(ok ? 200 : pr.status).json({
        ok, status: ok ? "added" : "failed", added: toAdd,
        prd_stage_values_now: pick_list_values.map((v: any) => v.actual_value ?? v.display_value),
        http_status: pr.status, response: ok ? undefined : pj,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── zoho-create-reactivation-field — create the Reactivation_Is_Latest
  //     checkbox on Leads (drives the purple row for the latest-project lead).
  //     Idempotent. Run once before the reactivation push.
  //   GET ?action=zoho-create-reactivation-field&secret=...
  if (req.method === "GET" && req.query.action === "zoho-create-reactivation-field") {
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();
      const fr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      if (!fr.ok) return res.status(fr.status).json({ error: "field-list failed", body: (await fr.text()).slice(0, 400) });
      const fj = (await fr.json()) as any;
      const existingApis = new Set((fj?.fields || []).map((f: any) => f.api_name));
      if (existingApis.has("Reactivation_Is_Latest")) {
        return res.status(200).json({ ok: true, status: "already_exists", api: "Reactivation_Is_Latest" });
      }
      const body = { fields: [{ field_label: "Reactivation Is Latest", data_type: "boolean" }] };
      const cr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await cr.json().catch(() => ({}));
      const ok = cr.status >= 200 && cr.status < 300;
      return res.status(ok ? 200 : cr.status).json({ ok, status: ok ? "created" : "failed", api: "Reactivation_Is_Latest", http_status: cr.status, response: ok ? "ok" : j });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── site-visit-bookings — every site-visit / virtual-tour a call booked ──
  //   GET ?action=site-visit-bookings&secret=$INHOUSE_POSTHOOK_SECRET
  //       [&project=SPECTRA] [&limit=100]
  //   Reads the site_visit_bookings collection (project + date + time per lead).
  if (req.method === "GET" && req.query.action === "site-visit-bookings") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=" });
    }
    try {
      const { getCollection } = await import("./_utils/mongo");
      const col = await getCollection("site_visit_bookings" as any);
      const q: any = {};
      if (req.query.project) q.project = String(req.query.project);
      if (req.query.type) q.type = String(req.query.type);
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
      const rows = await col.find(q).sort({ booked_at: -1 } as any).limit(limit).toArray();
      return res.status(200).json({
        count: rows.length,
        bookings: rows.map((r: any) => ({
          customer_name: r.customer_name, phone: r.phone, project: r.project,
          type: r.type, visit_date: r.visit_date, visit_time: r.visit_time,
          booked_at: r.booked_at, zoho_lead_id: r.zoho_lead_id,
        })),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── test-teams-alert — verify the Teams webhook + Adaptive Card render ──
  //   GET ?action=test-teams-alert&secret=$INHOUSE_POSTHOOK_SECRET
  if (req.method === "GET" && req.query.action === "test-teams-alert") {
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=" });
    }
    const { alertOps } = await import("./_utils/alerting");
    await alertOps({
      title: "Test alert",
      message: "Test alert from ASBL CRM — agar ye card dikh raha hai to Teams alerting kaam kar rahi hai.",
      context: { source: "manual test", time: new Date().toISOString() },
      dedupeKey: `test:${Date.now()}`,
    });
    return res.status(200).json({ ok: true, teams_webhook_configured: !!process.env.TEAMS_WEBHOOK_URL });
  }

  // ─── zoho-create-inncircles-flag-fields — create the 4 Inncircles origin
  //     checkboxes on Leads (IsReactivated, IsBorn_Fresh, IsBorn_InOtherProject,
  //     IsBulkTransfer). Idempotent. Run once before the ingest sends them.
  //   GET ?action=zoho-create-inncircles-flag-fields&secret=...
  if (req.method === "GET" && req.query.action === "zoho-create-inncircles-flag-fields") {
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const token = await getAccessToken();
      const fr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      if (!fr.ok) return res.status(fr.status).json({ error: "field-list failed", body: (await fr.text()).slice(0, 400) });
      const fj = (await fr.json()) as any;
      const existingApis = new Set((fj?.fields || []).map((f: any) => f.api_name));
      const desired = [
        { api: "IsReactivated",         label: "IsReactivated",         type: "boolean" },
        { api: "IsBorn_Fresh",          label: "IsBorn_Fresh",          type: "boolean" },
        { api: "IsBorn_InOtherProject", label: "IsBorn_InOtherProject", type: "boolean" },
        { api: "IsBulkTransfer",        label: "IsBulkTransfer",        type: "boolean" },
        { api: "Inncircles_Born_Date",  label: "Inncircles Born Date",  type: "date"    },
      ];
      const results: any[] = [];
      for (const d of desired) {
        if (existingApis.has(d.api)) { results.push({ api: d.api, status: "already_exists" }); continue; }
        const body = { fields: [{ field_label: d.label, data_type: d.type }] };
        const cr = await fetch(`${ZOHO_API_BASE}/settings/fields?module=Leads`, {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await cr.json().catch(() => ({}));
        const ok = cr.status >= 200 && cr.status < 300;
        // Report the api_name Zoho actually assigned so the ingest mapping can be verified.
        const createdApi = j?.fields?.[0]?.details?.api_name || d.api;
        results.push({ requested_api: d.api, created_api: createdApi, status: ok ? "created" : "failed", http_status: cr.status, response: ok ? "ok" : j });
      }
      return res.status(200).json({ ok: true, module: "Leads", results });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Storage freshness: are NEW writes actually landing in Mongo? ───────
  //   GET ?action=storage-freshness&secret=...
  //   Shows newest timestamp + recent counts per write-path collection, so
  //   we can tell "nothing stores" (broken writes) from "stored but stale"
  //   (old backfill, no new traffic) from "working fine, just couldn't see it".
  if (req.method === "GET" && req.query.action === "storage-freshness") {
    try {
      const { getCollection, COL } = await import("./_utils/mongo");
      const nowMs = Date.now();
      const h24 = new Date(nowMs - 24 * 3600e3).toISOString();
      const d7 = new Date(nowMs - 7 * 24 * 3600e3).toISOString();

      // whatsapp_messages is phone-bucketed: each doc has last_message_at.
      const wa = await getCollection(COL.WHATSAPP_MESSAGES);
      const waNewest = await wa.find({} as any).sort({ last_message_at: -1 }).limit(1).toArray();
      const waNewestTs = (waNewest[0] as any)?.last_message_at || null;
      const waActive24h = await wa.countDocuments({ last_message_at: { $gte: h24 } } as any);
      const waActive7d = await wa.countDocuments({ last_message_at: { $gte: d7 } } as any);
      const waTotal = await wa.estimatedDocumentCount();

      const newestOf = async (cname: string, field: string) => {
        try {
          const c = await getCollection(cname);
          const newest = await c.find({} as any).sort({ [field]: -1 } as any).limit(1).toArray();
          const total = await c.estimatedDocumentCount();
          const recent24 = await c.countDocuments({ [field]: { $gte: h24 } } as any);
          return { total, newest: (newest[0] as any)?.[field] || null, last24h: recent24 };
        } catch (e: any) { return { error: e.message }; }
      };

      return res.status(200).json({
        ok: true,
        now: new Date(nowMs).toISOString(),
        whatsapp_messages: {
          phone_buckets: waTotal,
          newest_message_at: waNewestTs,
          buckets_active_last_24h: waActive24h,
          buckets_active_last_7d: waActive7d,
          newest_phone: (waNewest[0] as any)?._id || null,
        },
        follow_up_log:  await newestOf(COL.FOLLOW_UP_LOG, "created_at"),
        doc_send_log:   await newestOf(COL.DOC_SEND_LOG, "created_at"),
        callback_log:   await newestOf(COL.CALLBACK_LOG, "created_at"),
        user_profiles:  await newestOf(COL.USER_PROFILES, "last_interaction_at"),
        cron_log:       await newestOf(COL.CRON_LOG, "ran_at"),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Callback diagnostics: why did "call me" not place a call? ──────────
  //   GET ?action=callback-log&secret=...&limit=50[&phone=98xxxxxxxx]
  //   Returns recent WhatsApp callback attempts with outcome + reason
  //   (no_zoho_lead_matched / cooldown / voicebot_error / triggered).
  if (req.method === "GET" && req.query.action === "callback-log") {
    try {
      const { getCollection, COL } = await import("./_utils/mongo");
      const col = await getCollection(COL.CALLBACK_LOG);
      const limit = Math.min(Number(req.query.limit) || 50, 500);
      const q: any = {};
      if (req.query.phone) {
        const d = String(req.query.phone).replace(/\D/g, "").slice(-10);
        if (d) q.phone = { $regex: d + "$" };
      }
      const rows = await col.find(q).sort({ created_at: -1 }).limit(limit).toArray();
      const summary: Record<string, number> = {};
      for (const r of rows as any[]) {
        const k = `${r.outcome}:${r.reason}`;
        summary[k] = (summary[k] || 0) + 1;
      }
      return res.status(200).json({ ok: true, count: rows.length, summary, rows });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Test Zoho lead matching for a phone (does the bot find this lead?) ──
  //   GET ?action=zoho-lead-match-test&phone=<any format>&secret=...
  //   Shows whether the robust multi-format lookup matches a Zoho lead — use
  //   to confirm a lead the user messaged is reachable for chat sync + callback.
  if (req.method === "GET" && req.query.action === "zoho-lead-match-test") {
    try {
      const raw = String(req.query.phone || "");
      if (!raw) return res.status(400).json({ error: "phone query param required" });
      const { getAccessToken } = await import("./_utils/zoho");
      const token = await getAccessToken();
      const digits = raw.replace(/\D/g, "");
      const last10 = digits.slice(-10);
      const variants = Array.from(new Set([digits, last10, last10 ? `91${last10}` : "", last10 ? `+91${last10}` : ""].filter(Boolean)));
      const fields = "id,First_Name,Last_Name,Mobile,Phone,ASBL_Project,Lead_Status";
      const ZBASE = "https://www.zohoapis.in/crm/v3";
      const tryFetch = async (criteria: string) => {
        const r = await fetch(`${ZBASE}/Leads/search?criteria=${encodeURIComponent(criteria)}&fields=${fields}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
        if (!r.ok || r.status === 204) return [];
        const t = await r.text(); if (!t) return [];
        try { return (JSON.parse(t)?.data || []); } catch { return []; }
      };
      const orParts: string[] = [];
      for (const v of variants) { orParts.push(`(Mobile:equals:${v})`); orParts.push(`(Phone:equals:${v})`); }
      let rows = await tryFetch(orParts.length === 1 ? orParts[0] : `(${orParts.join("or")})`);
      let method = "equals_variants";
      if (!rows.length && last10) { rows = await tryFetch(`(Mobile:contains:${last10})`); method = "contains_mobile"; }
      if (!rows.length && last10) { rows = await tryFetch(`(Phone:contains:${last10})`); method = "contains_phone"; }
      return res.status(200).json({
        ok: true, input: raw, variants_tried: variants,
        matched: rows.length > 0, match_method: rows.length ? method : null,
        leads: rows.map((r: any) => ({ id: r.id, name: [r.First_Name, r.Last_Name].filter(Boolean).join(" "), mobile: r.Mobile, phone: r.Phone, project: r.ASBL_Project, status: r.Lead_Status })),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── ASBL PORTFOLIO STATUS (authoritative cross-project status) ─────────
  //   The bot injects this into EVERY message so it never fabricates
  //   ready-to-move / possession answers. Editable here without a deploy.
  //   GET  ?action=portfolio-get                 -> current text (DB or default seed)
  //   POST ?action=portfolio-save  { text }      -> set bot_settings.portfolio_overview
  if (req.method === "GET" && req.query.action === "portfolio-get") {
    try {
      const { getBotSetting } = await import("./_utils/bot_settings");
      const { DEFAULT_PORTFOLIO_OVERVIEW } = await import("./_utils/project_facts");
      const row = await getBotSetting("portfolio_overview");
      const isCustom = !!(row?.value && row.value.trim().length > 30);
      return res.status(200).json({
        ok: true,
        source: isCustom ? "dashboard_db" : "default_seed",
        text: isCustom ? row!.value : DEFAULT_PORTFOLIO_OVERVIEW,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
  if (req.method === "POST" && req.query.action === "portfolio-save") {
    try {
      const body = (typeof req.body === "object" && req.body) ? req.body as any : parseFormBody(req.body);
      const text = String(body.text || body.portfolio || "").trim();
      if (text.length < 30) {
        return res.status(400).json({ error: "Portfolio text too short (min 30 chars)." });
      }
      const { setBotSetting } = await import("./_utils/bot_settings");
      const result = await setBotSetting("portfolio_overview", text);
      if (!result.ok) return res.status(500).json({ error: result.error });
      return res.status(200).json({ ok: true, saved_chars: text.length, note: "Live within 60s (portfolio cache TTL)." });
    } catch (err: any) {
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
    // Stamp the current prompt version so a dashboard edit STICKS (otherwise
    // resolveSystemPrompt would see a stale/missing version and overwrite the
    // edit with the hardcoded prompt on the next message).
    try {
      const { PROMPT_VERSION } = await import("./_utils/gemini_chat");
      await setBotSetting("system_prompt_version", PROMPT_VERSION);
    } catch {}
    if (!result.ok) {
      res.setHeader("Location", `?view=edit-prompt&msg=${encodeURIComponent("Save failed: " + result.error)}`);
    } else {
      const { logAudit, clientIp } = await import("./_utils/audit");
      const sess = (req as any)._session;
      await logAudit({
        actor_email: sess?.email || "(unknown)",
        action: "save-prompt",
        target: "bot_settings/system_prompt",
        summary: `${sess?.email || "?"} edited the bot system prompt (${(prompt.length / 1024).toFixed(1)} KB)`,
        ip: clientIp(req),
      });
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
      // Find all PDF rows missing text_extract (Phase 6: Mongo)
      const rows = await listAllDocs({ missing_text_extract: true, limit: 200 });
      const results: any[] = [];
      for (const row of rows as any[]) {
        const url = String(row.url || "");
        const filename = String(row.filename || "");
        const isPdf = filename.toLowerCase().endsWith(".pdf") || url.toLowerCase().includes(".pdf");
        if (!isPdf) {
          results.push({ id: row._id, skipped: "not a pdf" });
          continue;
        }
        try {
          const fetchRes = await fetch(url);
          if (!fetchRes.ok) {
            results.push({ id: row._id, error: `fetch ${fetchRes.status} for ${url.slice(0, 80)}` });
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
              id: row._id,
              error: `extract returned empty (${extractErr || "no exception thrown"}) for ${url.slice(0, 100)}`,
            });
            continue;
          }
          await updateDocFields(String(row._id), {
            text_extract: text.slice(0, 8000),
            text_extract_chars: text.length,
            text_extracted_at: new Date().toISOString(),
          });
          results.push({ id: row._id, project: row.project, doc_type: row.doc_type, chars: text.length, ok: true });
        } catch (err: any) {
          results.push({ id: row._id, error: err.message });
        }
      }
      return res.status(200).json({ processed: results.length, results });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Bulk-call: list all Indian-phone leads from Zoho ──────────────────
  // GET /api/chat-history?action=list-indian-leads&secret=<INHOUSE_POSTHOOK_SECRET>
  // Read-only. Pages through ALL Zoho leads (no status filter — per user
  // 2026-05-21 "sabko call karo no matter not interested"), filters to
  // Indian phones (Mobile or Phone starts with 91 / +91), and returns
  // a compact list the caller iterates through to fire /api/relay/inhouse-call.

  // ─── Dedupe Zoho leads — clean up the historical duplicates the race ─
  // condition (fixed in a4e0d62) created. For each phone with >1 leads:
  //   1. Pick winner (most-advanced status → most recently modified)
  //   2. Copy missing fields from losers into winner
  //   3. Repoint Supabase leads.zoho_lead_id (by PLID) to winner
  //   4. DELETE losers from Zoho
  //
  // ?dry=1     preview only (no writes, no deletes)
  // ?max=N     cap the number of phone groups processed in one batch
  //            (Vercel 10s budget — keep N small, default 5; each phone
  //             takes ~1-2s due to Zoho get + update + delete + Supabase
  //             repoint).
  //
  // Caller usage:
  //   curl '...?action=zoho-dedup-leads&secret=...&dry=1'   # preview
  //   curl '...?action=zoho-dedup-leads&secret=...&max=5'   # process 5 groups
  //   (re-call until done:true)
  if (req.query.action === "zoho-dedup-leads") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    const dry = req.query.dry === "1" || req.query.dry === "true";
    const maxGroups = Math.max(1, Math.min(parseInt(String(req.query.max || "5"), 10) || 5, 20));
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const token = await getAccessToken();
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const fields =
        "id,First_Name,Last_Name,Mobile,Phone,Email,Lead_Status,Lead_Source,ASBL_Project," +
        "Master_Lead_ID,Project_Lead_ID,Modified_Time,Created_Time," +
        "Resubmission_Count,Last_Resubmission_At,Lead_Comments";

      // 1. Fetch all leads (cap 10 pages = 2000 rows)
      const all: any[] = [];
      for (let page = 1; page <= 10; page++) {
        const r = await fetch(
          `${ZOHO_API_BASE}/Leads?fields=${fields}` +
            `&per_page=200&page=${page}&sort_by=Modified_Time&sort_order=desc`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
        );
        if (r.status === 204) break;
        if (!r.ok) {
          return res.status(500).json({
            error: `Zoho fetch failed page ${page}: ${r.status} ${(await r.text()).slice(0, 200)}`,
          });
        }
        const data = await r.json() as any;
        const rows = (data?.data || []) as any[];
        all.push(...rows);
        if (!data?.info?.more_records) break;
      }

      // 2. Group by normalised Mobile (digits-only 12-digit form)
      const groups = new Map<string, any[]>();
      for (const lead of all) {
        const raw = String(lead.Mobile || lead.Phone || "").trim();
        if (!raw) continue;
        const digits = raw.replace(/\D/g, "");
        const norm = digits.length === 10 ? `91${digits}` : digits;
        if (!norm || norm.length !== 12) continue;
        if (!groups.has(norm)) groups.set(norm, []);
        groups.get(norm)!.push(lead);
      }

      // 3. Filter to dupe-only groups
      const dupeGroups = Array.from(groups.entries()).filter(([_, ls]) => ls.length > 1);

      // 4. Rank statuses — higher index = more advanced (winner)
      const STATUS_RANK: Record<string, number> = {
        "":                 0,
        "Junk":             0,
        "Not Interested":   1,
        "Fresh":            2,
        "First Touch":      3,
        "Contacted":        4,
        "Lead Initiated":   5,
        "Virtual Tour":     6,
        "Pre Site":         7,
      };
      const statusRank = (s: string): number => STATUS_RANK[s] ?? 2;

      const results: any[] = [];
      let groupsProcessed = 0;
      let losersDeleted = 0;
      let winnersUpdated = 0;
      let supabaseRepoints = 0;

      for (const [phone, leads] of dupeGroups) {
        if (groupsProcessed >= maxGroups) break;
        groupsProcessed++;

        // Pick winner: highest status rank, then most recent Modified_Time
        const sorted = [...leads].sort((a, b) => {
          const ra = statusRank(a.Lead_Status || "");
          const rb = statusRank(b.Lead_Status || "");
          if (ra !== rb) return rb - ra;
          const ta = new Date(a.Modified_Time || 0).getTime();
          const tb = new Date(b.Modified_Time || 0).getTime();
          return tb - ta;
        });
        const winner = sorted[0];
        const losers = sorted.slice(1);

        // Build winner-update delta from losers' fields (fill blanks only)
        const winnerUpdate: any = {};
        for (const loser of losers) {
          if (!winner.Email && loser.Email) winnerUpdate.Email = loser.Email;
          if (!winner.First_Name && loser.First_Name) winnerUpdate.First_Name = loser.First_Name;
          if ((!winner.Last_Name || winner.Last_Name === ".") && loser.Last_Name && loser.Last_Name !== ".") {
            winnerUpdate.Last_Name = loser.Last_Name;
          }
          if (!winner.ASBL_Project && loser.ASBL_Project) winnerUpdate.ASBL_Project = loser.ASBL_Project;
          if (!winner.Lead_Comments && loser.Lead_Comments) winnerUpdate.Lead_Comments = loser.Lead_Comments;
        }

        const groupResult: any = {
          phone,
          winner_id: winner.id,
          winner_status: winner.Lead_Status,
          winner_modified: winner.Modified_Time,
          winner_update_keys: Object.keys(winnerUpdate),
          loser_ids: losers.map((l) => l.id),
          loser_summary: losers.map((l) => ({
            id: l.id, status: l.Lead_Status, modified: l.Modified_Time, plid: l.Project_Lead_ID,
          })),
          actions: [] as string[],
        };

        if (dry) {
          groupResult.actions.push("DRY — would update winner + delete losers + repoint Supabase plid");
        } else {
          // 4a. Patch winner with merged fields (if any)
          if (Object.keys(winnerUpdate).length) {
            try {
              const upd = await fetch(`${ZOHO_API_BASE}/Leads`, {
                method: "PATCH",
                headers: {
                  Authorization: `Zoho-oauthtoken ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ data: [{ id: winner.id, ...winnerUpdate }] }),
              });
              if (upd.ok) { winnersUpdated++; groupResult.actions.push(`patched winner: ${Object.keys(winnerUpdate).join(",")}`); }
              else groupResult.actions.push(`WARN patch winner failed: ${upd.status}`);
            } catch (err: any) {
              groupResult.actions.push(`ERR patch winner: ${err.message}`);
            }
          }

          // 4b. Repoint Supabase leads(plid).zoho_lead_id to winner.id for each loser's plid
          for (const loser of losers) {
            const plid = loser.Project_Lead_ID;
            if (!plid) continue;
            try {
              const upd = await fetch(
                `${SUPABASE_URL}/rest/v1/leads?plid=eq.${encodeURIComponent(plid)}`,
                {
                  method: "PATCH",
                  headers: {
                    "Content-Type": "application/json",
                    apikey: SUPABASE_KEY,
                    Authorization: `Bearer ${SUPABASE_KEY}`,
                    Prefer: "return=minimal",
                  },
                  body: JSON.stringify({ zoho_lead_id: winner.id, updated_at: new Date().toISOString() }),
                },
              );
              if (upd.ok) { supabaseRepoints++; groupResult.actions.push(`supabase repoint ${plid} → ${winner.id}`); }
              else groupResult.actions.push(`WARN supabase repoint failed ${upd.status}`);
            } catch (err: any) {
              groupResult.actions.push(`ERR supabase repoint: ${err.message}`);
            }
          }

          // 4c. Delete losers from Zoho
          for (const loser of losers) {
            try {
              const del = await fetch(`${ZOHO_API_BASE}/Leads/${loser.id}`, {
                method: "DELETE",
                headers: { Authorization: `Zoho-oauthtoken ${token}` },
              });
              if (del.ok || del.status === 204) {
                losersDeleted++;
                groupResult.actions.push(`deleted ${loser.id}`);
              } else {
                groupResult.actions.push(`WARN delete ${loser.id} failed: ${del.status}`);
              }
            } catch (err: any) {
              groupResult.actions.push(`ERR delete ${loser.id}: ${err.message}`);
            }
          }
        }

        results.push(groupResult);
      }

      return res.status(200).json({
        ok: true,
        dry,
        max: maxGroups,
        total_leads_scanned: all.length,
        total_dupe_phones_found: dupeGroups.length,
        groups_processed: groupsProcessed,
        winners_updated: winnersUpdated,
        losers_deleted: losersDeleted,
        supabase_repoints: supabaseRepoints,
        remaining_dupes: Math.max(0, dupeGroups.length - groupsProcessed),
        done: groupsProcessed >= dupeGroups.length,
        results,
      });
    } catch (err: any) {
      console.error(`[zoho-dedup-leads] failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.query.action === "list-indian-leads") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const token = await getAccessToken();
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const fields = "id,First_Name,Last_Name,Mobile,Phone,Lead_Status,ASBL_Project,Modified_Time";

      const callable: Array<{
        id: string;
        first_name: string;
        last_name: string;
        phone: string;
        status: string;
        project: string;
        modified: string;
      }> = [];
      let pagesFetched = 0;
      let totalScanned = 0;
      let skippedNoPhone = 0;
      let skippedNonIndian = 0;

      // Zoho /Leads returns max 200/page. Page until empty.
      // Cap at 10 pages (2000 leads) to stay under Vercel 10s budget.
      const MAX_PAGES = 10;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await fetch(
          `${ZOHO_API_BASE}/Leads?fields=${fields}` +
            `&per_page=200&page=${page}&sort_by=Created_Time&sort_order=desc`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
        );
        if (r.status === 204) break;
        if (!r.ok) {
          return res.status(500).json({
            error: `Zoho fetch failed page ${page}: ${r.status} ${(await r.text()).slice(0, 200)}`,
          });
        }
        const data = await r.json() as any;
        const rows = (data?.data || []) as any[];
        pagesFetched++;
        totalScanned += rows.length;

        for (const lead of rows) {
          // Prefer Mobile; fall back to Phone
          const rawPhone = String(lead.Mobile || lead.Phone || "").trim();
          if (!rawPhone) { skippedNoPhone++; continue; }
          const digits = rawPhone.replace(/\D/g, "");
          // Indian: 91 prefix (with +91 or just 91) + 10 digits = 12 digits total,
          // OR plain 10 digits (we treat as Indian by default per Zoho convention)
          const isIndian = digits.startsWith("91") && digits.length === 12;
          const isBare10 = digits.length === 10;
          if (!isIndian && !isBare10) { skippedNonIndian++; continue; }
          const normalised = isIndian ? `+${digits}` : `+91${digits}`;

          callable.push({
            id: String(lead.id),
            first_name: lead.First_Name || "",
            last_name: lead.Last_Name || "",
            phone: normalised,
            status: lead.Lead_Status || "",
            project: lead.ASBL_Project || "",
            modified: lead.Modified_Time || "",
          });
        }

        // Stop early if Zoho told us this was the last page
        if (!data?.info?.more_records) break;
      }

      return res.status(200).json({
        ok: true,
        total_scanned: totalScanned,
        pages_fetched: pagesFetched,
        skipped_no_phone: skippedNoPhone,
        skipped_non_indian: skippedNonIndian,
        callable_count: callable.length,
        leads: callable,
      });
    } catch (err: any) {
      console.error(`[list-indian-leads] failed: ${err.message}`);
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

  // ─── ensure-leads-indexes — create the hot-path indexes on the `leads`
  //     collection (zoho_lead_id / phone / mlid / source_lead_id / sync) and
  //     return the resulting index list. Idempotent.
  //   GET ?action=ensure-leads-indexes&secret=<INHOUSE_POSTHOOK_SECRET>
  if (req.method === "GET" && req.query.action === "ensure-leads-indexes") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    try {
      const { ensureLeadIndexesNow } = await import("./_utils/supabase");
      const indexes = await ensureLeadIndexesNow();
      return res.status(200).json({ ok: true, collection: "leads", indexes });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ─── posthook-payloads — inspect the raw voice-bot call_completed payloads
  //     captured by inhouse-posthook, to find which field carries the pre-site
  //     disposition (the dashboard tags PRE_SITE but our CRM stays "Contacted").
  //   GET ?action=posthook-payloads&secret=<INHOUSE_POSTHOOK_SECRET>&limit=20[&phone=98xxxxxxxx]
  if (req.method === "GET" && req.query.action === "posthook-payloads") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    try {
      const { getCollection } = await import("./_utils/mongo");
      const col = await getCollection("posthook_payloads" as any);
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const q: any = {};
      if (req.query.phone) {
        const d = String(req.query.phone).replace(/\D/g, "").slice(-10);
        if (d) q.phone = { $regex: d + "$" };
      }
      const rows = (await col.find(q).sort({ at: -1 }).limit(limit).toArray()) as any[];
      // Surface the distinct disposition-bearing values across all captured rows
      // so the pre-site field jumps out even without reading each body.
      const dispositionFields = ["call_outcome", "zoho_status", "call_result_slug", "status", "disposition", "call_disposition", "tag", "journey_status", "outcome", "call_status"];
      const seen: Record<string, Set<string>> = {};
      for (const r of rows) {
        const b = r.body || {};
        for (const f of dispositionFields) {
          if (b[f] !== undefined && b[f] !== null && typeof b[f] !== "object") {
            (seen[f] ||= new Set()).add(String(b[f]));
          }
        }
      }
      const field_value_summary: Record<string, string[]> = {};
      for (const f of Object.keys(seen)) field_value_summary[f] = Array.from(seen[f]);
      return res.status(200).json({
        ok: true,
        count: rows.length,
        field_value_summary,
        rows: rows.map((r) => ({
          at: r.at,
          call_id: r.call_id,
          phone: r.phone,
          top_level_keys: r.top_level_keys,
          raw_slug_read: r.raw_slug_read,
          duration_secs: r.duration_secs,
          extracted_slots: r.extracted_slots,
          body: r.body,
        })),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── reconcile-zoho-pending — re-create in Zoho the leads captured in Mongo
  //     whose Zoho createLead failed (INVALID_TOKEN storm / rate-limit / CRM
  //     Plus trial expired). Mongo-first durability means they were NOT lost;
  //     this syncs them once Zoho is healthy. Idempotent, spaced, batched.
  //   POST ?action=reconcile-zoho-pending&secret=<INHOUSE_POSTHOOK_SECRET>&limit=25[&fanout=true]
  if (req.method === "POST" && req.query.action === "reconcile-zoho-pending") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    try {
      const { getCollection, COL } = await import("./_utils/mongo");
      const { createLead, updateLead } = await import("./_utils/zoho");
      const col = await getCollection(COL.LEADS);
      const limit = Math.min(Number(req.query.limit) || 25, 200);
      const fanout = String(req.query.fanout || "") === "true";

      const pendingQ: any = { zoho_synced: false, zoho_lead_id: null, zoho_payload_pending: { $exists: true } };
      const pending = (await col.find(pendingQ).sort({ zoho_queued_at: 1 }).limit(limit).toArray()) as any[];

      let synced = 0, stillFailing = 0, fannedOut = 0;
      const results: any[] = [];
      for (const doc of pending) {
        const payload = doc.zoho_payload_pending;
        if (!payload) continue;
        try {
          const zohoLeadId = await createLead(payload);
          if (payload.Born_Date) { await updateLead(zohoLeadId, { Born_Date: payload.Born_Date }).catch(() => {}); }
          await col.updateOne(
            { _id: doc._id } as any,
            {
              $set: { zoho_lead_id: zohoLeadId, zoho_synced: true, zoho_synced_at: new Date().toISOString() },
              $unset: { zoho_payload_pending: "", zoho_error: "" },
            },
          );
          synced++;
          let didFanout = false;
          if (fanout) {
            try {
              const { handleLeadCreated } = await import("./_utils/prd_orchestrator");
              await handleLeadCreated({
                zoho_lead_id: zohoLeadId,
                phone: doc.phone,
                customer_name: [doc.first_name, doc.last_name].filter((x: any) => x && x !== ".").join(" ").trim() || "there",
                project: doc.project || undefined,
                is_resubmission: false,
                last_page_visited: doc.last_page_visited,
                budget: doc.lead_budget,
                size_preference: doc.size_preference,
              });
              didFanout = true; fannedOut++;
            } catch (fe: any) {
              console.error(`[reconcile] fanout failed for ${doc._id}: ${fe.message}`);
            }
          }
          results.push({ plid: doc._id, phone: doc.phone, project: doc.project, zoho_lead_id: zohoLeadId, fanout: didFanout });
        } catch (ce: any) {
          stillFailing++;
          await col.updateOne({ _id: doc._id } as any, { $set: { zoho_error: ce.message, zoho_reconcile_last_try: new Date().toISOString() } });
          results.push({ plid: doc._id, phone: doc.phone, status: "still_failing", error: ce.message });
        }
        // Gentle spacing so a big backlog doesn't re-trigger the /token rate limit.
        await new Promise((r) => setTimeout(r, 250));
      }

      const remaining = await col.countDocuments(pendingQ);
      return res.status(200).json({
        ok: true,
        processed: pending.length,
        synced,
        still_failing: stillFailing,
        fanned_out: fannedOut,
        fanout_enabled: fanout,
        remaining_pending: remaining,
        note: fanout
          ? "fanout=true → recovered leads also got WhatsApp + AI call."
          : "createLead only (no outreach). Pass &fanout=true to also fire T=0 WhatsApp + call.",
        results,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── inncircles-audit — is the Inncircles caller actually SENDING born_date
  //     + origin flags, did they land in Mongo, and do they match Zoho?
  //     Read-only diagnostic (no writes, no side effects).
  //   GET ?action=inncircles-audit&secret=<INHOUSE_POSTHOOK_SECRET>&limit=20
  if (req.method === "GET" && req.query.action === "inncircles-audit") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    try {
      const { getCollection, COL } = await import("./_utils/mongo");
      const col = await getCollection(COL.LEADS);
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      // Inncircles-origin leads: source "Inncircles M1" / "Manual Reactivation",
      // or utm_source contains inncircles.
      const q: any = {
        $or: [
          { lead_source: { $regex: /inncircles/i } },
          { lead_source: "Manual Reactivation" },
          { utm_source: { $regex: /inncircles/i } },
        ],
      };
      const rows = (await col.find(q).sort({ updated_at: -1 }).limit(limit).toArray()) as any[];

      const flagKeys = ["is_reactivated", "is_born_fresh", "is_born_in_other_project", "is_bulk_transfer"] as const;
      const stats = { sample: rows.length, any_flag_set: 0, born_date_caller_supplied: 0, reactivation_is_latest_set: 0 };

      const sample = rows.map((r) => {
        const anyFlag = flagKeys.some((k) => r[k] !== null && r[k] !== undefined);
        if (anyFlag) stats.any_flag_set++;
        // Caller-supplied born date = differs from the CRM-entry date (else it's
        // just the fallback lead_received_at.slice(0,10)).
        const entryDate = r.lead_received_at ? String(r.lead_received_at).slice(0, 10) : null;
        const bornSupplied = !!(r.born_date && entryDate && r.born_date !== entryDate);
        if (bornSupplied) stats.born_date_caller_supplied++;
        if (r.reactivation_is_latest !== null && r.reactivation_is_latest !== undefined) stats.reactivation_is_latest_set++;
        return {
          phone: r.phone || r._id,
          project: r.project ?? null,
          lead_source: r.lead_source ?? null,
          born_date: r.born_date ?? null,
          born_supplied_by_caller: bornSupplied,
          is_reactivated: r.is_reactivated ?? null,
          is_born_fresh: r.is_born_fresh ?? null,
          is_born_in_other_project: r.is_born_in_other_project ?? null,
          is_bulk_transfer: r.is_bulk_transfer ?? null,
          reactivation_is_latest: r.reactivation_is_latest ?? null,
          zoho_lead_id: r.zoho_lead_id ?? null,
          lead_received_at: r.lead_received_at ?? null,
          updated_at: r.updated_at ?? null,
        };
      });

      // Cross-check the newest lead that has a Zoho id — proves whether the same
      // values that Mongo holds are actually visible on the Zoho record.
      let zohoCrossCheck: any = null;
      const withZoho = sample.find((s) => s.zoho_lead_id);
      if (withZoho) {
        try {
          const { getAccessToken } = await import("./_utils/zoho");
          const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
          const token = await getAccessToken();
          const fields = "Born_Date,Inncircles_Born_Date,IsBorn_Fresh,IsReactivated,IsBorn_InOtherProject,IsBulkTransfer,Reactivation_Is_Latest,Lead_Source,ASBL_Project";
          const zr = await fetch(`${ZOHO_API_BASE}/Leads/${withZoho.zoho_lead_id}?fields=${fields}`, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
          });
          const zj = (await zr.json().catch(() => ({}))) as any;
          const zl = zj?.data?.[0] || null;
          zohoCrossCheck = zl
            ? {
                zoho_lead_id: withZoho.zoho_lead_id,
                phone: withZoho.phone,
                zoho: {
                  Born_Date: zl.Born_Date ?? null,
                  Inncircles_Born_Date: zl.Inncircles_Born_Date ?? null,
                  IsBorn_Fresh: zl.IsBorn_Fresh ?? null,
                  IsReactivated: zl.IsReactivated ?? null,
                  IsBorn_InOtherProject: zl.IsBorn_InOtherProject ?? null,
                  IsBulkTransfer: zl.IsBulkTransfer ?? null,
                  Reactivation_Is_Latest: zl.Reactivation_Is_Latest ?? null,
                },
                mongo: {
                  born_date: withZoho.born_date,
                  is_born_fresh: withZoho.is_born_fresh,
                  is_reactivated: withZoho.is_reactivated,
                  is_born_in_other_project: withZoho.is_born_in_other_project,
                  is_bulk_transfer: withZoho.is_bulk_transfer,
                  reactivation_is_latest: withZoho.reactivation_is_latest,
                },
              }
            : { error: "zoho lead not found", http_status: zr.status, body: JSON.stringify(zj).slice(0, 300) };
        } catch (e: any) {
          zohoCrossCheck = { error: e.message };
        }
      }

      return res.status(200).json({
        ok: true,
        verdict: {
          caller_sending_flags: stats.any_flag_set > 0,
          caller_sending_born_date: stats.born_date_caller_supplied > 0,
          note:
            stats.any_flag_set === 0
              ? "NONE of the sampled Inncircles leads has any origin flag set → the caller is NOT sending IsBorn_Fresh / IsReactivated / IsBorn_InOtherProject / IsBulkTransfer yet (all null in Mongo)."
              : `${stats.any_flag_set}/${stats.sample} sampled Inncircles leads have at least one origin flag set in Mongo → caller IS sending flags.`,
          born_note:
            stats.born_date_caller_supplied === 0
              ? "No sampled lead has a caller-supplied born_date (born_date == CRM-entry date everywhere) → caller is NOT sending born_date; the value is just the fallback."
              : `${stats.born_date_caller_supplied}/${stats.sample} sampled leads have a caller-supplied born_date distinct from the CRM-entry date.`,
        },
        stats,
        sample,
        zoho_cross_check: zohoCrossCheck,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── cadence-counts — read-only breakdown of the never-called CALL QUEUE
  //     (leads with Next_Call_At set but no Last_Inhouse_Call_ID yet), split by
  //     today vs backlog, India vs NRI, and LEGACY vs other project — plus a
  //     count of ALL leads created today. Lets ops decide scope before resuming
  //     calls. Pure Zoho COQL reads; no writes, no dials.
  //   GET /api/chat-history?action=cadence-counts&secret=<INHOUSE_POSTHOOK_SECRET>
  if (req.method === "GET" && req.query.action === "cadence-counts") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    try {
      const { getAccessToken } = await import("./_utils/zoho");
      const token = await getAccessToken();
      const COQL_URL = "https://www.zohoapis.in/crm/v3/coql";

      // IST midnight today, as a Zoho-friendly ISO with +05:30 offset.
      const nowMs = Date.now();
      const istNow = new Date(nowMs + 5.5 * 3600 * 1000);
      const istMidnight = `${istNow.getUTCFullYear()}-${String(istNow.getUTCMonth() + 1).padStart(2, "0")}-${String(istNow.getUTCDate()).padStart(2, "0")}T00:00:00+05:30`;

      async function coqlPage(selectQuery: string): Promise<any[]> {
        const r = await fetch(COQL_URL, {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ select_query: selectQuery }),
        });
        if (r.status === 204) return [];
        if (!r.ok) throw new Error(`COQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const j = (await r.json()) as any;
        return (j?.data || []) as any[];
      }

      // Country bucket from a stored number: 10-digit or +91… = India; else NRI.
      const isIndia = (num?: string | null): boolean => {
        const d = String(num || "").replace(/\D/g, "");
        if (!d) return false;
        if (d.length === 10) return true;                 // local 10-digit
        if (d.startsWith("91") && d.length === 12) return true;
        return false;
      };

      // 1) The never-called call queue: Next_Call_At set, never dialed.
      const queue = { total: 0, today: 0, backlog: 0, india: 0, nri: 0, legacy: 0, other_project: 0 };
      const MAX_PAGES = 15; // 15×200 = 3000 rows cap (guards the serverless budget)
      let unknownCountry = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const rows = await coqlPage(
          `select id, ASBL_Project, Mobile, Phone, Created_Time from Leads ` +
          `where Next_Call_At is not null and Last_Inhouse_Call_ID is null ` +
          `order by Created_Time desc limit 200 offset ${page * 200}`,
        );
        for (const l of rows) {
          queue.total++;
          const created = l.Created_Time ? new Date(l.Created_Time).getTime() : 0;
          if (created >= new Date(istMidnight).getTime()) queue.today++; else queue.backlog++;
          const india = isIndia(l.Mobile) || isIndia(l.Phone);
          if (india) queue.india++; else { queue.nri++; if (!l.Mobile && !l.Phone) unknownCountry++; }
          if (String(l.ASBL_Project || "").toUpperCase() === "LEGACY") queue.legacy++; else queue.other_project++;
        }
        if (rows.length < 200) break;
      }

      // 2) ALL leads created today (any call state) — the "aaj ki leads" number.
      let todayTotal = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const rows = await coqlPage(
          `select id from Leads where Created_Time >= '${istMidnight}' ` +
          `order by Created_Time desc limit 200 offset ${page * 200}`,
        );
        todayTotal += rows.length;
        if (rows.length < 200) break;
      }

      return res.status(200).json({
        ok: true,
        as_of: new Date(nowMs).toISOString(),
        ist_midnight: istMidnight,
        leads_created_today: todayTotal,
        never_called_queue: queue,
        capped: queue.total >= MAX_PAGES * 200 ? `queue count capped at ${MAX_PAGES * 200}` : null,
        note: "never_called_queue = leads with Next_Call_At set but no call yet (what the cron dials FIFO). nri = non-India numbers. Counts, no dials.",
        unknown_country_in_nri: unknownCountry,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── call-batch-list — read-only. Given a list of MLIDs (+ optionally the
  //     never-called "fresh" pool), return the leads that are GENUINELY CALLABLE
  //     and INDIAN, after the manual-batch guards (skip terminal/pre-site stage,
  //     call_blocked, already-called, non-India, no-zoho-id; dedupe by phone).
  //     Powers the localhost 2-at-a-time trigger controller. NO writes, no dials.
  //   POST /api/chat-history?action=call-batch-list&secret=<INHOUSE_POSTHOOK_SECRET>
  //   Body: { mlids?: ["3091",...], includeFresh?: true, freshLimit?: 1500 }
  if ((req.method === "POST" || req.method === "GET") && req.query.action === "call-batch-list") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const body = (req.body || {}) as any;
      const mlids: string[] = Array.isArray(body.mlids)
        ? body.mlids.map((m: any) => String(m).trim()).filter(Boolean) : [];
      const includeFresh = body.includeFresh !== false;
      const freshLimit = Math.min(Math.max(Number(body.freshLimit) || 1500, 0), 5000);
      const { getCollection, COL } = await import("./_utils/mongo");
      const leads = await getCollection(COL.LEADS);

      const digitsOf = (p: any) => String(p || "").replace(/\D/g, "");
      const isIndia = (p: any) => { const d = digitsOf(p); return d.length === 10 || (d.startsWith("91") && d.length === 12); };
      const SKIP_STAGES = new Set(["not interested", "spam", "pre site visit"]);
      const phoneOf = (d: any) => digitsOf(d.phone || d.Mobile || d.zoho?.Mobile || d.zoho?.Phone);
      const stageOf = (d: any) => String(d.prd_stage || d.zoho?.PRD_Stage || d.lead_status || "").trim();
      const calledOf = (d: any) => !!(d.last_inhouse_call_id || d.zoho?.Last_Inhouse_Call_ID);
      const zidOf = (d: any) => d.zoho_lead_id || d.zoho?.id || null;

      const seen = new Set<string>();
      const docs: any[] = [];
      if (mlids.length) {
        const byMlid = await leads.find({ mlid: { $in: mlids } } as any).toArray();
        for (const d of byMlid) { const k = String((d as any)._id); if (!seen.has(k)) { seen.add(k); (d as any).__src = "mlid"; docs.push(d); } }
      }
      if (includeFresh) {
        const fresh = await leads.find({
          $and: [
            { $or: [{ last_inhouse_call_id: { $in: [null, ""] } }, { last_inhouse_call_id: { $exists: false } }] },
            { prd_stage: { $exists: true, $ne: null } },
            { prd_stage: { $nin: ["Not Interested", "Spam", "Pre Site Visit"] } },
          ],
        } as any).limit(freshLimit).toArray();
        for (const d of fresh) { const k = String((d as any)._id); if (!seen.has(k)) { seen.add(k); (d as any).__src = "fresh"; docs.push(d); } }
      }

      const skip: Record<string, number> = { not_found: 0, no_phone: 0, not_indian: 0, terminal_stage: 0, blocked: 0, already_called: 0, no_zoho_id: 0, duplicate_phone: 0 };
      const foundMlids = new Set(docs.filter((d) => d.__src === "mlid").map((d) => String(d.mlid)));
      for (const m of mlids) if (!foundMlids.has(m)) skip.not_found++;

      const callable: any[] = [];
      const phoneSeen = new Set<string>();
      for (const d of docs) {
        const phone = phoneOf(d);
        if (!phone) { skip.no_phone++; continue; }
        if (!isIndia(phone)) { skip.not_indian++; continue; }
        if (SKIP_STAGES.has(stageOf(d).toLowerCase())) { skip.terminal_stage++; continue; }
        if ((d as any).call_blocked === true) { skip.blocked++; continue; }
        if (calledOf(d)) { skip.already_called++; continue; }
        const zid = zidOf(d);
        if (!zid) { skip.no_zoho_id++; continue; }
        if (phoneSeen.has(phone)) { skip.duplicate_phone++; continue; }
        phoneSeen.add(phone);
        callable.push({
          mlid: String(d.mlid || ""), zoho_lead_id: String(zid),
          phone: "+" + (phone.length === 10 ? "91" + phone : phone),
          project: (d as any).project || (d as any).zoho?.ASBL_Project || "", stage: stageOf(d), src: (d as any).__src,
        });
      }

      return res.status(200).json({
        ok: true,
        input_mlids: mlids.length,
        candidates: docs.length,
        callable_count: callable.length,
        breakdown_by_src: { mlid: callable.filter((c) => c.src === "mlid").length, fresh: callable.filter((c) => c.src === "fresh").length },
        skipped: skip,
        callable,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── block-calls — mark leads so the dial-time guard NEVER proactively
  //     calls them. Each supplied id is matched against mlid / zoho_lead_id /
  //     source_lead_id / plid(_id) in the Mongo `leads` collection. mlid is the
  //     in-house "Lead ID" shown in the CRM, so a plain numeric id matches that.
  //     Sets call_blocked=true on EVERY matched doc — a person with multiple
  //     project leads (same mlid) gets all of them blocked. The execution-time
  //     guard (call_guard) reads call_blocked, aborts the dial, and clears
  //     Next_Call_At on the next scheduler tick — no customer is ever dialed.
  //
  //   POST /api/chat-history?action=block-calls&secret=<INHOUSE_POSTHOOK_SECRET>
  //   Body: { ids: ["1270490", ...], commit?: false, unblock?: false, reason?: "" }
  //     commit=false (default) → PREVIEW: report matches, NO writes.
  //     commit=true            → set call_blocked = !unblock on all matched docs.
  if (req.method === "POST" && req.query.action === "block-calls") {
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    try {
      let body: any = req.body || {};
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      const rawIds: any[] = Array.isArray(body.ids) ? body.ids : [];
      const ids = Array.from(new Set(rawIds.map((x) => String(x).trim()).filter(Boolean)));
      if (!ids.length) return res.status(400).json({ error: "body.ids must be a non-empty array of lead ids" });
      const commit = body.commit === true;
      const unblock = body.unblock === true;
      const reason = String(body.reason || "manual ops block").slice(0, 200);

      const { getCollection, COL } = await import("./_utils/mongo");
      const col = await getCollection(COL.LEADS);

      const q: any = {
        $or: [
          { mlid: { $in: ids } },
          { zoho_lead_id: { $in: ids } },
          { source_lead_id: { $in: ids } },
          { _id: { $in: ids } },
        ],
      };
      const docs = (await col
        .find(q, {
          projection: {
            _id: 1, mlid: 1, zoho_lead_id: 1, source_lead_id: 1, phone: 1,
            project: 1, first_name: 1, last_name: 1, call_blocked: 1,
          } as any,
        })
        .toArray()) as any[];

      const idSet = new Set(ids);
      const matchedIds = new Set<string>();
      const matches = docs.map((d) => {
        let matched_id: string | null = null;
        let matched_field = "";
        if (idSet.has(String(d.mlid)))               { matched_id = String(d.mlid);           matched_field = "mlid"; }
        else if (idSet.has(String(d.zoho_lead_id)))  { matched_id = String(d.zoho_lead_id);   matched_field = "zoho_lead_id"; }
        else if (idSet.has(String(d.source_lead_id))){ matched_id = String(d.source_lead_id); matched_field = "source_lead_id"; }
        else if (idSet.has(String(d._id)))           { matched_id = String(d._id);            matched_field = "plid"; }
        if (matched_id) matchedIds.add(matched_id);
        return {
          matched_id,
          matched_field,
          plid: d._id,
          mlid: d.mlid ?? null,
          zoho_lead_id: d.zoho_lead_id ?? null,
          phone: d.phone ?? null,
          project: d.project ?? null,
          name: [d.first_name, d.last_name].filter((x: any) => x && x !== ".").join(" ").trim() || null,
          already_blocked: d.call_blocked === true,
        };
      });
      const unmatched_ids = ids.filter((id) => !matchedIds.has(id));

      let modified = 0;
      if (commit && docs.length) {
        const plids = docs.map((d) => d._id);
        const r = await col.updateMany(
          { _id: { $in: plids } } as any,
          unblock
            ? { $set: { call_blocked: false, call_block_reason: null, call_unblocked_at: new Date().toISOString() } }
            : { $set: { call_blocked: true, call_block_reason: reason, call_blocked_at: new Date().toISOString() } },
        );
        modified = (r as any).modifiedCount ?? 0;
      }

      return res.status(200).json({
        ok: true,
        mode: commit ? (unblock ? "UNBLOCK (committed)" : "BLOCK (committed)") : "PREVIEW (no writes)",
        requested_ids: ids.length,
        matched_ids: matchedIds.size,
        matched_docs: matches.length,
        newly_changed: modified,
        unmatched_ids,
        note: commit
          ? (unblock
              ? `call_blocked=false on ${matches.length} lead doc(s) — calls re-enabled.`
              : `call_blocked=true on ${matches.length} lead doc(s) (${modified} newly set). The dial-time guard now aborts every proactive call for these and clears Next_Call_At on the next tick — no customer is dialed.`)
          : "PREVIEW only — nothing written. Re-POST with commit:true to apply.",
        matches,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── block-phone — pre-block a SINGLE number so it NEVER gets a proactive
  //   call (T=0 or cron), even before its lead exists. call_guard checks this
  //   list by phone. Targeted: only this number is affected, everyone else
  //   dials normally. Run this BEFORE creating the lead in Zoho.
  //   POST /api/chat-history?action=block-phone&secret=<INHOUSE_POSTHOOK_SECRET>
  //     body: { "phone": "+918235276810" }          → block
  //           { "phone": "...", "unblock": true }    → un-block
  if (req.method === "POST" && req.query.action === "block-phone") {
    const incomingSecret =
      (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!expectedSecret || incomingSecret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    try {
      let body: any = req.body || {};
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      const raw = String(body.phone || req.query.phone || "").trim();
      const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
      if (digits.length < 10) {
        return res.status(400).json({ error: "valid phone required (e.g. +918235276810)" });
      }
      const norm = digits.length === 10 ? `91${digits}` : digits;
      const last10 = norm.slice(-10);
      const unblock = body.unblock === true || String(req.query.unblock || "") === "true";
      const reason = String(body.reason || "manual single-number block").slice(0, 200);

      const { getCollection, COL } = await import("./_utils/mongo");
      const col = await getCollection(COL.CALL_BLOCK_LIST);

      if (unblock) {
        const r = await col.deleteOne({ _id: norm as any });
        return res.status(200).json({
          ok: true, mode: "UNBLOCK", phone: norm,
          removed: (r as any).deletedCount ?? 0,
          note: `${norm} removed from the number-block list — proactive calls re-enabled for it.`,
        });
      }

      await col.updateOne(
        { _id: norm as any },
        { $set: { last10, reason, blocked_at: new Date().toISOString() } },
        { upsert: true },
      );

      // Belt + braces: also flag any EXISTING lead docs for this phone right now,
      // so a cron dial is blocked even before call_guard is reached.
      let existingBlocked = 0;
      try {
        const leads = await getCollection(COL.LEADS);
        const r = await leads.updateMany(
          { phone: { $in: [norm, last10, digits] } } as any,
          { $set: { call_blocked: true, call_block_reason: reason, call_blocked_at: new Date().toISOString() } },
        );
        existingBlocked = (r as any).modifiedCount ?? 0;
      } catch { /* best-effort */ }

      return res.status(200).json({
        ok: true, mode: "BLOCK", phone: norm, last10,
        existing_lead_docs_blocked: existingBlocked,
        note: `${norm} added to the number-block list. call_guard now aborts EVERY proactive dial (T=0 + cron) for THIS number only — no other lead is affected. Add this BEFORE creating the lead in Zoho.`,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
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

      // ── whatsapp_messages (paginated — table can be 100K+ rows) ─────────
      if (collection === "whatsapp_messages") {
        // Schema v2 (2026-05-21): phone-grouped + IST date-bucketed.
        // One Mongo doc per phone with by_date[<IST date>][inbound|outbound]
        // arrays. We re-use insertMessage() so the exact same write path the
        // live bot uses is exercised — guarantees backfill matches live shape.
        //
        // Paginate Supabase reads in 1000-row chunks. Caller passes
        // ?since=YYYY-MM-DD (default: last 60 days, since bot only reads 30d).
        const sinceParam = (req.query.since as string) || "";
        const sinceISO = sinceParam
          ? new Date(sinceParam).toISOString()
          : new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
        const offset = parseInt(String(req.query.offset || "0"), 10);
        const PAGE = 1000;
        const RESET = req.query.reset === "1";

        // Optional reset on first page — wipes the Mongo collection so a
        // re-run doesn't $push duplicate messages into the date arrays.
        // Caller should ONLY pass reset=1 on the first page (offset=0).
        if (RESET && offset === 0) {
          const c = await getCollection(COL.WHATSAPP_MESSAGES);
          await c.deleteMany({});
        }

        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/whatsapp_messages` +
            `?created_at=gte.${encodeURIComponent(sinceISO)}` +
            `&select=id,phone,direction,message,sender,project,intent,created_at` +
            `&order=created_at.asc&limit=${PAGE}&offset=${offset}`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        if (!r.ok) {
          return res.status(500).json({ error: `Supabase fetch failed ${r.status}: ${(await r.text()).slice(0, 200)}` });
        }
        const rows = (await r.json()) as Array<any>;
        const { insertMessage } = await import("./_utils/whatsapp_messages");
        let pushed = 0;
        let skipped = 0;
        for (const row of rows) {
          const phone = String(row.phone || "").replace(/\D/g, "");
          if (!phone || !row.created_at) { skipped++; continue; }
          await insertMessage({
            phone,
            direction: row.direction,
            message: row.message || "",
            sender: row.sender ?? null,
            project: row.project ?? null,
            intent: row.intent ?? null,
            created_at: row.created_at,
          });
          pushed++;
        }
        return res.status(200).json({
          ok: true,
          collection: "whatsapp_messages",
          schema: "phone_grouped_date_bucketed_v2",
          since: sinceISO,
          offset,
          page_size: PAGE,
          scanned: rows.length,
          pushed,
          skipped,
          next_offset: rows.length === PAGE ? offset + PAGE : null,
          done: rows.length < PAGE,
          reset_applied: RESET && offset === 0,
        });
      }

      // ── project_facts (project name = _id, single page — only 5 projects) ─
      if (collection === "project_facts") {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/project_facts?select=project,facts_text,kb_text,kb_pdf_url,updated_at,kb_updated_at,offer_end_at&limit=100`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        if (!r.ok) {
          return res.status(500).json({ error: `Supabase fetch failed ${r.status}: ${(await r.text()).slice(0, 200)}` });
        }
        const rows = (await r.json()) as Array<any>;
        const col = await getCollection(COL.PROJECT_FACTS);
        let upserted = 0;
        for (const row of rows) {
          const project = String(row.project || "").toUpperCase();
          if (!project) continue;
          const doc = {
            _id: project,
            project,
            facts_text: row.facts_text || "",
            kb_text: row.kb_text ?? null,
            kb_pdf_url: row.kb_pdf_url ?? null,
            offer_end_at: row.offer_end_at ?? null,
            updated_at: row.updated_at ?? null,
            kb_updated_at: row.kb_updated_at ?? null,
          };
          await col.updateOne({ _id: project as any }, { $set: doc as any }, { upsert: true });
          upserted++;
        }
        return res.status(200).json({
          ok: true, collection: "project_facts",
          scanned: rows.length, upserted,
          projects: rows.map((r) => r.project),
        });
      }

      // ── project_documents (single page — ~50 rows total) ────────────────
      if (collection === "project_documents") {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/project_documents` +
            `?select=id,project,doc_type,filename,url,size_label,unit_size_sft,facing,tower,text_extract,text_extract_chars,text_extracted_at,fetched_at` +
            `&order=fetched_at.desc&limit=500`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        if (!r.ok) {
          return res.status(500).json({ error: `Supabase fetch failed ${r.status}: ${(await r.text()).slice(0, 200)}` });
        }
        const rows = (await r.json()) as Array<any>;
        let upserted = 0;
        for (const row of rows) {
          try {
            await upsertDocBySupabaseId(row.id, {
              project: row.project,
              doc_type: row.doc_type,
              filename: row.filename,
              url: row.url,
              size_label: row.size_label ?? null,
              unit_size_sft: row.unit_size_sft ?? null,
              facing: row.facing ?? null,
              tower: row.tower ?? null,
              text_extract: row.text_extract ?? null,
              text_extract_chars: row.text_extract_chars ?? null,
              text_extracted_at: row.text_extracted_at ?? null,
              fetched_at: row.fetched_at ?? null,
            });
            upserted++;
          } catch {}
        }
        return res.status(200).json({
          ok: true, collection: "project_documents",
          scanned: rows.length, upserted,
        });
      }

      // ── mlid_registry (~ leads count) ───────────────────────────────────
      if (collection === "mlid_registry") {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/mlid_registry?select=phone,mlid,created_at&order=mlid.asc&limit=2000`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        if (!r.ok) {
          return res.status(500).json({ error: `Supabase fetch failed ${r.status}: ${(await r.text()).slice(0, 200)}` });
        }
        const rows = (await r.json()) as Array<any>;
        const col = await getCollection(COL.MLID_REGISTRY);
        let upserted = 0;
        let maxMlid = 0;
        for (const row of rows) {
          const phone = String(row.phone || "").replace(/\D/g, "");
          if (!phone) continue;
          const mlid = String(row.mlid);
          const n = parseInt(mlid, 10);
          if (isFinite(n) && n > maxMlid) maxMlid = n;
          await col.updateOne(
            { _id: phone as any },
            { $set: { _id: phone, phone, mlid, created_at: row.created_at ?? null } as any },
            { upsert: true },
          );
          upserted++;
        }
        // Seed the Mongo counter so future getNextSequence("mlid") doesn't
        // collide with already-issued MLIDs. Add a +10 buffer for safety.
        if (maxMlid > 0) {
          const counters = await getCollection(COL.COUNTERS);
          await counters.updateOne(
            { _id: "mlid" as any },
            { $set: { _id: "mlid", seq: maxMlid + 10 } as any },
            { upsert: true },
          );
        }
        return res.status(200).json({
          ok: true, collection: "mlid_registry",
          scanned: rows.length, upserted, max_mlid_seen: maxMlid,
          counter_seeded_to: maxMlid > 0 ? maxMlid + 10 : null,
        });
      }

      // ── plid_registry ───────────────────────────────────────────────────
      if (collection === "plid_registry") {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/plid_registry?select=phone,mlid,project,plid,created_at&limit=4000`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        if (!r.ok) {
          return res.status(500).json({ error: `Supabase fetch failed ${r.status}: ${(await r.text()).slice(0, 200)}` });
        }
        const rows = (await r.json()) as Array<any>;
        const col = await getCollection(COL.PLID_REGISTRY);
        let upserted = 0;
        for (const row of rows) {
          const plid = String(row.plid || "").trim();
          if (!plid) continue;
          await col.updateOne(
            { _id: plid as any },
            {
              $set: {
                _id: plid,
                plid,
                phone: String(row.phone || "").replace(/\D/g, ""),
                mlid: String(row.mlid || ""),
                project: String(row.project || ""),
                created_at: row.created_at ?? null,
              } as any,
            },
            { upsert: true },
          );
          upserted++;
        }
        return res.status(200).json({
          ok: true, collection: "plid_registry",
          scanned: rows.length, upserted,
        });
      }

      // ── leads (paginated — 1000 per page) ──────────────────────────────
      if (collection === "leads") {
        const offset = parseInt(String(req.query.offset || "0"), 10);
        const PAGE = 500;
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/leads?select=*&order=updated_at.desc&limit=${PAGE}&offset=${offset}`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        if (!r.ok) {
          return res.status(500).json({ error: `Supabase fetch failed ${r.status}: ${(await r.text()).slice(0, 200)}` });
        }
        const rows = (await r.json()) as Array<any>;
        const col = await getCollection(COL.LEADS);
        let upserted = 0;
        for (const row of rows) {
          const plid = String(row.plid || "").trim();
          if (!plid) continue;
          const doc: any = { ...row, _id: plid };
          // drop Supabase's internal id field — _id is plid
          delete doc.id;
          await col.updateOne({ _id: plid as any }, { $set: doc }, { upsert: true });
          upserted++;
        }
        return res.status(200).json({
          ok: true,
          collection: "leads",
          offset,
          page_size: PAGE,
          scanned: rows.length,
          upserted,
          next_offset: rows.length === PAGE ? offset + PAGE : null,
          done: rows.length < PAGE,
        });
      }

      // ── whatsapp_sender_map (Supabase column is `created_at`, not updated_at) ─
      if (collection === "whatsapp_sender_map") {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/whatsapp_sender_map?select=phone,sender,created_at&limit=2000`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        if (!r.ok) {
          return res.status(500).json({ error: `Supabase fetch failed ${r.status}: ${(await r.text()).slice(0, 200)}` });
        }
        const rows = (await r.json()) as Array<any>;
        const col = await getCollection(COL.WHATSAPP_SENDER_MAP);
        let upserted = 0;
        for (const row of rows) {
          const phone = String(row.phone || "").replace(/\D/g, "");
          if (!phone) continue;
          await col.updateOne(
            { _id: phone as any },
            {
              $set: {
                _id: phone, phone,
                sender: String(row.sender || ""),
                updated_at: row.created_at || new Date().toISOString(),
              } as any,
            },
            { upsert: true },
          );
          upserted++;
        }
        return res.status(200).json({ ok: true, collection: "whatsapp_sender_map", scanned: rows.length, upserted });
      }

      // ── follow_up_log (append-only — order by id since created_at isn't a column) ─
      if (collection === "follow_up_log") {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/follow_up_log?select=*&order=id.asc&limit=5000`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        if (!r.ok) {
          return res.status(500).json({ error: `Supabase fetch failed ${r.status}: ${(await r.text()).slice(0, 200)}` });
        }
        const rows = (await r.json()) as Array<any>;
        const col = await getCollection(COL.FOLLOW_UP_LOG);
        let upserted = 0;
        for (const row of rows) {
          const _id = row.id ? `sb_${row.id}` : undefined;
          if (!_id) continue;
          // Supabase column is `sent_at` (per actual prod schema, not created_at).
          // We map whatever timestamp field is present to Mongo `created_at`.
          const ts = row.created_at || row.sent_at || row.inserted_at || null;
          await col.updateOne(
            { _id: _id as any },
            {
              $set: {
                _id,
                phone: String(row.phone || "").replace(/\D/g, ""),
                follow_up_day: Number(row.follow_up_day || 0),
                sender: String(row.sender || ""),
                created_at: ts,
              } as any,
            },
            { upsert: true },
          );
          upserted++;
        }
        return res.status(200).json({
          ok: true, collection: "follow_up_log",
          scanned: rows.length, upserted,
          sample_columns: rows[0] ? Object.keys(rows[0]) : [],
        });
      }

      // ── cron_log (append-only, recent ~1000 most useful) ────────────────
      if (collection === "cron_log") {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/cron_log?select=id,task,ran_at,duration_ms,result,error&order=ran_at.desc&limit=1000`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        if (!r.ok) {
          return res.status(500).json({ error: `Supabase fetch failed ${r.status}: ${(await r.text()).slice(0, 200)}` });
        }
        const rows = (await r.json()) as Array<any>;
        const col = await getCollection(COL.CRON_LOG);
        let upserted = 0;
        for (const row of rows) {
          const _id = row.id ? `sb_${row.id}` : undefined;
          if (!_id) continue;
          await col.updateOne(
            { _id: _id as any },
            {
              $set: {
                _id,
                task: String(row.task || ""),
                ran_at: row.ran_at,
                duration_ms: Number(row.duration_ms || 0),
                result: row.result,
                error: row.error ?? null,
              } as any,
            },
            { upsert: true },
          );
          upserted++;
        }
        return res.status(200).json({ ok: true, collection: "cron_log", scanned: rows.length, upserted });
      }

      return res.status(400).json({
        error: `Unknown collection: ${collection}`,
        supported: ["bot_settings", "user_profiles", "doc_send_log", "whatsapp_messages", "project_facts", "project_documents", "mlid_registry", "plid_registry", "leads", "whatsapp_sender_map", "follow_up_log", "cron_log"],
        note: "More collections added as each Phase ships. whatsapp_messages + leads are paginated — re-call with ?offset=<next_offset> until done:true.",
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
        `(unused — Mongo path)`,
      ];
      void params; // legacy var kept for log compatibility; not used in Mongo path

      // Phase 6: Mongo — pull all rows then filter in-app (volume <2000)
      let rows = await listAllDocs({
        project: projectFilter || undefined,
        doc_type: docTypeFilter || undefined,
        limit: 2000,
      }) as any[];
      // Only keep rows with a size_label (mirrors the prior NOT NULL filter)
      rows = rows.filter((r) => r.size_label);

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

      for (const row of rows as any[]) {
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
            id: row._id, project: row.project, doc_type: row.doc_type,
            size_label: row.size_label, skipped: "no parseable hints",
          });
          continue;
        }

        if (dry) {
          results.push({
            id: row._id, project: row.project, doc_type: row.doc_type,
            size_label: row.size_label, would_update: delta,
          });
          updated++;
          continue;
        }

        try {
          await updateDocFields(String(row._id), delta);
          updated++;
          results.push({ id: row._id, project: row.project, doc_type: row.doc_type, updated: delta });
        } catch (err: any) {
          results.push({ id: row._id, error: err.message });
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

  // ─── backfill-new-model — migrate legacy `leads` into the event-sourced
  //   model (persons / crm_leads / lead_events / stale_person_record).
  //
  //   DRY-RUN BY DEFAULT — nothing is written unless commit=true is passed
  //   EXPLICITLY. Dry-run reads only and returns what it WOULD do.
  //
  //   Dry-run first:
  //     GET  /api/chat-history?action=backfill-new-model&secret=<...>&limit=500
  //   Then commit:
  //     POST /api/chat-history?action=backfill-new-model&secret=<...>&commit=true&limit=20000
  //
  //   ?limit= caps legacy docs scanned (Vercel time budget). Idempotent —
  //   re-running commit does not duplicate history events.
  if ((req.method === "GET" || req.method === "POST") && req.query.action === "backfill-new-model") {
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    // Heavy CRM op: require an ADMIN session OR the shared secret — a plain
    // approved viewer session must NOT be able to trigger a full backfill
    // commit. Fails closed on a missing/blank secret.
    if (!(session?.role === "admin") && !(expectedSecret && incomingSecret === expectedSecret)) {
      return res.status(401).json({ error: "Unauthorized — admin login OR pass ?secret=..." });
    }
    // commit ONLY when explicitly asked AND via POST — a GET can never write.
    const wantsCommit = String((req.query.commit as string) || (req.body && (req.body as any).commit) || "").toLowerCase() === "true";
    const commit = req.method === "POST" && wantsCommit;
    const limitRaw = Number((req.query.limit as string) || (req.body && (req.body as any).limit) || 500);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 500;
    try {
      const { backfillNewModel } = await import("./_utils/crm_backfill");
      const report = await backfillNewModel({ commit, limit });
      if (commit) {
        const { logAudit, clientIp } = await import("./_utils/audit");
        await logAudit({
          actor_email: session?.email || "(secret)",
          action: "backfill-new-model",
          target: "crm_model",
          summary: `commit — persons=${report.persons} active=${report.active_leads} stale=${report.stale_leads} stageSets=${report.stage_sets}`,
          ip: clientIp(req),
        }).catch(() => {});
      }
      return res.status(200).json({
        ok: true,
        ...report,
        hint: commit
          ? "COMMITTED. Re-run is safe (idempotent)."
          : "DRY-RUN only. To apply: POST the same URL with &commit=true (add &limit= to size each batch).",
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── ensure-crm-indexes — (re)build every index for the event-sourced CRM
  //   model (persons / crm_leads / lead_events / calls / messages / site_visits
  //   / stale_person_record + frozen_inbox TTL) per the approved architecture.
  //   Idempotent (createIndex is a no-op once built) and also runs lazily on the
  //   first model write; this is the manual/verifiable trigger. Returns the live
  //   index names per collection so you can confirm the plan is in place.
  //   GET|POST /api/chat-history?action=ensure-crm-indexes&secret=<...>
  if ((req.method === "GET" || req.method === "POST") && req.query.action === "ensure-crm-indexes") {
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    // Require an ADMIN session OR the shared secret (index rebuilds hit the DB —
    // keep viewer sessions out). Fails closed on a missing/blank secret.
    if (!(session?.role === "admin") && !(expectedSecret && incomingSecret === expectedSecret)) {
      return res.status(401).json({ error: "Unauthorized — admin login OR pass ?secret=..." });
    }
    try {
      const { ensureCrmIndexesNow } = await import("./_utils/crm_model");
      const indexes = await ensureCrmIndexesNow();
      const total = Object.values(indexes).reduce((n, arr) => n + arr.length, 0);
      const { logAudit, clientIp } = await import("./_utils/audit");
      await logAudit({
        actor_email: session?.email || "(secret)",
        action: "ensure-crm-indexes",
        target: "crm_model",
        summary: `built/verified ${total} indexes across ${Object.keys(indexes).length} collections`,
        ip: clientIp(req),
      }).catch(() => {});
      return res.status(200).json({
        ok: true,
        collections: Object.keys(indexes).length,
        total_indexes: total,
        indexes,
        note: "Idempotent — safe to re-run. Indexes also self-heal on first model write.",
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── drop-legacy-crm-collections — remove the event-sourced collections that
  //     were accidentally created in the LEGACY Zoho_Database (before the
  //     Intelligent_CRM db split). SAFE: drops ONLY these exact names, ONLY from
  //     Zoho_Database, and ONLY when the collection is EMPTY — never drops data.
  //     POST-only + &confirm=true required (destructive-capable; must not be
  //     reachable by a plain URL that lands in access logs / history).
  //   POST /api/chat-history?action=drop-legacy-crm-collections&secret=<...>&confirm=true
  if (req.method === "POST" && req.query.action === "drop-legacy-crm-collections") {
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    // Destructive-capable: require an ADMIN session OR the shared secret. Fails
    // closed on a missing/blank secret; a plain viewer session cannot invoke it.
    if (!(session?.role === "admin") && !(expectedSecret && incomingSecret === expectedSecret)) {
      return res.status(401).json({ error: "Unauthorized — admin login OR pass ?secret=..." });
    }
    // Explicit confirmation so an accidental/replayed call can't drop anything.
    let dropBody: any = req.body || {};
    if (typeof dropBody === "string") { try { dropBody = JSON.parse(dropBody); } catch { dropBody = {}; } }
    const confirmed = String((req.query.confirm as string) || dropBody.confirm || "").toLowerCase() === "true";
    if (!confirmed) {
      return res.status(400).json({ error: "Refused — pass confirm=true to drop the empty legacy CRM collections." });
    }
    try {
      // Hardcoded 7-name allowlist — NO user input reaches the drop. getDb() is
      // Zoho_Database ONLY, so this can never touch Intelligent_CRM.
      const NAMES = ["persons", "crm_leads", "lead_events", "calls", "messages", "site_visits", "stale_person_record"];
      const { getDb } = await import("./_utils/mongo");
      const db = await getDb(); // Zoho_Database (the LEGACY db these were wrongly created in)
      const existing = (await db.listCollections().toArray()).map((c: any) => c.name);
      const result: any[] = [];
      for (const name of NAMES) {
        if (!existing.includes(name)) { result.push({ name, status: "absent" }); continue; }
        // countDocuments({}) does a real count — estimatedDocumentCount reads
        // cached metadata that can report 0 for a non-empty collection after an
        // unclean shutdown, which would risk dropping live data.
        const count = await db.collection(name).countDocuments({});
        if (count > 0) { result.push({ name, status: "SKIPPED — not empty", count }); continue; }
        await db.collection(name).drop().catch(() => {});
        result.push({ name, status: "dropped" });
      }
      return res.status(200).json({ ok: true, db: "Zoho_Database", result });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── supabase-config-check — where do dashboard uploads actually go?
  //   Reports the SUPABASE_URL host (not the key) + does a real round-trip:
  //   upload a tiny test file via the same helper the dashboard uses, build
  //   the public URL, then fetch it back. If the round-trip fails, every
  //   dashboard upload is landing in a dead/wrong Supabase project — which
  //   is exactly the doc-delivery root cause.
  //   GET /api/chat-history?action=supabase-config-check&secret=<...>
  if (req.method === "GET" && req.query.action === "supabase-config-check") {
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!session && (!expectedSecret || incomingSecret !== expectedSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const supaUrl = process.env.SUPABASE_URL || "";
    const host = (() => { try { return new URL(supaUrl).host; } catch { return "(invalid/empty)"; } })();
    const ref = host.split(".")[0] || "";
    const DEAD_REF = "qexmwffpjawowxqqttec";
    const out: any = {
      ok: true,
      supabase_url_host: host,
      project_ref: ref,
      is_known_dead_project: ref === DEAD_REF,
      key_present: !!process.env.SUPABASE_SECRET_KEY,
    };
    try {
      const { uploadToStorage } = await import("./_utils/storage_upload");
      const testContent = Buffer.from(`asbl-upload-roundtrip ${new Date().toISOString()}`).toString("base64");
      const up = await uploadToStorage({
        project: "_diag", docType: "_test", filename: "roundtrip.txt",
        mimeType: "text/plain", base64Content: testContent,
      });
      out.upload_ok = true;
      out.public_url = up.publicUrl;
      // Fetch it back to prove it's actually retrievable (what Periskope does)
      try {
        const fr = await fetch(up.publicUrl);
        out.fetch_back_status = fr.status;
        out.fetch_back_ok = fr.ok;
        out.diagnosis = fr.ok
          ? "Uploads land in a LIVE, publicly-fetchable bucket. Doc delivery should work for newly-uploaded files."
          : `Upload succeeded but the public URL is NOT fetchable (HTTP ${fr.status}) — Periskope can't get the file. Bucket may not be public.`;
      } catch (err: any) {
        out.fetch_back_ok = false;
        out.diagnosis = `Upload succeeded but the public URL is unreachable (${err.message}) — the Supabase project URL does not resolve. This is the doc-delivery root cause.`;
      }
    } catch (err: any) {
      out.upload_ok = false;
      out.diagnosis = ref === DEAD_REF
        ? `SUPABASE_URL points to the DELETED project ${DEAD_REF}. Every dashboard upload fails / produces dead URLs. FIX: set SUPABASE_URL + SUPABASE_SECRET_KEY in Vercel to a LIVE Supabase project, then re-upload (or re-point via import-doc-urls).`
        : `Upload failed: ${err.message}`;
    }
    return res.status(200).json(out);
  }

  // ─── import-doc-urls — bulk-set project_documents from a clean URL list.
  //
  //   Root cause found 2026-06-26: the Supabase project holding every PDF
  //   (qexmwffpjawowxqqttec) was DELETED, so every doc URL in
  //   project_documents was dead and Periskope failed to fetch them. This
  //   endpoint lets you re-point the whole library to the LIVE Supabase
  //   project in one POST after re-uploading the PDFs there.
  //
  //   POST /api/chat-history?action=import-doc-urls&secret=<...>
  //     body: {
  //       wipe_first?: true,            // delete ALL existing rows first
  //       wipe_projects?: ["SPECTRA"],  // OR delete only these projects' rows
  //       verify_urls?: true,           // HEAD-check each url, skip dead ones
  //       docs: [
  //         { project, doc_type, url, filename,
  //           size_label?, tower?, facing?, unit_size_sft?, applies_to_all? },
  //         ...
  //       ]
  //     }
  //   doc_type is one of: brochure / price_sheet / specifications /
  //   master_plan / floor_plan / unit_plan / payment_structure / amenities.
  if (req.method === "POST" && req.query.action === "import-doc-urls") {
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!session && (!expectedSecret || incomingSecret !== expectedSecret)) {
      return res.status(401).json({ error: "Unauthorized — log in OR pass ?secret=..." });
    }
    try {
      const body = (req.body || {}) as any;
      const docs: any[] = Array.isArray(body.docs) ? body.docs : [];
      if (!docs.length) return res.status(400).json({ error: "docs[] required" });

      const { getCollection, COL } = await import("./_utils/mongo");
      const { insertDoc } = await import("./_utils/project_documents");
      const col = await getCollection(COL.PROJECT_DOCUMENTS);

      // Optional wipe
      let wiped = 0;
      if (body.wipe_first) {
        const r = await col.deleteMany({});
        wiped = r.deletedCount || 0;
      } else if (Array.isArray(body.wipe_projects) && body.wipe_projects.length) {
        for (const p of body.wipe_projects) {
          const r = await col.deleteMany({ project: { $regex: new RegExp(`^${p}$`, "i") } as any });
          wiped += r.deletedCount || 0;
        }
      }
      // Per-(project, doc_type) wipe — surgical: clears all rows of a doc_type
      // for a project (every size_label) before the fresh rows are inserted,
      // so multi-slot re-imports don't leave stale rows behind. Leaves other
      // doc_types (floor_plan / unit_plan / master_plan) untouched.
      if (Array.isArray(body.wipe_doc_types)) {
        for (const w of body.wipe_doc_types) {
          const p = String(w?.project || "").trim().toUpperCase();
          const dt = String(w?.doc_type || "").trim().toLowerCase();
          if (!p || !dt) continue;
          const r = await col.deleteMany({
            project: { $regex: new RegExp(`^${p}$`, "i") } as any,
            doc_type: dt,
          });
          wiped += r.deletedCount || 0;
        }
      }

      const results: any[] = [];
      let inserted = 0, skipped = 0;
      for (const d of docs) {
        const project = String(d.project || "").trim().toUpperCase();
        const doc_type = String(d.doc_type || "").trim().toLowerCase();
        const url = String(d.url || "").trim();
        if (!project || !doc_type || !url) {
          results.push({ ok: false, reason: "missing project/doc_type/url", doc: d });
          skipped++;
          continue;
        }
        // Optional: verify the URL is publicly fetchable before storing it
        if (body.verify_urls) {
          try {
            const head = await fetch(url, { method: "HEAD" });
            if (!head.ok) {
              results.push({ ok: false, reason: `url HEAD ${head.status}`, url });
              skipped++;
              continue;
            }
          } catch (err: any) {
            results.push({ ok: false, reason: `url unreachable: ${err.message}`, url });
            skipped++;
            continue;
          }
        }
        // Upsert by (project, doc_type, size_label) so re-imports replace
        // cleanly instead of duplicating.
        const sizeLabel = d.size_label != null ? String(d.size_label) : null;
        const matchFilter: any = { project, doc_type };
        if (sizeLabel != null) matchFilter.size_label = sizeLabel;
        await col.deleteMany(matchFilter);
        const id = await insertDoc({
          project,
          doc_type,
          url,
          filename: d.filename != null ? String(d.filename) : "document.pdf",
          size_label: sizeLabel,
          tower: d.tower != null ? String(d.tower) : null,
          facing: d.facing != null ? String(d.facing).toLowerCase() : null,
          unit_size_sft: d.unit_size_sft != null ? Number(d.unit_size_sft) : null,
          applies_to_all: d.applies_to_all === true,
        } as any);
        results.push({ ok: true, id, project, doc_type, size_label: sizeLabel, filename: d.filename });
        inserted++;
      }

      return res.status(200).json({
        ok: true,
        wiped,
        inserted,
        skipped,
        total_in: docs.length,
        results,
        next_step: "Run ?action=audit-project-docs to confirm, then test with ?action=send-doc-test or a real WhatsApp message.",
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── periskope-doc-diag — RAW Periskope doc-send probe. Bypasses ALL bot
  //     logic (no Gemini, no doc tool, no scoring). Hits Periskope directly
  //     and returns the EXACT HTTP status + body per (sender, endpoint) so we
  //     can see the real failure: 401 = bad key/sender, 4xx media error = bad
  //     URL, 200 = Periskope is fine (problem is upstream logic).
  //
  //   POST /api/chat-history?action=periskope-doc-diag&secret=<...>
  //     body: { phone, url?, sender?, all_senders?: true }
  //   If url omitted, uses the first Spectra brochure from project_documents.
  if (req.method === "POST" && req.query.action === "periskope-doc-diag") {
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!session && (!expectedSecret || incomingSecret !== expectedSecret)) {
      return res.status(401).json({ error: "Unauthorized — log in OR pass ?secret=..." });
    }
    try {
      const body = (req.body || {}) as any;
      const phone = String(body.phone || "").replace(/^\+/, "").replace(/\D/g, "");
      if (phone.length < 10) return res.status(400).json({ error: "valid phone required" });
      const apiKey = process.env.PERISKOPE_API_KEY || "";
      const keyPresent = !!apiKey;

      // Resolve sender list
      const sendersEnv = (process.env.PERISKOPE_SENDERS || "").split(/[\s,]+/).map((s) => s.replace(/\D/g, "")).filter((s) => s.length >= 10);
      const hardcoded = ["917793952828","919247598804","919247597422","919247597421","919247597423","919247597420","919247597418","919247597426","919247597419","919247597417"];
      const senderSource = sendersEnv.length ? "PERISKOPE_SENDERS env" : "hardcoded";
      const pool = sendersEnv.length ? sendersEnv : hardcoded;
      const senders = body.sender ? [String(body.sender).replace(/\D/g, "")] : (body.all_senders ? pool : [pool[0]]);

      // Resolve a test PDF url
      let url = String(body.url || "");
      let urlSource = "provided";
      if (!url) {
        const { getCollection, COL } = await import("./_utils/mongo");
        const col = await getCollection(COL.PROJECT_DOCUMENTS);
        const doc = await col.findOne({ project: { $regex: /spectra/i } as any, doc_type: "brochure" } as any);
        url = String((doc as any)?.url || "");
        urlSource = doc ? "spectra brochure from project_documents" : "(none found)";
      }
      if (!url) return res.status(400).json({ error: "no url provided and no spectra brochure in project_documents" });

      const endpoints = [
        "https://api.periskope.app/v1/message/send",
        "https://api.periskope.app/v1/messages/send",
      ];
      const chatId = `${phone}@c.us`;
      const payload = {
        chat_id: chatId,
        message: "ASBL test document",
        media: { type: "document", filename: "test.pdf", mimetype: "application/pdf", url },
      };

      // A/B test per sender: send a PLAIN TEXT and a DOCUMENT from the same
      // x-phone. Both return 200 "queued" from the API, but on WhatsApp the
      // user can see which actually lands. This disambiguates:
      //   - text lands, doc doesn't  -> media/payload problem
      //   - neither lands            -> sender number not connected (queues
      //                                  but never delivers)
      //   - both land                -> everything works
      const textPayload = { chat_id: chatId, message: `ASBL TEXT-ONLY test from sender ${"{S}"}` };
      const ep0 = endpoints[0];
      const attempts: any[] = [];
      let delivered = false;
      for (const s of senders) {
        const hdr = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "x-phone": s };
        // 1. text-only
        try {
          const tr = await fetch(ep0, { method: "POST", headers: hdr, body: JSON.stringify({ ...textPayload, message: `ASBL TEXT-ONLY test from sender ${s}` }) });
          attempts.push({ sender: s, kind: "text", endpoint: ep0, status: tr.status, ok: tr.ok, body: (await tr.text()).slice(0, 220) });
        } catch (err: any) {
          attempts.push({ sender: s, kind: "text", endpoint: ep0, status: 0, ok: false, body: `THREW: ${err.message}` });
        }
        // 2. document
        for (const ep of endpoints) {
          try {
            const r = await fetch(ep, { method: "POST", headers: hdr, body: JSON.stringify(payload) });
            const txt = (await r.text()).slice(0, 220);
            attempts.push({ sender: s, kind: "doc", endpoint: ep, status: r.status, ok: r.ok, body: txt });
            if (r.ok) { delivered = true; break; }
          } catch (err: any) {
            attempts.push({ sender: s, kind: "doc", endpoint: ep, status: 0, ok: false, body: `THREW: ${err.message}` });
          }
        }
        if (delivered && !body.all_senders) break;
      }

      // STATUS POLL — Periskope's response carries a track_by hint:
      //   "GET /messages/{unique_id}/status". A 200 "queued" only means the
      //   request was accepted; the document can still fail to deliver. Poll
      //   the status endpoint for each unique_id so we KNOW the real outcome
      //   (sent / delivered / failed / pending) instead of guessing.
      // Collect (unique_id, sender, kind) so we can poll each message's real
      // delivery state. The status endpoint REQUIRES the x-phone header of
      // the SENDING number (422 "Missing Header: {x-phone}" otherwise).
      const toPoll: Array<{ uid: string; sender: string; kind: string }> = [];
      for (const a of attempts) {
        const m = String(a.body || "").match(/"unique_id"\s*:\s*"([^"]+)"/);
        if (m) toPoll.push({ uid: m[1], sender: a.sender, kind: a.kind });
      }
      const statuses: any[] = [];
      if (toPoll.length) {
        await new Promise((r) => setTimeout(r, 5000)); // give Periskope a moment to attempt delivery
        for (const p of toPoll) {
          let got = false;
          for (const base of ["https://api.periskope.app/v1/messages", "https://api.periskope.app/messages"]) {
            try {
              const sr = await fetch(`${base}/${p.uid}/status`, {
                headers: { Authorization: `Bearer ${apiKey}`, "x-phone": p.sender },
              });
              if (sr.status === 404) continue;
              const sbody = (await sr.text()).slice(0, 400);
              statuses.push({ kind: p.kind, unique_id: p.uid, http: sr.status, body: sbody });
              got = true;
              break;
            } catch (err: any) {
              statuses.push({ kind: p.kind, unique_id: p.uid, http: 0, body: `THREW: ${err.message}` });
              got = true;
            }
          }
          if (!got) statuses.push({ kind: p.kind, unique_id: p.uid, http: 404, body: "no status endpoint matched" });
        }
      }

      return res.status(200).json({
        ok: true,
        delivered,
        diagnosis: !keyPresent ? "PERISKOPE_API_KEY is MISSING on this deployment"
          : delivered ? "Periskope send WORKS — any failure is in upstream bot logic, not the Periskope client"
          : attempts.some((a) => a.status === 401) ? "401 from Periskope — API key invalid OR sender(s) not connected. Check PERISKOPE_API_KEY + that the x-phone numbers are live in Periskope."
          : attempts.some((a) => /media|url|fetch|download/i.test(a.body)) ? "Periskope rejected the media URL — the PDF URL may not be publicly fetchable (signed/expired/private)."
          : "All attempts failed — see attempts[] for the exact Periskope responses.",
        key_present: keyPresent,
        sender_source: senderSource,
        senders_tried: senders,
        url_source: urlSource,
        test_url: url,
        attempts,
        delivery_status: statuses,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── export-all-kb — full handoff snapshot for migrating the bot to
  //     another codebase / vendor. Returns kb_text + facts_text + every
  //     project_documents row (with public Supabase URLs) for every
  //     project we have. Pair this with scripts/export-kb-to-disk.js to
  //     materialise the data onto local disk as a folder tree.
  //
  //   GET /api/chat-history?action=export-all-kb
  //
  //   Response (one JSON object):
  //     {
  //       projects: [
  //         {
  //           project: "SPECTRA",
  //           kb_text: "<full curated KB text>",
  //           facts_text: "<offer details text>",
  //           kb_pdf_url: "<storage url if uploaded as a PDF>",
  //           documents: [{ doc_type, size_label, tower, facing,
  //                          unit_size_sft, filename, url, text_extract }],
  //         },
  //         ...
  //       ],
  //       generated_at: "2026-06-19T...Z",
  //     }
  if (req.method === "GET" && req.query.action === "export-all-kb") {
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!session && (!expectedSecret || incomingSecret !== expectedSecret)) {
      return res.status(401).json({ error: "Unauthorized — log in OR pass ?secret=..." });
    }
    try {
      const { getCollection, COL } = await import("./_utils/mongo");
      const facts = await listAllProjectFacts();
      const docsCol = await getCollection(COL.PROJECT_DOCUMENTS);
      const docRows = await docsCol.find({}).limit(5000).toArray();
      const projects = facts.map((f: any) => {
        const projDocs = (docRows as any[]).filter((r) =>
          String(r.project || "").toUpperCase() === String(f.project || "").toUpperCase(),
        ).map((r) => ({
          doc_type: String(r.doc_type || ""),
          size_label: String(r.size_label || ""),
          tower: String(r.tower || ""),
          facing: String(r.facing || ""),
          unit_size_sft: r.unit_size_sft ?? null,
          filename: String(r.filename || ""),
          url: String(r.url || ""),
          applies_to_all: !!r.applies_to_all,
          text_extract: String(r.text_extract || "").slice(0, 6000),
        }));
        return {
          project: f.project,
          kb_text: String(f.kb_text || ""),
          facts_text: String(f.facts_text || ""),
          kb_pdf_url: String(f.kb_pdf_url || ""),
          kb_updated_at: f.kb_updated_at || null,
          documents: projDocs,
        };
      });
      return res.status(200).json({
        ok: true,
        generated_at: new Date().toISOString(),
        project_count: projects.length,
        projects,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── send-doc-test — invokes the unified sendDocumentTool directly,
  //     bypassing Gemini, so you can verify doc plumbing end-to-end.
  //
  //   POST /api/chat-history?action=send-doc-test
  //     body: {
  //       phone:      "+919876543210",      // recipient (E.164 or digits)
  //       project:    "Spectra",
  //       doc_type:   "floor_plan",         // one of the 8 enum types
  //       size_label?: "Tower-B",           // any combination of these
  //       tower?:      "B",                 //   four disambiguation
  //       facing?:     "east",              //   fields is fine
  //       unit_size_sft?: 1980,
  //       send_all?:  true                  // bulk-send every variant
  //     }
  //   Sender resolution: caller-supplied "sender" field OR sticky-map for
  //   that phone OR first pool member.
  if (req.method === "POST" && req.query.action === "send-doc-test") {
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!session && (!expectedSecret || incomingSecret !== expectedSecret)) {
      return res.status(401).json({ error: "Unauthorized — log in OR pass ?secret=..." });
    }
    try {
      const body = (req.body || {}) as any;
      const phoneRaw = String(body.phone || "").trim();
      const project = String(body.project || "").trim();
      const docType = String(body.doc_type || "").trim();
      if (!phoneRaw || !project || !docType) {
        return res.status(400).json({ error: "phone + project + doc_type are required" });
      }
      const phone = phoneRaw.replace(/^\+/, "").replace(/\D/g, "");
      if (phone.length < 10) return res.status(400).json({ error: "invalid phone" });
      // Sender resolution: explicit > sticky map > pool[0]
      let sender: string = String(body.sender || "").trim();
      if (!sender) {
        try {
          const ops = await import("./_utils/ops_collections");
          sender = (await ops.getSenderForPhone(phone)) || "";
        } catch {}
      }
      if (!sender) sender = "917793952828"; // pool[0] fallback
      const { sendDocumentTool } = await import("./_utils/doc_send_tool");
      const result = await sendDocumentTool({
        request: {
          project,
          doc_type: docType,
          size_label: body.size_label || null,
          tower: body.tower || null,
          facing: body.facing || null,
          unit_size_sft: body.unit_size_sft ?? null,
          send_all_variants: !!body.send_all,
        },
        phone,
        sender,
      });
      return res.status(200).json({ ok: true, sender_used: sender, ...result });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── audit-project-docs — admin sanity check on project_documents coverage.
  //
  //   Returns per-project a doc_type matrix:
  //     for each project, how many rows of each doc_type exist + whether
  //     multi-slot rows have size_label / tower / unit_size_sft populated.
  //   Used after a "send all 4 towers" test fails: did Spectra actually
  //   have 4 floor_plan rows uploaded with size_label set?
  //
  //   GET /api/chat-history?action=audit-project-docs&project=Spectra
  //   GET /api/chat-history?action=audit-project-docs    (all projects)
  if (req.method === "GET" && req.query.action === "audit-project-docs") {
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    if (!session && (!expectedSecret || incomingSecret !== expectedSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const { getCollection, COL } = await import("./_utils/mongo");
      const col = await getCollection(COL.PROJECT_DOCUMENTS);
      const projectFilter = (req.query.project as string || "").trim();
      const query: any = {};
      if (projectFilter) {
        query.project = { $regex: new RegExp(`^${projectFilter}$`, "i") };
      }
      const rows = await col.find(query).limit(500).toArray();
      type ByProject = {
        project: string;
        total: number;
        by_doc_type: Record<string, {
          count: number;
          rows: Array<{ size_label: string; tower: string; facing: string; unit_size_sft: number | null; has_url: boolean; filename: string }>;
        }>;
        coverage: { multi_slot_with_label: number; multi_slot_missing_label: number; single_slot_count: number };
      };
      const byProject = new Map<string, ByProject>();
      const MULTI_SLOT_TYPES = new Set(["unit_plan", "floor_plan", "price_sheet"]);
      for (const r of rows as any[]) {
        const proj = String(r.project || "(none)");
        if (!byProject.has(proj)) {
          byProject.set(proj, {
            project: proj, total: 0, by_doc_type: {},
            coverage: { multi_slot_with_label: 0, multi_slot_missing_label: 0, single_slot_count: 0 },
          });
        }
        const entry = byProject.get(proj)!;
        entry.total++;
        const dt = String(r.doc_type || "(unknown)");
        if (!entry.by_doc_type[dt]) entry.by_doc_type[dt] = { count: 0, rows: [] };
        entry.by_doc_type[dt].count++;
        entry.by_doc_type[dt].rows.push({
          size_label: String(r.size_label || ""),
          tower: String(r.tower || ""),
          facing: String(r.facing || ""),
          unit_size_sft: r.unit_size_sft ?? null,
          has_url: !!r.url,
          filename: String(r.filename || ""),
        });
        if (MULTI_SLOT_TYPES.has(dt)) {
          const hasMeta = !!r.size_label || !!r.tower || !!r.unit_size_sft;
          if (hasMeta) entry.coverage.multi_slot_with_label++;
          else entry.coverage.multi_slot_missing_label++;
        } else {
          entry.coverage.single_slot_count++;
        }
      }
      const projects = Array.from(byProject.values()).sort((a, b) =>
        a.project.localeCompare(b.project),
      );
      return res.status(200).json({
        ok: true,
        scanned_rows: rows.length,
        projects,
        suggested_actions: projects
          .filter((p) => p.coverage.multi_slot_missing_label > 0)
          .map((p) => `${p.project}: ${p.coverage.multi_slot_missing_label} multi-slot row(s) missing size_label / tower / unit_size_sft. Bot's "send all variants" will work but each row will be untaggable in the inline list.`),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Reset prompt: DELETE the DB override so reads fall back to the
  //     hardcoded ANANDITA_SYSTEM_PROMPT (which contains ABSOLUTE RULES inline).
  if (req.method === "POST" && req.query.action === "reset-prompt") {
    try {
      const { getCollection, COL } = await import("./_utils/mongo");
      const col = await getCollection(COL.BOT_SETTINGS);
      await col.deleteOne({ _id: "system_prompt" as any });
      res.setHeader("Location", `?view=edit-prompt&msg=${encodeURIComponent("Reset complete — bot is now using the hardcoded default (includes latest ABSOLUTE RULES).")}`);
    } catch (err: any) {
      res.setHeader("Location", `?view=edit-prompt&msg=${encodeURIComponent("Reset failed: " + err.message)}`);
    }
    return res.status(303).end();
  }

  // ─── Sync: overwrite the DB prompt with the current hardcoded version.
  //     Use case: user has a customized prompt saved in DB but wants the
  //     latest ABSOLUTE RULES applied without losing their workspace. They
  //     can hit this to "factory reset to the latest code" then re-edit on
  //     top of the fresh base.
  if ((req.method === "POST" || req.method === "GET") && req.query.action === "sync-prompt-to-hardcoded") {
    const session = (req as any)._session;
    const incomingSecret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const expectedSecret = process.env.INHOUSE_POSTHOOK_SECRET || "";
    const authedBySecret = !!expectedSecret && incomingSecret === expectedSecret;
    if (!session && !authedBySecret) {
      return res.status(401).json({ error: "Unauthorized — log in OR pass ?secret=<INHOUSE_POSTHOOK_SECRET>" });
    }
    try {
      const { ANANDITA_SYSTEM_PROMPT, PROMPT_VERSION } = await import("./_utils/gemini_chat");
      const { setBotSetting } = await import("./_utils/bot_settings");
      const result = await setBotSetting("system_prompt", ANANDITA_SYSTEM_PROMPT);
      await setBotSetting("system_prompt_version", PROMPT_VERSION);
      return res.status(200).json({
        ok: result.ok,
        error: result.error,
        synced_length_chars: ANANDITA_SYSTEM_PROMPT.length,
        message: result.ok
          ? "Hardcoded ANANDITA_SYSTEM_PROMPT (with latest ABSOLUTE RULES) is now the saved DB prompt. Bot will load this on its next message. Dashboard editor will show this as the live prompt — edit + save to customize from here."
          : "Sync failed",
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Per-phone bot kill-switch (toggle from dashboard) ────────────────
  // POST /api/chat-history?action=toggle-bot&phone=<digits>&enabled=0|1
  // Flips user_profiles.bot_enabled. When false, the WhatsApp webhook
  // logs inbound messages but skips Gemini + Periskope reply for that phone.
  // ─── Mark leads as SPAM (bulk-capable) ─────────────────────────────────
  // Triggered from a Zoho custom button (Deluge function) on the Leads
  // module's list view. Sales multi-selects gali/galoz contacts, clicks
  // "Mark as Spam", and Deluge calls this endpoint with all their lead IDs.
  //
  // POST /api/chat-history?action=mark-spam&secret=<INHOUSE_POSTHOOK_SECRET>
  // Body: { lead_ids: ["1288576...","1288576..."] }
  //   OR  ?lead_ids=id1,id2,id3 in the query string (Deluge convenience)
  //
  // Per lead:
  //   1. Zoho: Lead_Status="Spam", PRD_Stage="Spam", PRD_Status=null
  //   2. Mongo user_profiles.bot_enabled = false → WhatsApp webhook stays silent
  //   3. PRD cron skips PRD_Stage="Spam" — no follow-ups, no SS calls, ever
  //   4. Audit log entry per lead
  if (req.query.action === "mark-spam" && (req.method === "POST" || req.method === "GET")) {
    const secret = (req.query.secret as string) || (req.headers["x-debug-secret"] as string) || "";
    const sess = (req as any)._session;
    const expected = process.env.INHOUSE_POSTHOOK_SECRET || "";
    // Allow EITHER an admin-session OR the shared secret (so Deluge can call without a user session)
    const okAuth = (sess?.role === "admin") || (expected && secret === expected);
    if (!okAuth) {
      return res.status(401).json({ error: "Unauthorized — admin login or ?secret=<INHOUSE_POSTHOOK_SECRET> required" });
    }
    try {
      const body = (req.body || {}) as any;
      let ids: string[] = [];
      if (Array.isArray(body.lead_ids)) ids = body.lead_ids.map((x: any) => String(x).trim()).filter(Boolean);
      else if (typeof body.lead_ids === "string") ids = body.lead_ids.split(",").map((s: string) => s.trim()).filter(Boolean);
      else if (req.query.lead_ids) ids = String(req.query.lead_ids).split(",").map((s) => s.trim()).filter(Boolean);
      else if (req.query.lead_id) ids = [String(req.query.lead_id)];
      if (!ids.length) {
        return res.status(400).json({ error: "lead_ids required — pass as JSON body {lead_ids:[...]} or ?lead_ids=id1,id2" });
      }

      const { getAccessToken } = await import("./_utils/zoho");
      const { setBotEnabled } = await import("./_utils/user_profile");
      const { logAudit, clientIp } = await import("./_utils/audit");
      const token = await getAccessToken();
      const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";
      const actor = sess?.email || "deluge-button";

      const results: any[] = [];
      for (const id of ids) {
        try {
          // 1. Pull lead so we have the phone for the Mongo bot toggle
          const getR = await fetch(`${ZOHO_API_BASE}/Leads/${id}?fields=id,Mobile,Phone,First_Name,Last_Name,Lead_Status,PRD_Stage`, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
          });
          if (!getR.ok) {
            results.push({ id, ok: false, error: `Zoho GET ${getR.status}` });
            continue;
          }
          const j = await getR.json() as any;
          const lead = j?.data?.[0];
          if (!lead) {
            results.push({ id, ok: false, error: "lead not found" });
            continue;
          }
          const phone = String(lead.Mobile || lead.Phone || "").replace(/\D/g, "");
          const before = { Lead_Status: lead.Lead_Status, PRD_Stage: lead.PRD_Stage };

          // 2a. Try Blueprint transition for Lead_Status. Zoho enforces
          //     RECORD_IN_BLUEPRINT — direct PATCH on Lead_Status returns
          //     400 unless the field isn't in a blueprint. We attempt the
          //     transition by common names — user must have added at least
          //     one of these as a blueprint transition.
          let blueprintApplied = false;
          let blueprintErrorDetail: any = null;
          const SPAM_TRANSITIONS = ["Spam", "Mark as Spam", "Move to Spam", "Spam Lead"];
          for (const txName of SPAM_TRANSITIONS) {
            try {
              const bpListR = await fetch(`${ZOHO_API_BASE}/Leads/${id}/actions/blueprint`, {
                headers: { Authorization: `Zoho-oauthtoken ${token}` },
              });
              const bpListJ = await bpListR.json() as any;
              const transitions: any[] = bpListJ?.blueprint?.[0]?.transitions || bpListJ?.blueprint?.transitions || [];
              const match = transitions.find((t: any) =>
                String(t.name || "").toLowerCase() === txName.toLowerCase()
              );
              if (!match) continue;
              const fireR = await fetch(`${ZOHO_API_BASE}/Leads/${id}/actions/blueprint`, {
                method: "PUT",
                headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ blueprint: [{ transition_id: match.id, data: {} }] }),
              });
              if (fireR.ok) {
                blueprintApplied = true;
                break;
              } else {
                blueprintErrorDetail = { transition: txName, status: fireR.status, body: (await fireR.text()).slice(0, 200) };
              }
            } catch (err: any) {
              blueprintErrorDetail = { transition: txName, error: err.message };
            }
          }

          // 2b. PATCH the non-blueprint PRD_* fields directly — these are
          //     custom fields, NOT in the blueprint, so the PATCH succeeds.
          //     PRD_Stage="Spam" is what the cron actually skips on, so this
          //     alone stops all follow-ups + SS calls even if Lead_Status
          //     blueprint transition couldn't apply.
          const patchR = await fetch(`${ZOHO_API_BASE}/Leads`, {
            method: "PATCH",
            headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              data: [{
                id,
                PRD_Stage: "Spam",
                PRD_Status: null,
                PRD_Last_Action_Time: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
                PRD_Last_Action: "Marked as Spam",
              }],
            }),
          });
          let zohoPatched = false;
          let zohoErrorDetail: any = null;
          try {
            const pj = await patchR.json() as any;
            const row = pj?.data?.[0];
            if (patchR.ok && row?.code === "SUCCESS") {
              zohoPatched = true;
            } else {
              zohoErrorDetail = {
                http: patchR.status,
                code: row?.code || "(no code)",
                message: row?.message || pj?.message || "(no message)",
                details: row?.details || pj?.details || null,
                raw: JSON.stringify(pj).slice(0, 500),
              };
              console.error(`[mark-spam] Zoho PRD PATCH failed for ${id}:`, zohoErrorDetail);
            }
          } catch (err: any) {
            zohoErrorDetail = { parse_error: err.message, http: patchR.status };
          }

          // 3. Mongo — silence the bot for this phone (so even mid-conversation
          //    inbound messages get NO Gemini reply).
          let botDisabled = false;
          if (phone) {
            try {
              await setBotEnabled(phone, false);
              botDisabled = true;
            } catch (err: any) {
              console.error(`[mark-spam] setBotEnabled(${phone}) failed: ${err.message}`);
            }
          }

          // 4. Audit log
          await logAudit({
            actor_email: actor,
            action: "mark-spam",
            target: `lead/${id}`,
            summary: `${actor} marked ${lead.First_Name || ""} ${lead.Last_Name || ""} (${phone || "no-phone"}) as Spam`,
            details: { before, after: { Lead_Status: "Spam", PRD_Stage: "Spam" }, phone, bot_disabled: botDisabled, zoho_patched: zohoPatched },
            ip: clientIp(req),
          });

          results.push({
            id, phone, name: `${lead.First_Name || ""} ${lead.Last_Name || ""}`.trim(),
            prd_stage_set: zohoPatched,                  // PRD_Stage = "Spam" worked
            lead_status_set: blueprintApplied,            // Lead_Status moved via blueprint
            bot_disabled: botDisabled,                    // Mongo bot off
            ok: zohoPatched,                              // primary success = PRD_Stage set (cron skip key)
            zoho_prd_error: zohoErrorDetail,
            blueprint_error: blueprintApplied ? null : (blueprintErrorDetail || "no matching transition found (add 'Spam' transition in Zoho Blueprint)"),
          });
        } catch (err: any) {
          results.push({ id, ok: false, error: err.message });
        }
      }

      const ok = results.filter((r) => r.ok).length;
      return res.status(200).json({
        success: true, requested: ids.length, marked: ok, failed: ids.length - ok, results,
      });
    } catch (err: any) {
      console.error(`[mark-spam] failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST" && req.query.action === "toggle-bot") {
    const phone = String(req.query.phone || "").replace(/\D/g, "");
    const enabledParam = String(req.query.enabled ?? "1");
    const enabled = enabledParam === "1" || enabledParam.toLowerCase() === "true";
    if (!phone || phone.length < 10) {
      return res.status(400).json({ error: "valid phone (digits) required" });
    }
    try {
      const { setBotEnabled } = await import("./_utils/user_profile");
      const newState = await setBotEnabled(phone, enabled);
      const { logAudit, clientIp } = await import("./_utils/audit");
      const sess = (req as any)._session;
      await logAudit({
        actor_email: sess?.email || "(unknown)",
        action: "toggle-bot",
        target: `phone/${phone}`,
        summary: `${sess?.email || "?"} turned bot ${newState ? "ON" : "OFF"} for ${phone}`,
        ip: clientIp(req),
      });
      // Form post from dashboard → redirect back. JSON callers see the JSON
      // body when they pass Accept: application/json.
      const wantsJson = String(req.headers.accept || "").includes("application/json");
      if (wantsJson) {
        return res.status(200).json({ ok: true, phone, bot_enabled: newState });
      }
      res.setHeader("Location", `?view=dashboard#bot-override`);
      return res.status(303).end();
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── Delete a document row by id ────────────────────────────────────────
  if (req.method === "POST" && req.query.action === "delete-doc") {
    const id = String(req.query.id || "");
    if (!id) return res.status(400).json({ error: "id required" });
    try {
      // Capture the doc BEFORE deletion so the audit log records what was erased
      let snapshot: any = null;
      try {
        const { listAllDocs } = await import("./_utils/project_documents");
        const all = await listAllDocs({ limit: 500 });
        snapshot = all.find((d: any) => String(d._id) === id) || null;
      } catch {}

      await deleteDoc(id);

      const { logAudit, clientIp } = await import("./_utils/audit");
      const sess = (req as any)._session;
      await logAudit({
        actor_email: sess?.email || "(unknown)",
        action: "delete-doc",
        target: `project_documents/${id}`,
        summary: snapshot
          ? `Deleted ${snapshot.project} ${snapshot.doc_type} "${snapshot.size_label || snapshot.filename || id}"`
          : `Deleted document ${id}`,
        details: snapshot ? {
          project: snapshot.project, doc_type: snapshot.doc_type,
          size_label: snapshot.size_label, filename: snapshot.filename, url: snapshot.url,
        } : null,
        ip: clientIp(req),
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

    // source=supabase (legacy name kept for URL compat) OR source=mongo
    //   → fetch from Mongo whatsapp_messages collection (Phase 4 migration)
    if (req.query.source === "supabase" || req.query.source === "mongo") {
      const rawPhone = phone.replace(/\D/g, "");
      if (rawPhone.length < 10) return res.status(400).json({ error: "invalid phone" });
      try {
        const { getMessagesForPhone } = await import("./_utils/whatsapp_messages");
        const messages = await getMessagesForPhone(rawPhone, { limit: 200 });
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
