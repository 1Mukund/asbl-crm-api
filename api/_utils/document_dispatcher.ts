/**
 * Document dispatcher — looks up a project's brochure / price sheet /
 * payment structure / specifications / floor plan document and sends it
 * via Periskope when the customer's DOCUMENT_REQUEST intent matches.
 *
 * Lookup chain:
 *   1. project_documents table (manual override, if curated)
 *   2. KB text (project_facts.facts_text) — auto-extracted via regex
 *
 * The KB-extraction route means whoever maintains a project's KB only
 * needs to keep the URLs in the KB itself — no separate table to update.
 */
import { getProjectFacts } from "./project_facts";
import { findDocInKB } from "./kb_doc_extractor";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const PERISKOPE_API_KEY = process.env.PERISKOPE_API_KEY || "";

// Intent → doc_type mapping (legacy webhook intents — Gemini classifier
// uses DOCUMENT_REQUEST and we map directly via doc_type passed in).
const LEGACY_INTENT_TO_DOC: Record<string, string> = {
  brochure: "brochure",
  price: "price_sheet",
};

export interface ProjectDoc {
  url: string;
  doc_type: string;
  filename: string | null;
  size_label?: string | null;
  unit_size_sft?: number | null;
  facing?: string | null;
  tower?: string | null;
  /** "table" | "kb" | "strict" — which source resolved this URL (for logs) */
  source?: string;
}

/** Result of a strict-equality lookup. Discriminated union so callers don't
 *  have to special-case null-vs-found inside a try/catch. */
export type StrictDocResult =
  | { ok: true; doc: ProjectDoc }
  | { ok: false; reason: "NOT_FOUND" | "AMBIGUOUS" | "ERROR"; details?: string; candidates?: ProjectDoc[] };

/** Normalise a size label for fuzzy matching: lowercase, strip non-alphanumeric. */
function normSize(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Doc types where the same doc_type can have MULTIPLE rows in
// project_documents, each disambiguated by size_label.
//   - floor_plan  → per-tower (Tower A, Tower B, ...)
//   - unit_plan   → per-unit-size (1695 East, 1870 West, ...)
//   - price_sheet → per-config / per-tower price sheets
const MULTI_SLOT_DOC_TYPES = new Set(["unit_plan", "floor_plan", "price_sheet"]);

export function isMultiSlotDocType(docType: string): boolean {
  return MULTI_SLOT_DOC_TYPES.has(docType);
}

/** List the available size_labels for a multi-slot doc type (for asking
 *  the customer "which tower / which size?" when the request is ambiguous). */
export async function listAvailableLabels(
  project: string,
  docType: string,
): Promise<string[]> {
  if (!MULTI_SLOT_DOC_TYPES.has(docType)) return [];
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/project_documents` +
        `?project=eq.${project}` +
        `&doc_type=eq.${docType}` +
        `&select=size_label&size_label=not.is.null&order=size_label.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = (await r.json()) as Array<{ size_label: string | null }>;
    if (!Array.isArray(rows)) return [];
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const row of rows) {
      if (row?.size_label && !seen.has(row.size_label)) {
        seen.add(row.size_label);
        labels.push(row.size_label);
      }
    }
    return labels;
  } catch {
    return [];
  }
}

// ── Strict-equality lookup using the bot's doc_meta ────────────────────────
// v5 behaviour: the LLM emits an explicit { unit_size_sft, facing, tower }
// alongside the doc slug. We match those fields EXACTLY against
// project_documents — NO fuzzy match, NO nearest-neighbour fallback. If no
// row matches, we surface NOT_FOUND and the caller falls back to a safe
// "let me confirm" message. If multiple match, AMBIGUOUS so the caller can
// ask the customer to disambiguate.
//
// Why so strict: the prior fuzzy match was sending the wrong-sized PDF (e.g.
// asked for 1870, sent 1695) because size_label was free-text. The v5 schema
// stores int + canonical enums so equality is safe.
export interface StrictDocLookupInput {
  project: string;
  docType: string;
  unit_size_sft?: number | null;
  facing?: string | null;
  tower?: string | null;
}

export async function getDocumentStrict(
  input: StrictDocLookupInput,
): Promise<StrictDocResult> {
  const { project, docType } = input;
  if (!project || !docType) {
    return { ok: false, reason: "ERROR", details: "missing project or docType" };
  }

  // Build PostgREST query with eq filters only on fields the bot supplied.
  // For multi-slot doc types, ALL of unit_size_sft/facing/tower that the bot
  // populated must match exactly. For single-slot (brochure, master_plan,
  // etc.) the bot will leave all three null and we just match (project, doc_type).
  const params: string[] = [
    `project=eq.${encodeURIComponent(project)}`,
    `doc_type=eq.${encodeURIComponent(docType)}`,
    `select=url,doc_type,filename,size_label,unit_size_sft,facing,tower`,
    `order=fetched_at.desc`,
    `limit=20`,
  ];
  if (input.unit_size_sft !== null && input.unit_size_sft !== undefined) {
    params.push(`unit_size_sft=eq.${input.unit_size_sft}`);
  }
  if (input.facing) {
    const f = String(input.facing).toLowerCase().replace(/[^a-z_]/g, "");
    if (f) params.push(`facing=eq.${encodeURIComponent(f)}`);
  }
  if (input.tower) {
    params.push(`tower=eq.${encodeURIComponent(String(input.tower))}`);
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/project_documents?${params.join("&")}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, reason: "ERROR", details: `${r.status}: ${t.slice(0, 200)}` };
    }
    const rows = (await r.json()) as ProjectDoc[];
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, reason: "NOT_FOUND" };
    }
    if (rows.length === 1) {
      return { ok: true, doc: { ...rows[0], source: "strict" } };
    }
    // Multiple matches with the bot's full meta supplied → genuine ambiguity.
    return {
      ok: false,
      reason: "AMBIGUOUS",
      details: `${rows.length} rows matched (project,doc_type,unit_size_sft,facing,tower)`,
      candidates: rows.map((r) => ({ ...r, source: "strict" })),
    };
  } catch (err: any) {
    return { ok: false, reason: "ERROR", details: err.message };
  }
}

/** List the available labels for the customer when strict lookup says
 *  NOT_FOUND. Returns "1695 East-Tower A, 1870 West-Tower B, ..." style
 *  strings the caller can include in a clarification message. */
export async function listAvailableMetaLabels(
  project: string,
  docType: string,
): Promise<string[]> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/project_documents` +
        `?project=eq.${encodeURIComponent(project)}` +
        `&doc_type=eq.${encodeURIComponent(docType)}` +
        `&select=unit_size_sft,facing,tower,size_label` +
        `&order=unit_size_sft.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{
      unit_size_sft: number | null;
      facing: string | null;
      tower: string | null;
      size_label: string | null;
    }>;
    if (!Array.isArray(rows)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of rows) {
      const parts: string[] = [];
      if (row.unit_size_sft) parts.push(`${row.unit_size_sft} sft`);
      if (row.facing) parts.push(String(row.facing));
      if (row.tower) parts.push(`Tower ${row.tower}`);
      const label = parts.length ? parts.join(" ") : (row.size_label || "");
      if (label && !seen.has(label.toLowerCase())) {
        seen.add(label.toLowerCase());
        out.push(label);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── Look up the matching document — table first, then KB extraction ──────
// Optional sizeHint helps unit_plan lookups (e.g. "1695 east", "2bhk", "1295").
//
// NOTE: this is the LEGACY fuzzy-match path. v5 callers should prefer
// getDocumentStrict() with the LLM's doc_meta. This function is preserved
// for (a) the dashboard's listAvailableLabels helper, (b) single-slot doc
// types where there's only one row per (project, doc_type) so fuzz is moot,
// and (c) fallback when an old upload doesn't have the new strict columns
// populated yet.
export async function getDocumentFor(
  project: string,
  intentOrDocType: string,
  sizeHint?: string | null
): Promise<ProjectDoc | null> {
  // Accept either a legacy intent ("brochure") or a doc_type slug ("brochure" / "price_sheet" / etc.)
  const docType = LEGACY_INTENT_TO_DOC[intentOrDocType] || intentOrDocType;
  if (!docType) return null;

  // 1. Try the curated project_documents table first
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/project_documents` +
        `?project=eq.${project}` +
        `&doc_type=eq.${docType}` +
        `&order=fetched_at.desc&limit=20&select=url,doc_type,filename,size_label`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = (await r.json()) as ProjectDoc[];

    if (rows?.length) {
      // For multi-slot doc types (unit_plan / floor_plan / price_sheet),
      // try to match size_label fuzzily using the customer's message
      // as a hint. Single-slot types just return the most recent row.
      const isMulti = isMultiSlotDocType(docType);
      if (isMulti) {
        const hint = normSize(sizeHint);
        if (hint) {
          const matched = rows.find((row) => {
            const lbl = normSize(row.size_label);
            return lbl && (lbl.includes(hint) || hint.includes(lbl));
          });
          if (matched) return { ...matched, source: "table" };
        }
        // No hint or no match → fall back to the most recently uploaded one
        return { ...rows[0], source: "table" };
      }
      return { ...rows[0], source: "table" };
    }
  } catch (err: any) {
    console.error(`[DocDispatcher] table lookup failed: ${err.message}`);
  }

  // 2. Fallback: extract from the KB text
  try {
    const facts = await getProjectFacts(project);
    if (facts?.facts_text) {
      const kbDoc = findDocInKB(facts.facts_text, docType);
      if (kbDoc) {
        return {
          url: kbDoc.url,
          doc_type: kbDoc.docType,
          filename: kbDoc.filename,
          source: "kb",
        };
      }
    }
  } catch (err: any) {
    console.error(`[DocDispatcher] KB extraction failed: ${err.message}`);
  }

  return null;
}

// ── Send document via Periskope ────────────────────────────────────────────
// Per Periskope docs: POST /v1/message/send with nested `media` object and
// chat_id in `<phone>@c.us` form. We try the documented endpoint first; if
// it 404s (some accounts may still be on the older /messages/send path), we
// fall back to that. Errors propagate to the caller, where they're logged.
export async function sendDocViaPeriskope(
  phone: string,
  sender: string,
  docUrl: string,
  filename: string | null,
  caption: string,
  mimeType: string = "application/pdf"
): Promise<void> {
  const cleanPhone = String(phone).replace(/\D/g, "");
  const chatId = cleanPhone.includes("@") ? cleanPhone : `${cleanPhone}@c.us`;
  const safeFilename = filename || "document.pdf";

  const body = {
    chat_id: chatId,
    message: caption,
    media: {
      type: "document",
      filename: safeFilename,
      mimetype: mimeType,
      url: docUrl,
    },
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${PERISKOPE_API_KEY}`,
    "x-phone": sender,
  };

  const endpoints = [
    "https://api.periskope.app/v1/message/send",   // documented
    "https://api.periskope.app/v1/messages/send",  // legacy / plural alias
  ];

  let lastErr = "";
  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (r.ok) {
        console.log(`[DocDispatcher] sent doc via ${url} → ${docUrl}`);
        return;
      }
      const t = await r.text();
      lastErr = `${r.status} from ${url}: ${t.slice(0, 300)}`;
      // Only fall through to next endpoint on 404 (path mismatch)
      if (r.status !== 404) {
        throw new Error(`Periskope doc send error ${lastErr}`);
      }
      console.warn(`[DocDispatcher] ${url} returned 404, trying fallback`);
    } catch (err: any) {
      // Re-throw the last attempt's error so the caller can log it
      if (url === endpoints[endpoints.length - 1]) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      lastErr = err?.message || String(err);
    }
  }
  throw new Error(`Periskope doc send failed: ${lastErr}`);
}
