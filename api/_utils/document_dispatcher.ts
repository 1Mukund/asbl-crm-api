/**
 * Document dispatcher — looks up a project's brochure/price sheet/payment
 * structure document and sends it via Periskope when the customer's intent
 * matches.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const PERISKOPE_API_KEY = process.env.PERISKOPE_API_KEY || "";

// Intent → doc_type mapping
const INTENT_TO_DOC: Record<string, string> = {
  brochure: "brochure",
  price: "price_sheet",
  // payment_structure currently has no dedicated intent; brochure or price covers it
};

export interface ProjectDoc {
  url: string;
  doc_type: string;
  filename: string | null;
}

// ── Look up the most recently fetched matching document ───────────────────
export async function getDocumentFor(project: string, intent: string): Promise<ProjectDoc | null> {
  const docType = INTENT_TO_DOC[intent];
  if (!docType) return null;

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/project_documents` +
        `?project=eq.${project}` +
        `&doc_type=eq.${docType}` +
        `&order=fetched_at.desc&limit=1&select=url,doc_type,filename`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    return rows?.[0] || null;
  } catch (err: any) {
    console.error(`[DocDispatcher] lookup failed: ${err.message}`);
    return null;
  }
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
