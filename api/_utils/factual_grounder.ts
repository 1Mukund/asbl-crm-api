/**
 * Factual grounder — when a customer asks a specific spec question
 * ("what's the balcony size?", "RERA number?", "carpet area for 3BHK?"),
 * Kimi K2 reads the project's uploaded PDF text_extracts and extracts the
 * exact answer with a citation. The result gets injected into Gemini's
 * PROJECT_CONTEXT as a "GROUND_TRUTH" section so Gemini can quote it
 * verbatim instead of guessing from a vague KB summary.
 *
 * Why this exists:
 *   Gemini hallucinates on narrow numeric specs because it has the whole KB
 *   + facts + inventory + history + 19-intent classifier in one call —
 *   too much to juggle, so it confabulates plausible-sounding numbers.
 *   Kimi gets ONE focused job: "find this fact in this text. Quote exactly.
 *   Cite which document. If not present, say so." That's where it shines.
 *
 * Pipeline:
 *   1. Quick regex check on inbound message — does it contain a "factual
 *      question marker" (balcony size, RERA, carpet area, dimensions, etc.)?
 *      If not, skip Kimi entirely (no latency overhead on chitchat).
 *   2. Fetch uploaded PDF text_extracts for the project (unit_plan + spec +
 *      brochure). Cap at top 6 docs ranked by recency.
 *   3. Send to Kimi with strict JSON output: { found: bool, answer, cite,
 *      confidence }. Kimi returns "" + found=false if facts aren't in any
 *      doc — Gemini will then fall back to a graceful "let me check" reply.
 *   4. Inject the answer into PROJECT_CONTEXT as GROUND_TRUTH for Gemini.
 *
 * Best-effort: if Kimi is unavailable / errors / says found=false, the
 * caller just doesn't inject anything and Gemini operates as before.
 */
import { callKimi, kimiAvailable } from "./kimi";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

/** Patterns that signal a "specific factual question" worth grounding.
 *  Designed to fire on questions Gemini tends to hallucinate on, while
 *  ignoring chitchat / availability / appointment-booking messages. */
const FACTUAL_QUESTION_PATTERNS: RegExp[] = [
  // Dimensions / sizes
  /\b(balcony|balconies)\s*(size|dimension|length|width|sft|sq\.?\s*ft)/i,
  /\b(bedroom|kitchen|hall|living|dining|master\s+bed)\s*(size|dimension|length|width|sft|sq\.?\s*ft)/i,
  /\b(carpet|built[\s-]*up|super\s*built[\s-]*up|sba)\s*area/i,
  /\b(actual|exact|true|real)\s+(size|sft|area|sq\.?\s*ft)/i,
  /\bdimensions?\b/i,
  // Specs
  /\b(door|window|tile|floor|ceiling)\s+(size|height|width|spec|brand)/i,
  /\b(brand|company|make|manufacturer)\s+of\s+/i,
  /\bspecifications?\b/i,
  // Approvals / RERA
  /\bRERA\s*(no|number|id|registration)?/i,
  /\b(approval|sanction|HMDA|GHMC|panchayat)\s*(no|number|id|status)?/i,
  /\b(occupancy|completion|environmental)\s+(certificate|cert)/i,
  // Pricing specifics that often hallucinate
  /\b(per\s*sft|per\s*sq\.?\s*ft|psf)\s*(rate|price|cost)/i,
  /\b(maintenance|amc|corpus|club\s+house|stamp\s+duty|registration)\s+(charge|cost|fee|amount)/i,
  // Open generic Q markers — only the most factual ones
  /\bhow\s+(big|large|much|many)\s+/i,
  /\bwhat['\s]?s?\s+the\s+(size|area|dimension|cost|price|rate|number|id|spec)/i,
];

export function isFactualQuestion(message: string): boolean {
  const m = String(message || "").trim();
  if (m.length < 4) return false;
  return FACTUAL_QUESTION_PATTERNS.some((re) => re.test(m));
}

interface DocSnippet {
  doc_type: string;
  size_label: string | null;
  filename: string | null;
  text_extract: string;
}

async function fetchDocsForGrounding(project: string): Promise<DocSnippet[]> {
  // We pull unit_plan + specifications + brochure + master_plan + amenities
  // — these cover most factual questions. Skip price_sheet (frequently has
  // numeric tables that confuse text-only extraction).
  const docTypes = "(unit_plan,specifications,brochure,master_plan,amenities,floor_plan)";
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/project_documents` +
      `?project=eq.${encodeURIComponent(project)}` +
      `&doc_type=in.${docTypes}` +
      `&text_extract=not.is.null` +
      `&select=doc_type,size_label,filename,text_extract` +
      `&order=fetched_at.desc&limit=8`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  if (!r.ok) return [];
  const rows = (await r.json()) as DocSnippet[];
  return Array.isArray(rows) ? rows.filter((d) => d.text_extract && d.text_extract.length > 50) : [];
}

/** Squash a long text_extract for the prompt — keep dimensions section
 *  tight. Most unit-plan extracts are 2-4 KB; we cap each at 1.5 KB. */
function squash(txt: string, max = 1500): string {
  const t = txt.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)} … [${t.length - max} chars trimmed]`;
}

export interface GroundedAnswer {
  found: boolean;
  answer: string;
  cite: string;
  confidence: number;
  ms: number;
}

/**
 * Try to ground the customer's factual question against uploaded PDFs.
 * Returns a GroundedAnswer; caller decides whether to inject into Gemini's
 * PROJECT_CONTEXT.
 *
 * Caller pattern (in periskope-webhook.ts):
 *   const grounded = isFactualQuestion(message)
 *     ? await groundFactualQuestion(message, project)
 *     : null;
 *   if (grounded?.found && grounded.confidence >= 0.6) {
 *     projectContext += `\n\nGROUND_TRUTH (verified from uploaded ${grounded.cite}):\n${grounded.answer}\n` +
 *                       `When the customer asks the related question, quote this verbatim. Do NOT make up alternative numbers.`;
 *   }
 */
export async function groundFactualQuestion(
  message: string,
  project: string,
): Promise<GroundedAnswer | null> {
  const t0 = Date.now();
  if (!kimiAvailable()) return null;

  const docs = await fetchDocsForGrounding(project);
  if (!docs.length) return null;

  const catalog = docs
    .map((d, i) => {
      const tag = d.size_label
        ? `${d.doc_type} (${d.size_label})`
        : d.doc_type;
      return `--- Doc #${i + 1}: ${tag} [${d.filename || "no-filename"}] ---\n${squash(d.text_extract)}`;
    })
    .join("\n\n");

  const system =
    "You are a real-estate fact-extractor. Your ONLY job is to find a specific " +
    "answer to the customer's question inside the provided document text. " +
    "STRICT RULES:\n" +
    "  - If the answer is NOT explicitly in any of the documents, set found=false " +
    "    and answer=\"\". Do NOT guess. Do NOT estimate. Do NOT use general knowledge.\n" +
    "  - If multiple values appear (e.g. balcony sizes for different unit types), " +
    "    pick the one that matches the customer's question context, OR include all " +
    "    of them in the answer with their unit-type labels.\n" +
    "  - Quote numbers EXACTLY as they appear in the document (don't round).\n" +
    "  - In `cite`, name the doc_type + size_label that contains the fact.\n" +
    "  - Output STRICT JSON only.";

  const user =
    `PROJECT: ${project}\n` +
    `CUSTOMER QUESTION: ${JSON.stringify(message)}\n\n` +
    `UPLOADED DOCUMENTS (${docs.length}):\n${catalog}\n\n` +
    `Output JSON:\n` +
    `{\n` +
    `  "found": true | false,\n` +
    `  "answer": "<exact fact, including units. Empty string if not found.>",\n` +
    `  "cite": "<doc_type + size_label>" | "",\n` +
    `  "confidence": <0.0..1.0>\n` +
    `}`;

  const result = await callKimi({
    system, user,
    jsonObject: true,
    maxTokens: 400,
    temperature: 0,
    timeoutMs: 20000,
    tag: "ground",
  });

  const ms = Date.now() - t0;
  if (!result.ok || !result.json) {
    return { found: false, answer: "", cite: "", confidence: 0, ms };
  }

  const j = result.json;
  return {
    found: !!j.found && typeof j.answer === "string" && j.answer.trim().length > 0,
    answer: String(j.answer || "").slice(0, 600),
    cite: String(j.cite || "").slice(0, 100),
    confidence: Number(j.confidence ?? 0) || 0,
    ms,
  };
}
