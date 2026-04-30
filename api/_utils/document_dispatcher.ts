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
  /** "table" | "kb" — which source resolved this URL (for logs) */
  source?: string;
}

// ── Look up the matching document — table first, then KB extraction ──────
export async function getDocumentFor(project: string, intentOrDocType: string): Promise<ProjectDoc | null> {
  // Accept either a legacy intent ("brochure") or a doc_type slug ("brochure" / "price_sheet" / etc.)
  const docType = LEGACY_INTENT_TO_DOC[intentOrDocType] || intentOrDocType;
  if (!docType) return null;

  // 1. Try the curated project_documents table first
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/project_documents` +
        `?project=eq.${project}` +
        `&doc_type=eq.${docType}` +
        `&order=fetched_at.desc&limit=1&select=url,doc_type,filename`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    if (rows?.[0]?.url) {
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
// Periskope's media-send contract may differ; this uses the canonical shape
// most BSPs follow. If Periskope rejects, log shows the exact response so we
// can adapt the body format.
export async function sendDocViaPeriskope(
  phone: string,
  sender: string,
  docUrl: string,
  filename: string | null,
  caption: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: phone,
    type: "document",
    media: docUrl,
    caption,
  };
  if (filename) body.filename = filename;

  const r = await fetch("https://api.periskope.app/v1/messages/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PERISKOPE_API_KEY}`,
      "x-phone": sender,
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Periskope doc send error ${r.status}: ${t}`);
  }
}
