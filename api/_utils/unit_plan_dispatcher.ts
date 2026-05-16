/**
 * Unit-plan / floor-plan PDF dispatcher — uses Kimi K2 to pick the right
 * size_label out of a finite list, with a confidence score so we can ask
 * a clarifying question instead of sending the wrong PDF.
 *
 * Why not the existing fuzzy-includes() in document_dispatcher.ts?
 *   - "Send me the 3BHK" with 3 different 3BHK variants → falls back to
 *     "most recent upload", customer gets wrong PDF.
 *   - "1695 east-facing" — substring-match might pick "1695 west" because
 *     "1695" appears in both labels.
 *   - "Bhej do unit plan" with no size hint → silently sends the wrong one.
 *
 * Kimi reads each PDF's text_extract excerpt + size_label, plus the customer
 * message, and returns:
 *   {
 *     decision: "match" | "ambiguous" | "no_match",
 *     size_label: <string | null>,
 *     confidence: 0..1,
 *     reason: "<short>",
 *     ambiguous_options: [<size_label>, ...]   // when decision = "ambiguous"
 *   }
 *
 * Caller decides: ≥0.7 confidence → send PDF; otherwise → ask customer
 * which size they want with the ambiguous_options list.
 *
 * Best-effort: if Kimi is unavailable or errors, falls back to the legacy
 * substring-match in document_dispatcher.ts so the chatbot keeps working.
 */
import { callKimi, kimiAvailable } from "./kimi";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

export interface UnitPlanRow {
  url: string;
  filename: string | null;
  size_label: string | null;
  text_extract: string | null;
}

export interface UnitPlanDispatchResult {
  /** "match" — ready to send. "ambiguous" — ask customer to pick. "no_match" — no PDF in catalog matches. "fallback" — Kimi unavailable, caller should use legacy lookup. */
  decision: "match" | "ambiguous" | "no_match" | "fallback";
  /** The matched row when decision = "match". */
  row: UnitPlanRow | null;
  /** When decision = "ambiguous": the list to offer the customer. */
  options: string[];
  /** 0–1 from Kimi. Only meaningful on "match" / "ambiguous". */
  confidence: number;
  /** Short rationale from Kimi (for logs). */
  reason: string;
  /** Latency in ms (for logs). */
  ms: number;
}

/** Fetch all unit_plan / floor_plan rows for a project, including text_extract. */
async function fetchAvailableRows(
  project: string,
  docType: "unit_plan" | "floor_plan" | "price_sheet",
): Promise<UnitPlanRow[]> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/project_documents` +
      `?project=eq.${encodeURIComponent(project)}` +
      `&doc_type=eq.${docType}` +
      `&select=url,filename,size_label,text_extract` +
      `&order=fetched_at.desc&limit=30`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  if (!r.ok) return [];
  const rows = (await r.json()) as UnitPlanRow[];
  return Array.isArray(rows) ? rows : [];
}

/** Trim a text_extract to a manageable size for the Kimi prompt. We keep
 *  the head (usually has size/dimension labels) plus a tail snippet (catches
 *  RERA / approval IDs that often live at the bottom of unit plans). */
function squashExtract(txt: string | null, headChars = 800, tailChars = 200): string {
  if (!txt) return "";
  const t = txt.replace(/\s+/g, " ").trim();
  if (t.length <= headChars + tailChars + 20) return t;
  return `${t.slice(0, headChars)} … [${t.length - headChars - tailChars} chars omitted] … ${t.slice(-tailChars)}`;
}

/** Build the strict JSON-output prompt. */
function buildPrompt(message: string, project: string, docType: string, rows: UnitPlanRow[]): { system: string; user: string } {
  const system =
    "You are a real-estate document dispatcher. Your only job is to pick the " +
    "single correct PDF from a finite catalog based on the customer's message. " +
    "You MUST output STRICT JSON exactly matching the schema. " +
    "Never invent a size_label that's not in the catalog. " +
    "If you're not at least 70% sure, set decision='ambiguous' and list the " +
    "plausible options — DO NOT GUESS. " +
    "If nothing in the catalog matches at all, set decision='no_match'.";

  const docTypeLabel =
    docType === "unit_plan"   ? "Unit Plan (per-unit-size floor layouts)"   :
    docType === "floor_plan"  ? "Floor Plan (per-tower full-floor layouts)" :
    docType === "price_sheet" ? "Price Sheet (per-config / per-tower price breakdown)" :
    "Document";

  const catalog = rows
    .map((row, i) => {
      const sizeLbl = row.size_label || "(no size_label set)";
      const fname = row.filename || "(no filename)";
      const extract = squashExtract(row.text_extract);
      return (
        `--- Catalog entry #${i + 1} ---\n` +
        `size_label: ${sizeLbl}\n` +
        `filename: ${fname}\n` +
        `text_extract: ${extract || "(empty — only label + filename to go on)"}`
      );
    })
    .join("\n\n");

  const user =
    `PROJECT: ${project}\n` +
    `DOC TYPE REQUESTED: ${docTypeLabel}\n` +
    `CUSTOMER MESSAGE: ${JSON.stringify(message)}\n\n` +
    `AVAILABLE CATALOG (${rows.length} entries):\n` +
    `${catalog}\n\n` +
    `Pick the one entry that best matches the customer's request. If the customer ` +
    `mentioned a size (e.g. "3BHK", "1695", "2520 sft", "east-facing", "tower A"), ` +
    `match against size_label first, then text_extract for confirmation. ` +
    `If the customer didn't specify (just "send unit plan"), and there are multiple ` +
    `entries, mark the decision as 'ambiguous' and list ALL size_labels in ambiguous_options ` +
    `so we can ask which one they want.\n\n` +
    `Output JSON:\n` +
    `{\n` +
    `  "decision": "match" | "ambiguous" | "no_match",\n` +
    `  "size_label": "<exact size_label from catalog>" | null,\n` +
    `  "confidence": <0.0 to 1.0>,\n` +
    `  "reason": "<one short sentence>",\n` +
    `  "ambiguous_options": ["<size_label>", ...]   // empty array unless decision=ambiguous\n` +
    `}`;

  return { system, user };
}

/**
 * Pick the right unit_plan / floor_plan PDF for a customer message.
 *
 * @param message     the inbound WhatsApp message text (already trimmed)
 * @param project     project name (e.g. "ASBL Loft")
 * @param docType     "unit_plan" or "floor_plan"
 * @param confidenceThreshold   below this, return "ambiguous" so the
 *                              caller can ask a clarifying question. Default 0.7.
 */
export async function dispatchUnitPlan(
  message: string,
  project: string,
  docType: "unit_plan" | "floor_plan" | "price_sheet",
  confidenceThreshold = 0.7,
): Promise<UnitPlanDispatchResult> {
  const t0 = Date.now();

  if (!kimiAvailable()) {
    return {
      decision: "fallback", row: null, options: [], confidence: 0,
      reason: "Kimi unavailable (ROUTEWAY_API_KEY not set)",
      ms: 0,
    };
  }

  const rows = await fetchAvailableRows(project, docType);
  if (!rows.length) {
    return {
      decision: "no_match", row: null, options: [], confidence: 0,
      reason: `No ${docType} entries in project_documents for ${project}`,
      ms: Date.now() - t0,
    };
  }

  // Edge case: only ONE entry — no point asking Kimi (no ambiguity possible).
  if (rows.length === 1) {
    return {
      decision: "match", row: rows[0], options: [], confidence: 1,
      reason: "single catalog entry — no disambiguation needed",
      ms: Date.now() - t0,
    };
  }

  const { system, user } = buildPrompt(message, project, docType, rows);
  const result = await callKimi({
    system, user,
    jsonObject: true,
    maxTokens: 400,
    temperature: 0,
    timeoutMs: 20000,
    tag: `dispatch:${docType}`,
  });

  if (!result.ok || !result.json) {
    // Kimi failed — let the caller fall back to legacy substring-match.
    return {
      decision: "fallback", row: null, options: rows.map((r) => r.size_label || "").filter(Boolean),
      confidence: 0,
      reason: `Kimi unavailable: ${result.error || "no JSON returned"}`,
      ms: Date.now() - t0,
    };
  }

  const j = result.json;
  const rawDecision = String(j.decision || "").toLowerCase();
  const sizeLabel: string | null = j.size_label ?? null;
  const confidence = Number(j.confidence ?? 0) || 0;
  const reason = String(j.reason || "").slice(0, 200);
  const ambig: string[] = Array.isArray(j.ambiguous_options)
    ? j.ambiguous_options.filter((s: any) => typeof s === "string")
    : [];

  // Verify Kimi didn't invent a size_label not in the catalog (paranoia,
  // but worth the safety — Kimi can occasionally hallucinate a label).
  const catalogLabels = rows.map((r) => r.size_label || "");
  const inCatalog = sizeLabel ? catalogLabels.includes(sizeLabel) : false;

  if (rawDecision === "match" && inCatalog && confidence >= confidenceThreshold) {
    const matched = rows.find((r) => r.size_label === sizeLabel)!;
    return {
      decision: "match", row: matched, options: [], confidence, reason,
      ms: Date.now() - t0,
    };
  }

  if (rawDecision === "match" && inCatalog && confidence < confidenceThreshold) {
    // Kimi matched but isn't sure enough — degrade to ambiguous so caller asks.
    return {
      decision: "ambiguous", row: null,
      options: ambig.length ? ambig : catalogLabels.filter(Boolean),
      confidence, reason: `low confidence (${confidence.toFixed(2)}) — ${reason}`,
      ms: Date.now() - t0,
    };
  }

  if (rawDecision === "match" && !inCatalog) {
    // Hallucinated label — degrade to ambiguous, list real options.
    return {
      decision: "ambiguous", row: null,
      options: catalogLabels.filter(Boolean),
      confidence: 0,
      reason: `Kimi proposed off-catalog label "${sizeLabel}" — degrading to ambiguous`,
      ms: Date.now() - t0,
    };
  }

  if (rawDecision === "ambiguous") {
    return {
      decision: "ambiguous", row: null,
      options: ambig.length ? ambig : catalogLabels.filter(Boolean),
      confidence, reason,
      ms: Date.now() - t0,
    };
  }

  // no_match or anything else
  return {
    decision: "no_match", row: null, options: [], confidence, reason,
    ms: Date.now() - t0,
  };
}

/** Build a friendly clarification message to send to the customer when
 *  decision = "ambiguous". Kept Anandita-style (Sir/Ma'am, conversational). */
export function buildClarificationMessage(
  project: string,
  docType: "unit_plan" | "floor_plan" | "price_sheet",
  options: string[],
): string {
  const docLabel =
    docType === "unit_plan"   ? "unit plan"   :
    docType === "floor_plan"  ? "floor plan"  :
    docType === "price_sheet" ? "price sheet" :
    "document";
  const list = options.map((o) => `• ${o}`).join("\n");
  return (
    `Sure Sir, just to send the right one — we have a few ${docLabel}s for ${project}:\n\n` +
    `${list}\n\n` +
    `Which one would you like me to send?`
  );
}
