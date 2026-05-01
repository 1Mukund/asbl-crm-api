import type { VercelRequest, VercelResponse } from "@vercel/node";
import { listAllProjectFacts, getProjectFacts, saveProjectFacts, saveProjectKb, KNOWN_PROJECTS } from "./_utils/project_facts";
import { getAllInventoryRows, refreshInventoryCache, INVENTORY_SHEET_URL, InventoryRow } from "./_utils/inventory_sheet";
import { uploadToStorage, extractTextFromPDF, decodeBase64Text, decodeBase64Buffer } from "./_utils/storage_upload";

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
    { key: "floor_plan", label: "Floor Plan" },
    { key: "price_sheet", label: "Price Sheet" },
    { key: "payment_structure", label: "Payment Structure" },
    { key: "brochure", label: "Brochure" },
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

  const renderUnitPlans = (project: string) => {
    const plans = docsByProj[project]?.unit_plan || [];
    const list = plans.map((p) => `<tr>
      <td>${esc(p.size_label || "—")}</td>
      <td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.filename || "open")}</a></td>
      <td>
        <form method="POST" action="?action=delete-doc&id=${esc(p.id)}" style="display:inline" onsubmit="return confirm('Delete unit plan ${esc(p.size_label)} for ${esc(project)}?')">
          <button type="submit" class="btn-delete">delete</button>
        </form>
      </td>
    </tr>`).join("");

    return `<div class="unit-plans">
      <div class="doc-slot-label">Unit Plans <span class="${plans.length ? "ok" : "missing"}">${plans.length ? "●" : "○"}</span> <span style="color:#888;font-weight:normal">(${plans.length})</span></div>
      ${plans.length ? `<table class="unit-table">
        <tr><th>Size label</th><th>File</th><th></th></tr>
        ${list}
      </table>` : `<div class="empty-inline">no unit plans uploaded yet</div>`}
      <div class="add-unit-row">
        <input type="text" id="size-${esc(project)}" placeholder="size label e.g. 1695 East" class="size-input" />
        <button type="button" class="btn-upload" onclick="pickUnitPlan('${esc(project)}')">+ Add unit plan PDF</button>
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
      ${renderUnitPlans(p)}
    </div>`)
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
.doc-library { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; margin-top: 8px; }
.proj-card { border: 1px solid #e5e5ea; border-radius: 10px; padding: 14px 16px; background: #fcfcfd; }
.proj-card h3 { margin: 0 0 10px; font-size: 15px; font-weight: 600; color: #1d1d1f; }
.kb-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; background: white; border: 1px solid #e5e5ea; border-radius: 6px; font-size: 12.5px; margin-bottom: 12px; }
.doc-slots { display: grid; grid-template-columns: 1fr; gap: 6px; margin-bottom: 12px; }
.doc-slot { display: grid; grid-template-columns: 130px 1fr auto; align-items: center; gap: 8px; padding: 6px 10px; background: white; border: 1px solid #e5e5ea; border-radius: 6px; font-size: 12px; }
.doc-slot.empty-slot { background: #fffbf2; border-color: #ffe8b8; }
.doc-slot-label { font-weight: 500; color: #1d1d1f; }
.doc-slot-file { color: #444; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-slot-file em { color: #aaa; font-style: normal; }
.ok { color: #34c759; font-size: 13px; }
.missing { color: #ffa726; font-size: 13px; }
.btn-upload, .btn-upload-replace, .btn-upload-kb { background: #007aff; color: white; border: none; padding: 4px 10px; border-radius: 5px; font-size: 11.5px; cursor: pointer; font-weight: 500; }
.btn-upload-replace { background: #f0f0f3; color: #007aff; }
.btn-upload:hover, .btn-upload-kb:hover { background: #0066d6; }
.btn-upload-replace:hover { background: #e5e5ea; }
.btn-delete { background: transparent; color: #ff3b30; border: none; cursor: pointer; font-size: 14px; padding: 0 4px; line-height: 1; }
.btn-delete:hover { color: #c00; }
.unit-plans { background: white; border: 1px solid #e5e5ea; border-radius: 6px; padding: 10px 12px; }
.unit-table { width: 100%; font-size: 12px; margin: 8px 0; }
.unit-table th, .unit-table td { padding: 5px 6px; }
.add-unit-row { display: flex; gap: 8px; margin-top: 8px; }
.size-input { flex: 1; padding: 5px 9px; border: 1px solid #d1d1d6; border-radius: 5px; font-size: 12px; font-family: inherit; }
.empty-inline { color: #aaa; font-size: 12px; font-style: italic; padding: 4px 0; }
</style>
</head><body>
<h1>ASBL CRM Dashboard</h1>
<div class="sub">Last refresh: ${new Date().toLocaleString("en-IN")} · Auto-refresh every 30s</div>

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
        <button type="submit" style="background:#007aff;color:white;border:none;padding:4px 12px;border-radius:6px;font-size:12px;cursor:pointer">↻ Refresh now</button>
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
    <div class="proj-help">
      <strong>KB</strong> — TXT or PDF. Text is auto-extracted and fed into the bot's Gemini prompt as <code>PROJECT_CONTEXT</code>. Replace anytime; latest upload wins.<br>
      <strong>Master Plan / Floor Plan / Price Sheet / Payment Structure / Brochure</strong> — single PDF per project. The bot sends this file directly via Periskope when a customer asks (DOCUMENT_REQUEST intent).<br>
      <strong>Unit Plans</strong> — multiple PDFs, one per inventory size (e.g. <code>1695 East</code>). Bot matches by size label when customer asks for a specific unit's plan.<br>
      Files go to Supabase Storage bucket <code>project-files</code> (public, 50MB max).
    </div>
    <div class="doc-library">
      ${docLibraryHtml}
    </div>
  </div>

</div>

<!-- Hidden file inputs reused by the upload buttons -->
<input type="file" id="hidden-file-input" accept=".pdf,.txt,application/pdf,text/plain" style="display:none" />

<script>
// ── Upload helpers: read file → base64 → POST JSON ───────────────────────
const _fileInput = document.getElementById('hidden-file-input');
let _ctx = null; // { kind: 'kb'|'doc'|'unit', project, docType, sizeLabel, label }

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

function pickUnitPlan(project) {
  const sizeInput = document.getElementById('size-' + project);
  const sizeLabel = (sizeInput?.value || '').trim();
  if (!sizeLabel) {
    alert('Enter a size label first (e.g. "1695 East")');
    sizeInput?.focus();
    return;
  }
  _ctx = { kind: 'unit', project, docType: 'unit_plan', sizeLabel, label: 'Unit Plan ' + sizeLabel };
  _fileInput.accept = '.pdf,application/pdf';
  _fileInput.value = '';
  _fileInput.click();
}

_fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !_ctx) return;
  const ctx = _ctx;
  _ctx = null;

  if (file.size > 50 * 1024 * 1024) {
    alert('File too large (max 50 MB)');
    return;
  }

  // Read file as base64 (strip data: prefix)
  const base64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const idx = s.indexOf(',');
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });

  const action = ctx.kind === 'kb' ? 'upload-kb' : 'upload-doc';
  const payload = {
    project: ctx.project,
    filename: file.name,
    mimetype: file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/plain'),
    base64_content: base64,
  };
  if (ctx.kind !== 'kb') {
    payload.doc_type = ctx.docType;
    if (ctx.sizeLabel) payload.size_label = ctx.sizeLabel;
  }

  const btn = document.activeElement;
  const oldText = btn?.textContent;
  if (btn && btn.tagName === 'BUTTON') { btn.disabled = true; btn.textContent = 'Uploading…'; }

  try {
    const r = await fetch('?action=' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      alert('Upload failed: ' + (data.error || r.status));
      if (btn && btn.tagName === 'BUTTON') { btn.disabled = false; btn.textContent = oldText; }
      return;
    }
    if (ctx.kind === 'kb') {
      alert('KB uploaded: ' + data.extractedChars + ' chars extracted for ' + ctx.project);
    } else {
      alert(ctx.label + ' uploaded for ' + ctx.project);
    }
    location.reload();
  } catch (err) {
    alert('Upload error: ' + err.message);
    if (btn && btn.tagName === 'BUTTON') { btn.disabled = false; btn.textContent = oldText; }
  }
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
<h1>Edit Offer Details — ${esc(project)}</h1>
<div class="sub">
  <a href="?view=dashboard">← back to dashboard</a> · last updated: ${esc(updated)}
</div>

${message ? `<div class="flash ${message.startsWith("Saved") ? "flash-success" : "flash-error"}">${esc(message)}</div>` : ""}

<div class="card">
  <div class="help">
    Write the <strong>offer explanation</strong> for ${esc(project)} below — pricing offers, rental schemes,
    pre-EMI offers, limited-time deals, etc. The bot will use this when a customer asks about offers for this
    project. Static project KBs (overview, location, master plan) are uploaded separately to the Anandita
    agent — this is only for offer details.
  </div>
  <form method="POST" action="?action=save-facts">
    <input type="hidden" name="project" value="${esc(project)}" />
    <label for="facts_text">Offer details (size: ${(text.length / 1024).toFixed(1)} KB)</label>
    <textarea id="facts_text" name="facts_text" placeholder="# ${esc(project)} — OFFERS

## Active Offer
- Name: <e.g. Rental Offer>
- What it is: <plain-language explainer the bot can read out>
- Eligibility: <who qualifies>
- Booking amount: <e.g. ₹10L>
- Returns / discount: <e.g. ₹50/sqft/month till Dec 2026>
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
      <button type="submit">Save offer details</button>
      <a href="?view=dashboard" class="btn-secondary" style="text-decoration:none;padding:10px 22px;border-radius:8px;border:1px solid #d1d1d6;color:#1d1d1f;background:white">Cancel</a>
      <span class="meta">Saving will overwrite the current offer details for this project.</span>
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
      if (docType === "unit_plan" && !sizeLabel) {
        return res.status(400).json({ error: "size_label required for unit_plan (e.g. '1695 East')" });
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
