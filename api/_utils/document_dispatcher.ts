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
  /** "table" | "kb" — which source resolved this URL (for logs) */
  source?: string;
}

/** Normalise a size label for fuzzy matching: lowercase, strip non-alphanumeric. */
function normSize(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ── Look up the matching document — table first, then KB extraction ──────
// Optional sizeHint helps unit_plan lookups (e.g. "1695 east", "2bhk", "1295").
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
      // For multi-slot doc types (unit_plan / floor_plan), try to match
      // size_label fuzzily using the customer's message as a hint.
      const isMulti = docType === "unit_plan" || docType === "floor_plan";
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
