/**
 * Periskope → Anandita LLM (with grounded context) → Periskope reply handler
 *
 * Flow:
 *   1. Customer replies on WhatsApp
 *   2. Periskope fires webhook here (event_type: "message.created")
 *   3. Filter inbound messages only
 *   4. Look up Zoho lead (name, ASBL_Project)
 *   5. Resolve project (message keyword > Zoho field > last asked)
 *   6. Fetch site content from cache (or LEGACY teaser)
 *   7. Fetch last 30 days conversation history from Supabase
 *   8. Build structured message with <CUSTOMER>, <PROJECT_CONTEXT>,
 *      <CONVERSATION_HISTORY>, <USER_MESSAGE> blocks
 *   9. Call Anandita with structured message
 *  10. Send reply via Periskope
 *  11. Save inbound + outbound to Supabase with project tag
 *  12. Update Zoho: Last_Intent + Whatsapp_Replied
 *
 * Webhook URL: https://asbl-crm-api.vercel.app/api/relay/periskope-webhook
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveProject, detectMultiProjectIntent, Project } from "../_utils/project_detection";
import { getProjectFacts } from "../_utils/project_facts";
import { getInventoryForProject } from "../_utils/inventory_sheet";
import { getConversationContext } from "../_utils/conversation_context";
import { sanitizeReply } from "../_utils/sanitizer";
import { getDocumentFor, sendDocViaPeriskope } from "../_utils/document_dispatcher";
import { callGemini } from "../_utils/gemini_chat";
import { customerWordToDocType } from "../_utils/kb_doc_extractor";

const PERISKOPE_API_KEY = process.env.PERISKOPE_API_KEY || "";
const PERISKOPE_API_URL = "https://api.periskope.app/v1/messages/send";
const ANANDITA_URL      = process.env.ANANDITA_URL || "http://35.154.144.37:8080/api/chat/anandita_rm/";
const ANANDITA_API_KEY  = process.env.ANANDITA_API_KEY || "asbl_dccd9fea5d2fe188f5518574354e8fd805f0fd0a507926139fee0f1ae2ff07b1";
// Intent classifier — uses the Free RAG endpoint with periskope_intent_classifier slug
const ANANDITA_INTENT_URL =
  process.env.ANANDITA_INTENT_URL ||
  "http://35.154.144.37:8080/api/chat_rag/periskope_intent_classifier/";
const SUPABASE_URL      = process.env.SUPABASE_URL || "";
const SUPABASE_KEY      = process.env.SUPABASE_SECRET_KEY || "";
const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID || "";
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || "";
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || "";
const ZOHO_API_BASE      = "https://www.zohoapis.in/crm/v3";

// LEGACY teaser — hardcoded, project name NEVER appears in system context
const LEGACY_TEASER =
  "RTC X Roads upcoming pre-RERA project. Detailed pricing, floor plans, " +
  "and possession dates will be shared during a site visit only. " +
  "The project is in early stage and not yet RERA-registered.";

// ── Intent classifier (LLM-based, structured JSON output) ───────────────────
// Calls the periskope_intent_classifier RAG agent on the Anandita server.
// The agent's system prompt is configured to output strict JSON like:
//   {"intent":"PRICE_QUERY","flags":["hinglish_roman","has_project"],"project":"loft","cache_key":"loft_price_1695"}
//
// We pass the customer message + last 3 history messages as context so the
// classifier can disambiguate single-word replies (numbers, "yes", etc.).

export interface IntentClassification {
  intent: string;          // one of 19 labels (PRICE_QUERY, UNIT_QUERY, ... GENERAL)
  flags: string[];         // hinglish_roman, has_project, multi_question, etc.
  project: string | null;  // loft / broadway / spectra / landmark / rtc / null
  cacheKey: string;
}

// Regex-based fallback classifier — fast, used when LLM classifier times out
function regexFallbackClassify(message: string): IntentClassification {
  const m = message.toLowerCase();
  const flags: string[] = [];
  if (/[a-zA-Z]/.test(message)) flags.push("hinglish_roman");
  if (/[ऀ-ॿ]/.test(message)) flags.push("hindi_devanagari");
  if (/\b\d{3,4}\s*(?:sft|sqft|sq\.\s*ft)\b/i.test(message)) flags.push("has_unit_size");
  if (/\b(east|west|north|south|purvi|pashchim)\b/i.test(message)) flags.push("has_facing");
  if (/\b(cr|crore|lakh|lakhs|₹)\b/i.test(message)) flags.push("has_budget");

  let project: string | null = null;
  if (/\bloft\b/i.test(message)) project = "loft";
  else if (/\bspectra\b/i.test(message)) project = "spectra";
  else if (/\bbroadway\b/i.test(message)) project = "broadway";
  else if (/\blandmark\b/i.test(message)) project = "landmark";
  else if (/\b(rtc|x\s*roads|upcoming|pre[-\s]?rera|new\s+launch)\b/i.test(m)) project = "rtc";
  if (project) flags.push("has_project");

  let intent = "GENERAL";
  if (project === "rtc") intent = "RTC_QUERY";
  else if (/\b(not interested|nahi chahiye|stop|band karo|don'?t message|remove me)\b/i.test(m)) intent = "REJECTION";
  else if (/\b(brochure|pdf|floor\s*plan|cost\s*sheet|price\s*sheet|specifications?|details|layout|master\s*plan)\b/i.test(m)) intent = "DOCUMENT_REQUEST";
  else if (/\b(swimming\s*pool|gym|spa|pool|amenities|clubhouse|features?|sauna|jacuzzi|kids?\s*play|tennis|squash)\b/i.test(m)) intent = "FEATURE_QUERY";
  else if (/\b(rental|monthly\s*return|rent\s*offer|rental\s*offer)\b/i.test(m)) intent = "RENTAL_QUERY";
  else if (/\b(loan|emi|eligibility|home\s*loan|bank)\b/i.test(m)) intent = "LOAN_QUERY";
  else if (/\b(price|cost|kimat|kitn[ae]|kharcha|pricing|all\s*inclusive|per\s*sqft)\b/i.test(m)) intent = "PRICE_QUERY";
  else if (/\b(site\s*visit|visit|aana|aaunga|come\s+see)\b/i.test(m)) intent = "SITE_VISIT";
  else if (/\b(virtual\s*tour|video\s*call|virtual)\b/i.test(m)) intent = "GENERAL";  // virtual tour not a separate intent label
  else if (/\b(call\s*me|callback|call\s*back|phone\s*kar|baat\s*kar)\b/i.test(m)) intent = "CALLBACK";
  else if (/\b(nri|overseas|abroad|dubai|usa|uk|oci|foreign)\b/i.test(m)) intent = "NRI_QUERY";
  else if (/\b(possession|ready|construction|progress|when\s+ready|kab\s+ready)\b/i.test(m)) intent = "CONSTRUCTION_QUERY";
  else if (/\b(location|kahan|where|nearby|connectivity|distance)\b/i.test(m)) intent = "LOCATION_QUERY";
  else if (/\b(loft|broadway|spectra|landmark)\b.*\bvs\b|\bcompare|kaunsa\s*better\b/i.test(m)) intent = "COMPARISON";
  else if (/\b(too\s*much|expensive|mehnga|bahut|over\s*budget|kam\s+karo|reduce|discount)\b/i.test(m)) intent = "OBJECTION";
  else if (/^(hi|hello|hey|namaste|hii+|hola|yo)\b/i.test(m.trim())) {
    intent = "GREETING";
    flags.push("is_single_word");
  } else if (/^[a-z\s]{0,4}$/i.test(m.trim()) && m.trim().length <= 4) {
    flags.push("is_single_word");
    if (!/[a-zA-Z]/.test(message)) intent = "GIBBERISH";
  } else if (/^[^a-zA-Zऀ-ॿఀ-౿\d\s\W]+$/.test(message) || (message.length > 4 && !/[aeiouAEIOUऀ-ॿ]/.test(message))) {
    intent = "GIBBERISH";
  }

  return { intent, flags, project, cacheKey: `fallback_${intent.toLowerCase()}` };
}

async function classifyIntentLLM(message: string, last3Msgs: string): Promise<IntentClassification> {
  // The classifier prompt expects MESSAGE + LAST_3_MESSAGES.
  // We compose them into the message body since Anandita API doesn't have separate history params.
  const composed =
    `MESSAGE: ${message}\n\n` +
    `LAST_3_MESSAGES:\n${last3Msgs && last3Msgs.trim() ? last3Msgs : "(no prior conversation)"}`;

  // 8s timeout — if the qwen2.5:1.5b RAG agent hangs, fall back to regex
  const TIMEOUT_MS = 8000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(ANANDITA_INTENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ANANDITA_API_KEY}`,
      },
      body: JSON.stringify({
        phone: "+910000000099", // dedicated classifier phone (no history pollution)
        message: composed,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!r.ok) {
      const errText = await r.text();
      console.error(`[IntentClassifier] HTTP ${r.status}: ${errText.slice(0, 200)} — falling back to regex`);
      return regexFallbackClassify(message);
    }

    const data = (await r.json()) as any;
    const raw = String(data?.message || data?.reply || "").trim();

    // Strip optional markdown fencing: ```json ... ```
    let cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    // If model added preamble before JSON, try to find the first { ... } object
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace > 0 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(cleaned);
    return {
      intent: String(parsed.intent || "GENERAL").toUpperCase(),
      flags: Array.isArray(parsed.flags) ? parsed.flags.map((f: any) => String(f)) : [],
      project: parsed.project ? String(parsed.project).toLowerCase() : null,
      cacheKey: String(parsed.cache_key || ""),
    };
  } catch (err: any) {
    clearTimeout(timer);
    console.error(`[IntentClassifier] failed (${err.name || "error"}): ${err.message} — falling back to regex`);
    return regexFallbackClassify(message);
  }
}

// ── Map 19 fine-grained intent labels → Zoho's 6-value Last_Intent picklist ──
function mapIntentToZoho(intent: string): string {
  const map: Record<string, string> = {
    PRICE_QUERY:        "price",
    UNIT_QUERY:         "price",
    OBJECTION:          "price",
    RENTAL_QUERY:       "price",
    LOAN_QUERY:         "price",
    DOCUMENT_REQUEST:   "brochure",
    SITE_VISIT:         "site_visit",
    CONSTRUCTION_QUERY: "site_visit",
    CALLBACK:           "call_me",
    NRI_QUERY:          "call_me",
    REJECTION:          "not_interested",
    // Everything else → general
  };
  return map[intent] || "general";
}

// ── Map classifier's project hint to our Project enum (uppercase) ───────────
function projectHintToProject(hint: string | null): Project | null {
  if (!hint) return null;
  const h = hint.toLowerCase();
  if (h === "loft") return "LOFT";
  if (h === "spectra") return "SPECTRA";
  if (h === "broadway") return "BROADWAY";
  if (h === "landmark") return "LANDMARK";
  if (h === "rtc" || h === "legacy") return "LEGACY";
  return null;
}

// ── Zoho: Get access token (with two-tier cache) ─────────────────────────────
// Tier 1: module-level (warm Vercel invocations)
// Tier 2: Supabase bot_settings (cold-start cross-invocation)
// Without this, every webhook hit Zoho's OAuth /token endpoint fresh →
// rate-limit errors ("too many requests continuously") under burst load.
import { getBotSetting, setBotSetting } from "../_utils/bot_settings";

let _zohoTokenCache: string | null = null;
let _zohoTokenExpiry = 0;
const ZOHO_TOKEN_KEY = "zoho_access_token_v1";

async function getZohoToken(): Promise<string> {
  const now = Date.now();

  // 1. Module-level cache (warm)
  if (_zohoTokenCache && now < _zohoTokenExpiry) return _zohoTokenCache;

  // 2. Supabase-backed cache (across cold starts)
  try {
    const row = await getBotSetting(ZOHO_TOKEN_KEY);
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (parsed?.token && parsed?.expiry && now < parsed.expiry - 60_000) {
        _zohoTokenCache = parsed.token;
        _zohoTokenExpiry = parsed.expiry;
        return parsed.token;
      }
    }
  } catch {}

  // 3. Refresh from Zoho
  const r = await fetch(
    `https://accounts.zoho.in/oauth/v2/token?grant_type=refresh_token&client_id=${ZOHO_CLIENT_ID}&client_secret=${ZOHO_CLIENT_SECRET}&refresh_token=${ZOHO_REFRESH_TOKEN}`,
    { method: "POST" }
  );
  const data = await r.json() as any;
  if (!data.access_token) throw new Error("Zoho token error: " + JSON.stringify(data));

  const expiresInSec = Number(data.expires_in) || 3600;
  // Pad by 2 min so we don't serve a token about to die
  const expiry = now + (expiresInSec - 120) * 1000;
  _zohoTokenCache = data.access_token;
  _zohoTokenExpiry = expiry;

  // Persist for cold-start invocations
  setBotSetting(ZOHO_TOKEN_KEY, JSON.stringify({ token: data.access_token, expiry })).catch(() => {});

  return data.access_token;
}

// ── Zoho: Find lead with detail fields ────────────────────────────────────────
interface LeadDetails {
  id: string;
  firstName: string;
  lastName: string;
  asblProject: string | null;
}

async function findLeadDetailsByPhone(phone: string, token: string): Promise<LeadDetails | null> {
  const fields = "id,First_Name,Last_Name,ASBL_Project";

  const tryFetch = async (criteria: string): Promise<any | null> => {
    const r = await fetch(
      `${ZOHO_API_BASE}/Leads/search?criteria=${encodeURIComponent(criteria)}&fields=${fields}`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    if (!r.ok || r.status === 204) return null;
    const text = await r.text();
    if (!text) return null;
    try {
      const data = JSON.parse(text);
      return data?.data?.[0] || null;
    } catch { return null; }
  };

  let row = await tryFetch(`(Mobile:equals:${phone})`);
  if (!row) row = await tryFetch(`(Phone:equals:${phone})`);
  if (!row) return null;

  return {
    id: row.id,
    firstName: row.First_Name || "",
    lastName: row.Last_Name || "",
    asblProject: row.ASBL_Project || null,
  };
}

// ── Zoho: Update lead intent ──────────────────────────────────────────────────
async function updateZohoIntent(leadId: string, intent: string, token: string): Promise<void> {
  await fetch(`${ZOHO_API_BASE}/Leads`, {
    method: "PATCH",
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: [{ id: leadId, Last_Intent: intent, Whatsapp_Replied: true }],
    }),
  });
  console.log(`[Periskope Webhook] Zoho updated — Lead ${leadId}: Last_Intent=${intent}`);
}

// ── Save message to Supabase (with optional project + intent tags) ───────────
async function saveMessage(
  phone: string,
  direction: "inbound" | "outbound",
  message: string,
  sender: string,
  project: Project | null,
  intent: string | null = null,
): Promise<void> {
  try {
    const body: any = { phone, direction, message, sender };
    if (project) body.project = project;
    if (intent)  body.intent  = intent;
    await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_messages`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        apikey:          SUPABASE_KEY,
        Authorization:   `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[Periskope Webhook] Failed to save message:", err);
  }
}

// ── Parse JID → clean phone number ───────────────────────────────────────────
function parsePhone(jid: string): string | null {
  if (!jid) return null;
  const phone = String(jid).split("@")[0].replace(/\D/g, "");
  return (phone.length >= 10 && phone.length <= 15) ? phone : null;
}

// ── Is this an inbound (customer) message? ────────────────────────────────────
function isInbound(data: any): boolean {
  return data?.from_me !== true;
}

// ── Resolve project context text — manual KB notes + LIVE inventory sheet ─
async function getProjectContextText(project: Project | null): Promise<string> {
  if (!project) return "no specific project resolved";
  if (project === "LEGACY") return LEGACY_TEASER;

  // KB + offer (one row read) and live inventory fetch in parallel —
  // both can take 200-500ms independently. Saves ~400ms in cold/cache-miss path.
  const [factsRes, invRes] = await Promise.allSettled([
    getProjectFacts(project),
    getInventoryForProject(project),
  ]);
  const facts = factsRes.status === "fulfilled" ? factsRes.value : null;
  const inv = invRes.status === "fulfilled" ? invRes.value : null;
  if (invRes.status === "rejected") {
    console.error(`[Webhook] Inventory fetch failed: ${invRes.reason?.message}`);
  }

  const parts: string[] = [];

  // 1. Project KB (auto-extracted from uploaded TXT/PDF via dashboard)
  if (facts?.kb_text?.trim()) {
    parts.push("## PROJECT KNOWLEDGE BASE");
    parts.push(facts.kb_text.trim());
  }

  // 2. Curated OFFER details (manually written in dashboard's Edit ✎ form)
  //    Kept SEPARATE from KB so KB uploads never overwrite offer text.
  if (facts?.facts_text?.trim()) {
    if (parts.length) parts.push("");
    parts.push("## OFFER DETAILS (manually curated, authoritative for offers/schemes)");
    parts.push(facts.facts_text.trim());
  }

  // 3. Live inventory + pricing from the master Google Sheet
  if (inv?.markdown) {
    if (parts.length) parts.push("");
    parts.push("## CURRENT INVENTORY & PRICING (live from sales sheet)");
    parts.push(inv.markdown);
  }

  if (parts.length === 0) {
    return `No knowledge base or inventory available for ${project} yet. Tell the customer you'll have a sales executive revert with details.`;
  }

  const combined = parts.join("\n").trim();
  // Trim to ~18 KB to keep prompt size reasonable
  return combined.length > 18000 ? combined.slice(0, 18000) + "\n... (truncated)" : combined;
}

// ── Build a compact multi-project context (used for "all projects" / compare) ─
// Each project's KB+offer is heavily summarised so all 4 fit comfortably in
// Gemini's input. Inventory is also condensed to per-project headlines.
async function getMultiProjectContextText(): Promise<string> {
  const projects: Project[] = ["LOFT", "SPECTRA", "BROADWAY", "LANDMARK"];
  const parts: string[] = [];

  for (const p of projects) {
    const block: string[] = [`### PROJECT: ${p}`];
    try {
      const facts = await getProjectFacts(p);
      const kbText = (facts as any)?.kb_text?.trim() || "";
      const offerText = facts?.facts_text?.trim() || "";

      if (kbText) {
        // Cap each project's KB to ~3 KB so 4 projects fit in budget
        block.push("KB:");
        block.push(kbText.length > 3000 ? kbText.slice(0, 3000) + "..." : kbText);
      }
      if (offerText) {
        block.push("OFFER:");
        block.push(offerText);
      }
      try {
        const inv = await getInventoryForProject(p);
        if (inv.markdown) {
          // Take only the first 1.5KB of inventory per project
          block.push("INVENTORY:");
          block.push(inv.markdown.length > 1500 ? inv.markdown.slice(0, 1500) + "..." : inv.markdown);
        }
      } catch {}
    } catch {}
    if (block.length > 1) parts.push(block.join("\n"));
  }

  if (!parts.length) return "No project data loaded.";

  const combined =
    "## MULTI_PROJECT_CONTEXT — use this when the customer asks about all/any projects, compares, or doesn't name one\n\n" +
    parts.join("\n\n");
  return combined.length > 22000 ? combined.slice(0, 22000) + "\n... (truncated)" : combined;
}

// ── Build structured message for the LLM ─────────────────────────────────────
// Gemini decides intent/flags itself in its structured output, so we no longer
// pass <INTENT>/<FLAGS> blocks. The signature still accepts them for the
// fallback Anandita call, but they're not rendered into the message.
function buildStructuredMessage(opts: {
  customerName: string;
  phone: string;
  project: Project | null;
  daysSinceLast: number | null;
  lastProject: string | null;
  projectContext: string;
  history: string;
  userMessage: string;
  intent?: string;
  flags?: string[];
}): string {
  const lastProjectTag = opts.lastProject || "none";
  const daysTag = opts.daysSinceLast === null ? "first time" : String(opts.daysSinceLast);
  const currentProjectTag = opts.project || "not specified";

  return [
    `<CUSTOMER>`,
    `Name: ${opts.customerName || "(not provided)"}`,
    `Phone: ${opts.phone}`,
    `Last asked project: ${lastProjectTag}`,
    `Currently asking about project: ${currentProjectTag}`,
    `Days since last interaction: ${daysTag}`,
    `</CUSTOMER>`,
    ``,
    `<PROJECT_CONTEXT>`,
    opts.projectContext,
    `</PROJECT_CONTEXT>`,
    ``,
    `<CONVERSATION_HISTORY>`,
    opts.history,
    `</CONVERSATION_HISTORY>`,
    ``,
    `<USER_MESSAGE>`,
    opts.userMessage,
    `</USER_MESSAGE>`,
  ].join("\n");
}

// ── Pull last N messages from full conversation history (for classifier) ────
function lastNHistoryLines(fullHistory: string, n: number): string {
  if (!fullHistory || fullHistory === "no prior conversation") return "";
  const lines = fullHistory.split("\n").filter((l) => l.trim());
  return lines.slice(-n).join("\n");
}

// ── Call Anandita main LLM with timeout ──────────────────────────────────────
async function callAnandita(phone: string, message: string): Promise<string> {
  const TIMEOUT_MS = 20000; // 20s — fail fast if model hangs
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(ANANDITA_URL, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${ANANDITA_API_KEY}`,
      },
      body: JSON.stringify({ phone: `+${phone}`, message }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Anandita error ${r.status}: ${err}`);
    }
    const data = await r.json() as any;
    const reply: string = data?.message || data?.reply || "";
    if (!reply.trim()) throw new Error("Anandita returned empty reply");
    return reply.trim();
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error(`Anandita timeout after ${TIMEOUT_MS}ms`);
    throw err;
  }
}

// ── Send via Periskope with typing delay + retry on transient failure ──────
async function sendReply(phone: string, sender: string, message: string): Promise<void> {
  // 1. Send typing indicator (non-critical)
  try {
    await fetch(`https://api.periskope.app/v1/chats/typing`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${PERISKOPE_API_KEY}`,
        "x-phone":       sender,
      },
      body: JSON.stringify({ chat_id: `${phone}@c.us` }),
    });
  } catch { /* not critical */ }

  // 2. Brief human-like pause — kept short so total reply latency stays
  //    under ~10s end-to-end. Periskope shows a typing indicator anyway.
  await new Promise(resolve => setTimeout(resolve, 500));

  // 3. Send actual message — with 1 retry on 5xx / network failure
  const sendOnce = async () => {
    return fetch(PERISKOPE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${PERISKOPE_API_KEY}`,
        "x-phone":       sender,
      },
      body: JSON.stringify({ chat_id: phone, message }),
    });
  };

  let r: Response;
  try {
    r = await sendOnce();
    if (!r.ok && r.status >= 500) {
      console.warn(`[Periskope] first send returned ${r.status}, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 800));
      r = await sendOnce();
    }
  } catch (err: any) {
    console.warn(`[Periskope] first send threw (${err.message}), retrying...`);
    await new Promise(resolve => setTimeout(resolve, 800));
    r = await sendOnce();
  }

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Periskope send error ${r.status}: ${text}`);
  }
}

// ── Main Handler ──────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  try {
    const body  = req.body || {};
    const event = String(body?.event_type || body?.event || body?.type || "");
    const data  = body?.data || body;

    console.log(`[Periskope Webhook] Event: ${event}`);

    // Only handle message.created / message.received
    if (event !== "message.created" && event !== "message.received") {
      return res.status(200).json({ skipped: true, event });
    }

    // Only inbound messages
    if (!isInbound(data)) {
      return res.status(200).json({ skipped: true, reason: "outbound" });
    }

    const phone   = parsePhone(data?.chat_id);
    const sender  = parsePhone(data?.org_phone);
    const message = String(data?.body || "").trim();

    if (!phone)   return res.status(200).json({ skipped: true, reason: "no phone" });
    if (!sender)  return res.status(200).json({ skipped: true, reason: "no sender" });
    if (!message) return res.status(200).json({ skipped: true, reason: "no message" });

    console.log(`[Periskope Webhook] Inbound from ${phone} | msg: ${message.slice(0, 80)}`);

    // 1+2. Run Zoho lookup AND conversation history fetch in parallel —
    //      they're independent and account for ~1.5-2s sequentially.
    const zohoTask: Promise<{ token: string; lead: LeadDetails | null }> = (async () => {
      try {
        const token = await getZohoToken();
        const lead = await findLeadDetailsByPhone(phone, token);
        return { token, lead };
      } catch (err: any) {
        console.error(`[Periskope Webhook] Zoho lookup failed: ${err.message}`);
        return { token: "", lead: null };
      }
    })();

    const historyTask = getConversationContext(phone);
    const [zohoResult, conversation] = await Promise.all([zohoTask, historyTask]);
    const zohoToken = zohoResult.token;
    const leadDetails: LeadDetails | null = zohoResult.lead;

    // 3. Resolve project (regex on message > Zoho field > last asked).
    //    Gemini may also identify the project itself from its output;
    //    we'll override below if Gemini's project hint is more specific.
    let project = await resolveProject({
      message,
      zohoProject: leadDetails?.asblProject || null,
      phone,
    });
    console.log(`[Periskope Webhook] Initial project resolution: ${project || "(none)"}`);

    // 4. Detect "all projects / compare" intent — switch to multi-project context
    //    so Gemini can answer about every project, not just the resolved one.
    const isMultiProject = detectMultiProjectIntent(message);

    // 5. Build PROJECT_CONTEXT — single project's KB+offer+inventory normally,
    //    or all 4 projects condensed when multi-project intent fires.
    let projectContext: string;
    if (isMultiProject) {
      console.log(`[Periskope Webhook] Multi-project intent detected — sending all projects' context`);
      projectContext = await getMultiProjectContextText();
    } else {
      projectContext = await getProjectContextText(project);
    }

    // 5. Build structured message — Gemini will classify + reply in one call.
    //    No <INTENT>/<FLAGS> blocks because Gemini decides those itself.
    const customerName =
      [leadDetails?.firstName, leadDetails?.lastName].filter(Boolean).join(" ").trim();

    const structuredMsg = buildStructuredMessage({
      customerName,
      phone,
      project,
      daysSinceLast: conversation.daysSinceLast,
      lastProject: conversation.lastProject,
      projectContext,
      history: conversation.formatted,
      userMessage: message,
      intent: "(to be classified by Gemini)",
      flags: [],
    });

    // 6. Single Gemini call: classifies + composes reply (structured JSON output).
    //    Grounding (Google Search) adds 5-15s overhead PER call — disabled by
    //    default since 95% of queries are answered from PROJECT_CONTEXT alone.
    //    callGemini still auto-retries on truncation; with grounding off, both
    //    attempts are fast. On total failure, falls back to local Anandita.
    let geminiOutput: Awaited<ReturnType<typeof callGemini>>;
    try {
      geminiOutput = await callGemini(structuredMsg, { enableGrounding: false });
    } catch (err: any) {
      console.error(`[Periskope Webhook] Gemini failed (${err.message}) — falling back to local Anandita + regex classifier`);
      const fallbackReply = await callAnandita(phone, structuredMsg);
      const regexResult = regexFallbackClassify(message);
      geminiOutput = {
        intent: regexResult.intent,
        flags: regexResult.flags,
        project: regexResult.project,
        docToSend: null,
        reply: fallbackReply,
      };
    }

    const classification = {
      intent: geminiOutput.intent,
      flags: geminiOutput.flags,
      project: geminiOutput.project,
      cacheKey: "",
    };
    console.log(
      `[Periskope Webhook] Intent: ${classification.intent} | flags: ${classification.flags.join(",") || "(none)"} | project hint: ${classification.project || "(none)"}`
    );

    // 7. Override project resolution with Gemini's project hint if it's more specific
    const projectFromGemini = projectHintToProject(classification.project);
    if (projectFromGemini && projectFromGemini !== project) {
      console.log(`[Periskope Webhook] Project override from Gemini: ${project} → ${projectFromGemini}`);
      project = projectFromGemini;
    }

    // 8. Map fine-grained intent → Zoho's 6-value picklist (for analytics)
    const zohoIntent = mapIntentToZoho(classification.intent);

    // 9. Save inbound message with project + (Zoho-mapped) intent tags
    await saveMessage(phone, "inbound", message, sender, project, zohoIntent);

    const reply = sanitizeReply(geminiOutput.reply);
    console.log(`[Periskope Webhook] Gemini reply (sanitized): ${reply.slice(0, 100)}`);

    // 10. Save outbound IMMEDIATELY so a fast follow-up message from the
    //     customer sees the bot's reply in CONVERSATION_HISTORY, even if
    //     Periskope's typing-indicator delay hasn't fired the actual send yet.
    await saveMessage(phone, "outbound", reply, sender, project);

    // 11. Send text reply via Periskope (1.5s typing delay + 1 retry inside)
    let sendOk = true;
    try {
      await sendReply(phone, sender, reply);
    } catch (err: any) {
      sendOk = false;
      console.error(`[Periskope Webhook] Periskope send failed (reply saved to DB but not delivered): ${err.message}`);
    }

    // 12. Auto-deliver document via Periskope when Gemini signals it.
    //     STRICT GATING — only fire doc lookup when Gemini EXPLICITLY set
    //     doc_to_send to a non-null slug. Earlier we also fired on
    //     intent === DOCUMENT_REQUEST with doc_to_send=null, which caused
    //     the "Sure, which tower? — Actually one sec, not on my phone"
    //     double-message bug when Gemini purposely asked a clarifying
    //     question instead of sending a doc. Now Gemini is the single
    //     source of truth for whether a doc should be delivered.
    let docSent: { doc_type: string; url: string; source?: string } | null = null;
    const isDocRequest = geminiOutput.docToSend !== null;

    if (project && isDocRequest) {
      const docTypeFromMsg = geminiOutput.docToSend!;
      try {
        // For multi-slot doc types (unit_plan / floor_plan), pass the raw
        // customer message as a hint so the dispatcher fuzzy-matches the right
        // tower / unit-size variant (e.g. "Tower A floor plan" → Tower-A row).
        const sizeHint =
          (docTypeFromMsg === "unit_plan" || docTypeFromMsg === "floor_plan")
            ? message
            : null;
        const doc = await getDocumentFor(project, docTypeFromMsg, sizeHint);
        if (doc) {
          const captionMap: Record<string, string> = {
            brochure: `${project} brochure as discussed.`,
            price_sheet: `${project} price sheet as discussed.`,
            specifications: `${project} specifications as discussed.`,
            master_plan: `${project} master plan as discussed.`,
            tower_plan: `${project} tower plan as discussed.`,
            floor_plan: `${project} floor plan as discussed.`,
            payment_structure: `${project} payment structure as discussed.`,
            amenities: `${project} amenities sheet as discussed.`,
          };
          const caption = captionMap[doc.doc_type] || `${project} ${doc.doc_type} as discussed.`;
          await sendDocViaPeriskope(phone, sender, doc.url, doc.filename, caption);
          docSent = { doc_type: doc.doc_type, url: doc.url, source: doc.source };
          console.log(`[Periskope Webhook] Doc sent (source=${doc.source}): ${doc.doc_type} → ${doc.url}`);
        } else {
          // ATOMIC DELIVERY — Gemini promised the doc but it's not uploaded yet.
          // Send an honest follow-up so customer doesn't wait for a PDF that
          // never arrives (fixes MD-3 broken-promise issue from the test sheet).
          console.log(`[Periskope Webhook] No ${docTypeFromMsg} doc found for ${project} — sending honest follow-up`);
          const followUp = `Actually one sec — that one's not on my phone right now. Let me get it from the project team and send it across shortly.`;
          await saveMessage(phone, "outbound", followUp, sender, project);
          try {
            await sendReply(phone, sender, followUp);
          } catch (err: any) {
            console.error(`[Periskope Webhook] doc-missing follow-up failed: ${err.message}`);
          }
        }
      } catch (err: any) {
        console.error(`[Periskope Webhook] Doc send failed: ${err.message}`);
      }
    }

    // 13. Update Zoho: Last_Intent + Whatsapp_Replied (with mapped picklist value)
    if (leadDetails && zohoToken) {
      try {
        await updateZohoIntent(leadDetails.id, zohoIntent, zohoToken);
      } catch (err: any) {
        console.error(`[Periskope Webhook] Zoho update error: ${err.message}`);
      }
    } else {
      console.log(`[Periskope Webhook] Skipping Zoho update — lead not found`);
    }

    return res.status(200).json({
      success: true,
      phone,
      project,
      intent: classification.intent,
      flags: classification.flags,
      zohoIntent,
      historyMessages: conversation.totalMessages,
      docSent,
      delivered: sendOk,
    });

  } catch (err: any) {
    console.error("[Periskope Webhook] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
