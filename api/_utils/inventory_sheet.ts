/**
 * Live inventory + pricing from the master Google Sheet.
 *
 *   https://docs.google.com/spreadsheets/d/1qWHfCpIbf_q8gkxohP7vIapC3kq_vhy2NvirZfzRhpg
 *
 * The sheet is published as CSV; we fetch + parse on demand with a
 * 5-minute in-memory cache so a) the bot always sees a recent snapshot
 * and b) we don't hammer Google on every WhatsApp message.
 *
 * The bot consumes this as part of <PROJECT_CONTEXT>, alongside the
 * static KB the user uploads to the Anandita agent. So when somebody
 * edits the sheet, the bot's pricing/availability answers reflect the
 * change within ~5 minutes.
 */

const SHEET_ID = "1qWHfCpIbf_q8gkxohP7vIapC3kq_vhy2NvirZfzRhpg";
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

export interface InventoryRow {
  project: string;       // normalized: LOFT / SPECTRA / BROADWAY / LANDMARK / etc
  tower: string;
  sizeSft: string;
  bhk: string;
  facing: string;
  availability: string;
  planUrl: string;
  pricePerSft: string;
  allInclusive: string;
  offer: string;
}

let cache: { fetchedAt: number; rows: InventoryRow[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Parse CSV with quoted-field support ───────────────────────────────────
function parseCSV(csv: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"' && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        cur.push(field);
        field = "";
      } else if (c === "\n") {
        cur.push(field);
        field = "";
        rows.push(cur);
        cur = [];
      } else if (c === "\r") {
        // skip
      } else {
        field += c;
      }
    }
  }
  if (field !== "" || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  return rows;
}

function normalizeProject(name: string): string {
  return (name || "")
    .trim()
    .toUpperCase()
    .replace(/^ASBL\s+/i, "")
    .trim();
}

// ── Format raw rupee amount to "₹X.XX Cr" so the LLM doesn't mis-scale it.
// Inputs from the sheet: "21772465", "19400000", "8,599", "11,209.43" etc.
function formatRupees(raw: string): string {
  if (!raw) return "";
  const cleaned = raw.replace(/[,\s₹]/g, "");
  if (!cleaned || cleaned.toUpperCase() === "NA") return raw;
  const n = parseFloat(cleaned);
  if (!isFinite(n) || n <= 0) return raw;

  // Per-sqft rates (4-5 digit numbers) → keep as ₹X
  if (n < 100000) {
    return "₹" + Math.round(n).toLocaleString("en-IN");
  }
  // Lakh range
  if (n < 10000000) {
    return `₹${(n / 100000).toFixed(2)} Lakh`;
  }
  // Crore range — drop trailing zeros for cleaner output
  const cr = n / 10000000;
  return `₹${cr.toFixed(2)} Cr`;
}

// ── Fetch + parse + cache ─────────────────────────────────────────────────
async function fetchAllRows(force = false): Promise<InventoryRow[]> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.rows;
  }
  const r = await fetch(SHEET_CSV_URL);
  if (!r.ok) {
    throw new Error(`Sheet fetch failed: HTTP ${r.status}`);
  }
  const csv = await r.text();
  const parsed = parseCSV(csv);
  if (parsed.length < 2) {
    cache = { fetchedAt: Date.now(), rows: [] };
    return [];
  }

  // Header order (verified from sheet):
  //   Projects | Tower | Flat size in SFT | BHK | Facing | Availability
  //   Plan URL | Price per SFT | Directions | All Inclusive Price starting | Offer details
  const rows: InventoryRow[] = parsed
    .slice(1)
    .filter((cells) => cells.length >= 6 && (cells[0] || "").trim())
    .map((cells) => ({
      project: normalizeProject(cells[0]),
      tower: (cells[1] || "").trim(),
      sizeSft: (cells[2] || "").trim(),
      bhk: (cells[3] || "").trim(),
      facing: (cells[4] || "").trim(),
      availability: (cells[5] || "").trim(),
      planUrl: (cells[6] || "").trim(),
      pricePerSft: (cells[7] || "").trim(),
      allInclusive: (cells[9] || "").trim(),
      offer: (cells[10] || "").trim(),
    }));

  cache = { fetchedAt: Date.now(), rows };
  return rows;
}

// ── Public: format one project's inventory as readable markdown ──────────
export interface ProjectInventory {
  rows: InventoryRow[];
  fetchedAt: number;
  markdown: string;
}

export async function getInventoryForProject(project: string): Promise<ProjectInventory> {
  const all = await fetchAllRows();
  const matched = all.filter((r) => r.project === project);

  if (matched.length === 0) {
    return {
      rows: [],
      fetchedAt: cache?.fetchedAt || 0,
      markdown: "(no inventory rows for this project in the master sheet)",
    };
  }

  // Group by availability for the LLM's clarity
  const available = matched.filter((r) => /^available/i.test(r.availability));
  const limited = matched.filter((r) => /not selling/i.test(r.availability));
  const soldOut = matched.filter((r) => /sold\s*out/i.test(r.availability));
  const other = matched.filter(
    (r) =>
      !available.includes(r) &&
      !limited.includes(r) &&
      !soldOut.includes(r),
  );

  const lines: string[] = [];
  lines.push("(live snapshot from inventory sheet — updates auto-refresh every 5 min)");
  lines.push("");

  const renderRow = (r: InventoryRow): string => {
    const parts: string[] = [];
    parts.push(`Tower ${r.tower}`);
    parts.push(`${r.sizeSft} sft`);
    parts.push(r.bhk);
    parts.push(r.facing);
    if (r.allInclusive && r.allInclusive !== "NA") {
      parts.push(`All-inclusive: ${formatRupees(r.allInclusive)}`);
    }
    if (r.pricePerSft && r.pricePerSft !== "NA") {
      parts.push(`Per sft: ${formatRupees(r.pricePerSft)}`);
    }
    if (r.offer && r.offer !== "NA") parts.push(`Offer: ${r.offer}`);
    return "- " + parts.join(" | ");
  };

  if (available.length) {
    lines.push(`AVAILABLE (${available.length}):`);
    for (const r of available) lines.push(renderRow(r));
    lines.push("");
  }
  if (limited.length) {
    lines.push(`AVAILABLE BUT NOT SELLING / LIMITED (${limited.length}):`);
    for (const r of limited) lines.push(renderRow(r));
    lines.push("");
  }
  if (other.length) {
    lines.push(`OTHER STATUS (${other.length}):`);
    for (const r of other) {
      lines.push(`- Tower ${r.tower} | ${r.sizeSft} sft | ${r.bhk} | ${r.facing} | ${r.availability}`);
    }
    lines.push("");
  }
  if (soldOut.length) {
    lines.push(`SOLD OUT (${soldOut.length}):`);
    for (const r of soldOut) {
      lines.push(`- Tower ${r.tower} | ${r.sizeSft} sft | ${r.bhk} | ${r.facing}`);
    }
  }

  return {
    rows: matched,
    fetchedAt: cache?.fetchedAt || Date.now(),
    markdown: lines.join("\n").trim(),
  };
}

// ── Public: read everything (for dashboard) ────────────────────────────────
export async function getAllInventoryRows(): Promise<{ rows: InventoryRow[]; fetchedAt: number }> {
  const rows = await fetchAllRows();
  return { rows, fetchedAt: cache?.fetchedAt || Date.now() };
}

/**
 * Build a compact one-liner-per-project size index across ALL projects.
 * Used as a footer in single-project PROJECT_CONTEXT so Gemini can
 * cross-reference: "Sir, Loft doesn't have 2035 sft but Broadway does —
 * shall I send Broadway's plan?". Without this, Gemini only sees the
 * current project's catalog and refuses to mention sizes that exist
 * elsewhere — even though the customer's request might fit them.
 *
 * Output format:
 *   ASBL Loft: 1695 sft (3BHK East/West), 1870 sft (3BHK East/West)
 *   ASBL Broadway: 2035 sft (3BHK East/West), 2520 sft (3BHK East)
 *   ...
 *
 * Sold-out + on-hold rows are excluded so the LLM doesn't suggest
 * something that's actually unavailable.
 */
export async function getCrossProjectSizeIndex(): Promise<string> {
  const all = await fetchAllRows();
  if (!all.length) return "";

  // Group by project, then by size+bhk (collapsing East/West into one
  // line per size to keep it compact).
  const byProject = new Map<string, Map<string, Set<string>>>();

  for (const r of all) {
    const avail = (r.availability || "").toLowerCase();
    if (avail.includes("sold")) continue; // skip sold-out
    if (!r.sizeSft) continue;

    const proj = r.project;
    const key = `${r.sizeSft} sft ${r.bhk || ""}`.trim();
    const facing = r.facing || "";

    if (!byProject.has(proj)) byProject.set(proj, new Map());
    const projMap = byProject.get(proj)!;
    if (!projMap.has(key)) projMap.set(key, new Set());
    if (facing) projMap.get(key)!.add(facing);
  }

  if (!byProject.size) return "";

  const lines: string[] = [];
  for (const [proj, sizes] of byProject) {
    const parts: string[] = [];
    for (const [sizeKey, facings] of sizes) {
      const facingStr = facings.size ? ` (${[...facings].sort().join("/")})` : "";
      parts.push(`${sizeKey}${facingStr}`);
    }
    lines.push(`${proj}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

// ── Public: force-refresh (clears cache) ──────────────────────────────────
export async function refreshInventoryCache(): Promise<{ count: number; fetchedAt: number }> {
  cache = null;
  const rows = await fetchAllRows(true);
  const fetchedAt = (cache as { fetchedAt: number; rows: InventoryRow[] } | null)?.fetchedAt || Date.now();
  return { count: rows.length, fetchedAt };
}

// Sheet ID exported for dashboard to link back to the source
export const INVENTORY_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
