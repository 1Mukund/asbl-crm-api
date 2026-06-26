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
import { getInventoryForProject, getCrossProjectSizeIndex } from "../_utils/inventory_sheet";
import { getConversationContext } from "../_utils/conversation_context";
import { sanitizeReply, stripReintroduction } from "../_utils/sanitizer";
import {
  getDocumentFor,
  getDocumentStrict,
  listAvailableMetaLabels,
  sendDocViaPeriskope,
} from "../_utils/document_dispatcher";
import { callGemini } from "../_utils/gemini_chat";
import { dispatchUnitPlan, buildClarificationMessage } from "../_utils/unit_plan_dispatcher";
import { isFactualQuestion, groundFactualQuestion } from "../_utils/factual_grounder";
import {
  getOrCreateProfile,
  setActiveProject,
  diffExtractedFacts,
  mergeProfile,
  advanceFunnel,
  inferQualifiedSignal,
  appendDocSent,
  renderUserProfileBlock,
  UserProfile,
} from "../_utils/user_profile";
import {
  validateDocSend,
  logDocSend,
  SAFE_FALLBACK_REPLY,
} from "../_utils/doc_validator";
import {
  computeOfferTimeRemaining,
  renderOfferUrgencyBlock,
} from "../_utils/offer_time";
import { insertMessage as mongoInsertMessage } from "../_utils/whatsapp_messages";

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
/** Regex-extract which document type the customer is asking for. Only used
 *  when Gemini fails — primary path is Gemini's structured docToSend slot.
 *
 *  Returns one of the supported doc_type slugs, OR null if no doc keyword
 *  matched. Order matters: more specific phrases first so "price sheet"
 *  doesn't get classified as "brochure" because "details" appeared too.
 *
 *  Multi-slot doc types (floor_plan, unit_plan) are returned as the bare
 *  slug. The dispatcher will then ask for tower / size if size/facing isn't
 *  inferable from the same message — same behaviour as the Gemini path.
 *
 *  Why this exists: Gemini fallback used to hardcode docToSend = null,
 *  which meant a Gemini 503 turned every document request into a chatty
 *  "I'll confirm with project team" message with NO actual file send.
 *  Sales reported this as the bot promising and never delivering (QA bugs
 *  #1 / #2 / #3 / #5 from 2026-06-18 review).
 */
function extractDocTypeFromMessage(message: string): string | null {
  const m = message.toLowerCase();
  if (/\bprice\s*sheet|cost\s*sheet|pricing\s*sheet|all\s*inclusive\s*price|price\s*list/i.test(m)) return "price_sheet";
  if (/\bbrochure|pamphlet/i.test(m)) return "brochure";
  if (/\bfloor\s*plan/i.test(m)) return "floor_plan";
  if (/\bunit\s*plan/i.test(m)) return "unit_plan";
  if (/\bmaster\s*plan|site\s*plan|layout/i.test(m)) return "master_plan";
  if (/\bspecifications?\b|spec\s*sheet/i.test(m)) return "specifications";
  if (/\bamenities/i.test(m)) return "amenities";
  if (/\bpayment\s*structure|payment\s*plan|payment\s*schedule|milestone\s*plan|construction\s*linked/i.test(m)) return "payment_structure";
  // Generic doc keywords with no specific type → default to brochure
  // (most comprehensive single doc; sales agreed this is the right fallback).
  if (/\b(pdf|documents?|information|info|details|paperwork|catalogue|catalog)\b/i.test(m)) return "brochure";
  return null;
}

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

// ── Callback trigger — fires voice-bot call when customer asks for callback ──
// Hit when classified intent maps to "call_me" (CALLBACK / NRI_QUERY).
// Throttled to 1 callback per 30 min per lead so a spammy customer can't
// dial themselves repeatedly via WhatsApp.
//
// Rate-limit signal: max(PRD_Last_Action_Time when PRD_Last_Action='AI Call',
// Last_Call_At). The first is set by our PRD orchestrator; the second by the
// Deluge `triggerArrowheadCall` (bulk button + workflow). Together they
// cover every code path that places a call to this lead.
const CALLBACK_COOLDOWN_MIN = 30;

async function triggerCallbackCall(
  leadId: string,
  phone: string,
  customerName: string,
  project: string | null,
  token: string,
): Promise<{ ok: boolean; reason?: string }> {
  // 1. Cooldown check — read both PRD + legacy timestamps from Zoho
  try {
    const r = await fetch(
      `${ZOHO_API_BASE}/Leads/${leadId}?fields=PRD_Last_Action,PRD_Last_Action_Time,Last_Call_At`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    if (r.ok) {
      const data = (await r.json()) as any;
      const lead = data?.data?.[0];
      if (lead) {
        const stamps: number[] = [];
        if (lead.PRD_Last_Action === "AI Call" && lead.PRD_Last_Action_Time) {
          stamps.push(new Date(lead.PRD_Last_Action_Time).getTime());
        }
        if (lead.Last_Call_At) {
          stamps.push(new Date(lead.Last_Call_At).getTime());
        }
        const mostRecent = stamps.length ? Math.max(...stamps) : 0;
        if (mostRecent > 0) {
          const minsSince = (Date.now() - mostRecent) / 60_000;
          if (minsSince < CALLBACK_COOLDOWN_MIN) {
            return {
              ok: false,
              reason: `cooldown: last call ${minsSince.toFixed(1)}m ago (need ${CALLBACK_COOLDOWN_MIN}m gap)`,
            };
          }
        }
      }
    }
  } catch (err: any) {
    // Cooldown read failure → fail open (place the call). Better to risk a
    // duplicate than silently swallow a customer-initiated callback request.
    console.error(`[Periskope Webhook] cooldown read failed: ${err.message}`);
  }

  // 2. Fire the call through our in-house relay
  const SELF_BASE = process.env.SELF_PUBLIC_URL || "https://asbl-crm-api.vercel.app";
  const payload = {
    _zoho_lead_id: leadId,
    phone_number: phone,
    customer_full_name: customerName,
    external_schedule_id: `wa-callme-${leadId}-${Date.now()}`,
    external_customer_id: leadId,
    retell_llm_dynamic_variables: {
      customer_name: customerName,
      customer_phone: phone,
      project_name: project || "",
      trigger_reason: "whatsapp_callback_request",
    },
  };
  try {
    const callR = await fetch(`${SELF_BASE}/api/relay/inhouse-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await callR.json().catch(() => ({}));
    if (!callR.ok) {
      return {
        ok: false,
        reason: `relay ${callR.status}: ${JSON.stringify(j).slice(0, 200)}`,
      };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err.message };
  }
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
    await mongoInsertMessage({
      phone,
      direction,
      message,
      sender,
      project: project ?? null,
      intent: intent ?? null,
      created_at: new Date().toISOString(),
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

  // 4. PDF document extracts — fallback KB when curated text doesn't have it.
  //    Toggleable via bot_settings.use_pdf_extracts (default = on).
  try {
    const setting = await getBotSetting("use_pdf_extracts");
    const enabled = !setting || setting.value !== "false"; // default ON
    if (enabled) {
      const pdfBlock = await fetchPdfExtractsForProject(project);
      if (pdfBlock) {
        if (parts.length) parts.push("");
        parts.push(pdfBlock);
      }
    }
  } catch (err: any) {
    console.error(`[Webhook] PDF extracts fetch failed: ${err.message}`);
  }

  // 5. Cross-project SIZE INDEX — compact one-liner-per-project list of every
  //    available size across ALL projects. Lets Gemini answer "Loft doesn't
  //    have 2035 sft but Broadway does — shall I send Broadway's plan?"
  //    instead of the previous behaviour where it said "we don't have 2035"
  //    and forced the customer to manually try each project. ~200-400 chars,
  //    negligible context cost.
  try {
    const xIndex = await getCrossProjectSizeIndex();
    if (xIndex) {
      if (parts.length) parts.push("");
      parts.push(
        "## OTHER PROJECTS' AVAILABLE SIZES (cross-reference index)\n" +
        "If the customer mentions a size that doesn't exist in the current project " +
        "but DOES exist in another project below, mention that and offer to send " +
        "that project's plan/details instead. NEVER claim a size doesn't exist when " +
        "another project has it.\n\n" +
        xIndex,
      );
    }
  } catch (err: any) {
    console.error(`[Webhook] Cross-project size-index fetch failed: ${err.message}`);
  }

  const combined = parts.join("\n").trim();
  // Trim to ~24 KB to keep prompt size reasonable (PDFs added headroom)
  return combined.length > 24000 ? combined.slice(0, 24000) + "\n... (truncated)" : combined;
}

// ── Fetch + format PDF extracts for a single project (Phase 6: Mongo) ─────
async function fetchPdfExtractsForProject(project: Project): Promise<string> {
  try {
    const { findExtractedDocsForProject } = await import("../_utils/project_documents");
    const rows = await findExtractedDocsForProject(project, 20);
    if (!rows.length) return "";

    // Group by doc_type — only keep latest extract per type (latest already first via order)
    const seen = new Set<string>();
    const blocks: string[] = [];
    for (const row of rows) {
      const key = row.doc_type + (row.size_label ? `:${row.size_label}` : "");
      if (seen.has(key)) continue;
      seen.add(key);
      const label = row.size_label ? `${row.doc_type} (${row.size_label})` : row.doc_type;
      const text = (row.text_extract || "").trim();
      if (!text) continue;
      // Cap each PDF's contribution at 3500 chars in the assembled context
      const snippet = text.length > 3500 ? text.slice(0, 3500) + "\n[...truncated]" : text;
      blocks.push(`### ${label.toUpperCase()}\n${snippet}`);
    }
    if (!blocks.length) return "";
    return [
      "## PDF DOCUMENT EXTRACTS (fallback when KB / inventory don't have an answer)",
      "When the customer asks something specific you can't find above, scan these for the answer before deferring.",
      "",
      ...blocks,
    ].join("\n");
  } catch (err: any) {
    console.error(`[Webhook] fetchPdfExtractsForProject failed: ${err.message}`);
    return "";
  }
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
  userProfileBlock: string;
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
    `<USER_PROFILE>`,
    opts.userProfileBlock,
    `</USER_PROFILE>`,
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

// ── Pending-doc fast-path helpers ────────────────────────────────────────
// Used to detect when the bot's previous turn was a size-disambiguation
// question and the customer is just answering with the size label. We
// short-circuit Gemini in that case and dispatch the PDF immediately.

/** Extract the most recent OUTBOUND (bot) message from formatted history.
 *  Looks for "Anandita: ..." or "Bot: ..." style lines (caller's format
 *  from getConversationContext). Returns "" if none found. */
function extractLastBotTurn(formattedHistory: string): string {
  if (!formattedHistory) return "";
  const lines = formattedHistory.split("\n").filter((l) => l.trim());
  // Walk from the end backward; the last bot line is the most recent
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    // Match "Anandita: ..." / "Bot: ..." / "Outbound: ..."
    const m = l.match(/^(Anandita|Bot|Outbound|Agent)\s*:\s*(.+)$/i);
    if (m) return m[2].trim();
  }
  return "";
}

/** True if the bot's last turn was asking the customer to pick a size /
 *  unit / floor plan / variant. Conservative — matches common phrasings
 *  used by Gemini and the Kimi unit_plan_dispatcher's clarification msg. */
function isClarificationAsk(botTurn: string): boolean {
  if (!botTurn) return false;
  const t = botTurn.toLowerCase();
  return (
    /\bwhich\s+(unit|size|tower|floor|variant|configuration|plan|one)/i.test(t) ||
    /\bwhich\s+would\s+you\s+like/i.test(t) ||
    /\bsizes?\s+available/i.test(t) ||
    /\bkaunsa\b/i.test(t) ||                      // Hinglish "which one"
    /\bkonsa\b/i.test(t) ||
    /\bmay i send/i.test(t) ||                    // "May I send the X?"
    /please\s+(let\s+me\s+know|specify|tell)/i.test(t) ||
    /\bplease\s+pick/i.test(t)
  );
}

/** True if customer's message LOOKS like a size selection — short, contains
 *  a unit-size signal (digits with sft/sq.ft, BHK, East/West/N/S, "ka bhejo"
 *  type). Errs on the side of false-positive only when message is short
 *  (<60 chars) so we don't fast-path complex multi-question replies. */
function looksLikeSizePick(message: string): boolean {
  if (!message || message.length > 60) return false;
  const m = message.toLowerCase();
  return (
    /\b\d{3,5}\s*(sft|sq\.?\s*ft|sqft)?\b/.test(m) ||                // 1695 / 2035 / 2520 sft
    /\b[1-5]\s*bhk\b/.test(m) ||                                       // 3BHK / 2 bhk
    /\b(east|west|north|south)(\s|$|-|\/|facing)/i.test(m) ||         // east, east-facing
    /\btower\s*[a-fA-F0-9]\b/.test(m) ||                               // Tower A
    /\b(1bhk|2bhk|3bhk|4bhk)\b/i.test(m) ||
    /\b(east|west|north|south)\s+(ka|wala|ki)\b/.test(m)               // "east ka bhejo"
  );
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
    // Flag dead senders so OTHER conversations / T=0 / cron don't try this
    // sender for the next hour. We don't switch sender mid-conversation
    // (would confuse the customer), so this reply itself still fails — but
    // future routes will skip the dead number.
    const lower = (text || "").toLowerCase();
    const looksDead =
      r.status === 401 ||
      lower.includes("unauthorized_error") ||
      (lower.includes("phone server") && lower.includes("switched off")) ||
      lower.includes("/phone/restart");
    if (looksDead) {
      try {
        const { markSenderDead } = await import("../_utils/ops_collections");
        await markSenderDead(sender);
        console.warn(`[Periskope] Inbound-reply sender ${sender} flagged dead (${r.status})`);
      } catch {}
    }
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

    // 1+2+3. Run Zoho lookup, conversation history fetch, AND user profile
    //         fetch in parallel — all independent, ~1.5-2s sequentially.
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
    const profileTask = getOrCreateProfile(phone);
    const [zohoResult, conversation, profileInitial] = await Promise.all([
      zohoTask,
      historyTask,
      profileTask,
    ]);
    const zohoToken = zohoResult.token;
    const leadDetails: LeadDetails | null = zohoResult.lead;
    let userProfile: UserProfile = profileInitial;
    console.log(
      `[Periskope Webhook] Profile loaded — funnel=${userProfile.funnel_stage} ` +
      `bot_enabled=${userProfile.bot_enabled} ` +
      `current_project=${userProfile.current_project || "(none)"} ` +
      `budget_cr=${userProfile.budget_cr ?? "(unknown)"} ` +
      `docs_sent=${userProfile.docs_sent.length}`,
    );

    // ── PER-PHONE KILL-SWITCH ──────────────────────────────────────────────
    // Operator can turn off the bot for any phone from the dashboard.
    // When bot_enabled=false we STILL log the inbound message so the chat
    // history stays complete, but skip Gemini + Periskope reply entirely.
    // No funnel updates, no doc dispatch — completely silent.
    //
    // Project resolution happens further down in the handler; for the
    // disabled path we tag the message with current_project from the
    // user_profile (if known from prior interactions). Good enough — the
    // bot isn't going to reason about it anyway.
    if (userProfile.bot_enabled === false) {
      console.log(`[Periskope Webhook] Bot disabled for ${phone} — logging inbound only, skipping reply`);
      try {
        const tagProject = (userProfile.current_project || userProfile.last_project || null) as Project | null;
        await saveMessage(phone, "inbound", message, sender, tagProject, null);
      } catch (err: any) {
        console.error(`[Periskope Webhook] inbound save failed (bot off): ${err.message}`);
      }
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: "bot_disabled_for_phone",
        phone,
      });
    }

    // PRD v1.0: every customer reply moves status to CF + global override
    // detection (site visit / not interested). Fire-and-forget so the
    // chatbot reply pipeline below is never blocked by state update.
    if (leadDetails) {
      try {
        const { handleChatbotReply } = await import("../_utils/prd_orchestrator");
        handleChatbotReply({
          zoho_lead_id: leadDetails.id,
          lead: leadDetails,
          customer_message: message,
        }).catch((err) => console.error(`[PRD] handleChatbotReply failed: ${err.message}`));
      } catch (err: any) {
        console.error(`[PRD] orchestrator import failed: ${err.message}`);
      }
    }

    // 3. Resolve project (regex on message > Zoho field > last asked).
    //    Gemini may also identify the project itself from its output;
    //    we'll override below if Gemini's project hint is more specific.
    let project = await resolveProject({
      message,
      zohoProject: leadDetails?.asblProject || null,
      phone,
    });
    console.log(`[Periskope Webhook] Initial project resolution: ${project || "(none)"}`);

    // 3b. PENDING-DOC FAST-PATH ──────────────────────────────────────────
    // If the LAST bot turn was a clarification question ("which unit plan
    // should I send?") and the customer's current message is a short
    // size-label answer ("1695 East", "2035 sft", "3BHK East"), bypass
    // Gemini entirely and run the unit-plan dispatcher directly. Why:
    // Gemini was treating the size-label answer as a fresh DOCUMENT_REQUEST
    // and re-asking "which one?" instead of acting on the disambiguation,
    // forcing the customer to repeat themselves 2-3 turns. This shortcut
    // delivers the PDF in one shot when the intent is unambiguous.
    let pendingDocHandled = false;
    let docSentEarly: { doc_type: string; url: string; source?: string } | null = null;
    if (project && conversation.formatted && conversation.formatted !== "no prior conversation") {
      const lastBotTurn = extractLastBotTurn(conversation.formatted);
      const askedForSize = isClarificationAsk(lastBotTurn);
      const looksLikeSizeAnswer = looksLikeSizePick(message);
      if (askedForSize && looksLikeSizeAnswer) {
        console.log(
          `[Periskope Webhook] Pending-doc fast-path triggered — last bot asked size, ` +
          `customer answered "${message.slice(0, 60)}"`,
        );
        try {
          const dispatch = await dispatchUnitPlan(message, project, "unit_plan");
          console.log(
            `[Periskope Webhook] Fast-path Kimi dispatch: decision=${dispatch.decision} ` +
            `conf=${dispatch.confidence.toFixed(2)} ms=${dispatch.ms}`,
          );
          if (dispatch.decision === "match" && dispatch.row) {
            // Send PDF + a short confirmation message, skip Gemini.
            // sender is already in scope from the outer handler (line ~680).
            const caption = `${project} unit plan as discussed.`;
            const ack = `Sending the ${project} ${dispatch.row.size_label || ""} unit plan now, Sir.`.replace(/\s+/g, " ").trim();
            await saveMessage(phone, "outbound", ack, sender, project);
            try { await sendReply(phone, sender, ack); } catch (err: any) {
              console.error(`[Periskope Webhook] fast-path ack send failed: ${err.message}`);
            }
            try {
              await sendDocViaPeriskope(phone, sender, dispatch.row.url, dispatch.row.filename, caption);
              docSentEarly = { doc_type: "unit_plan", url: dispatch.row.url, source: "fast-path" };
              pendingDocHandled = true;
              console.log(`[Periskope Webhook] Fast-path PDF delivered: ${dispatch.row.url}`);
            } catch (err: any) {
              console.error(`[Periskope Webhook] fast-path doc send failed: ${err.message}`);
            }
          }
          // For "ambiguous" / "no_match" / "fallback" decisions we DON'T
          // short-circuit — let Gemini handle it normally, since we don't
          // want to send the wrong PDF and Gemini might offer a smart
          // cross-project alternative thanks to the size index above.
        } catch (err: any) {
          console.error(`[Periskope Webhook] fast-path dispatch threw: ${err.message}`);
        }
      }
    }

    // If the fast-path delivered the PDF, also stamp Zoho intent and return
    // — saves a Gemini round-trip and the customer gets the PDF in ~6s
    // instead of 12-15s end-to-end.
    if (pendingDocHandled) {
      if (leadDetails && zohoToken) {
        try {
          await updateZohoIntent(leadDetails.id, "Document Sent", zohoToken);
        } catch (err: any) {
          console.error(`[Periskope Webhook] fast-path Zoho update failed: ${err.message}`);
        }
      }
      return res.status(200).json({
        success: true,
        phone,
        project,
        intent: "DOCUMENT_REQUEST",
        flags: ["pending_doc_resolved"],
        zohoIntent: "Document Sent",
        historyMessages: conversation.totalMessages,
        docSent: docSentEarly,
        delivered: true,
        fastPath: true,
      });
    }

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

    // 5a. OFFER_TIME_REMAINING — append urgency tier so the bot calibrates
    //     CTA tone. Skip on multi-project (no single offer to compute).
    if (!isMultiProject && project && project !== "LEGACY") {
      try {
        const offerInfo = await computeOfferTimeRemaining(project);
        const offerBlock = renderOfferUrgencyBlock(offerInfo);
        if (offerBlock) {
          projectContext += `\n\n${offerBlock}`;
          console.log(
            `[Periskope Webhook] OFFER_TIME_REMAINING injected — months=${offerInfo.months_remaining} ` +
            `tier=${offerInfo.urgency_tier}`,
          );
        }
      } catch (err: any) {
        console.error(`[Periskope Webhook] offer-time compute failed: ${err.message}`);
      }
    }

    // 5b. Factual grounding (Kimi K2) — when the customer asks a specific
    //     spec / dimension / RERA / charge question, Kimi reads uploaded PDF
    //     text_extracts and pulls the exact answer with a citation. We then
    //     inject it into PROJECT_CONTEXT as GROUND_TRUTH so Gemini quotes it
    //     verbatim instead of hallucinating from the loose KB summary.
    //
    //     Only fires when: project is resolved (single, not multi) AND the
    //     message matches a factual-question pattern. Best-effort — Kimi
    //     unavailable / not_found / low confidence → no injection, Gemini
    //     proceeds as before. Adds ~3-6s on factual questions only.
    if (project && !isMultiProject && isFactualQuestion(message)) {
      try {
        const grounded = await groundFactualQuestion(message, project);
        if (grounded?.found && grounded.confidence >= 0.6) {
          projectContext +=
            `\n\n## GROUND_TRUTH (verified from uploaded ${grounded.cite || "documents"})\n` +
            `When the customer's question is about this fact, quote the value below VERBATIM. ` +
            `Do NOT invent alternative numbers or specs.\n` +
            `\nFact: ${grounded.answer}\n` +
            `Confidence: ${grounded.confidence.toFixed(2)} | Source: ${grounded.cite || "uploaded PDFs"}\n`;
          console.log(
            `[Periskope Webhook] GROUND_TRUTH injected — "${grounded.answer.slice(0, 80)}…" ` +
            `cite=${grounded.cite} conf=${grounded.confidence} (${grounded.ms}ms)`,
          );
        } else if (grounded) {
          console.log(
            `[Periskope Webhook] Factual question detected but no ground truth found ` +
            `(confidence=${grounded.confidence}, ${grounded.ms}ms) — Gemini proceeding with KB only`,
          );
        }
      } catch (err: any) {
        console.error(`[Periskope Webhook] groundFactualQuestion threw: ${err.message}`);
      }
    }

    // 5. Build structured message — Gemini will classify + reply in one call.
    //    No <INTENT>/<FLAGS> blocks because Gemini decides those itself.
    //    Name fallback chain: Zoho first_+last_name, then Mongo user_profile.name,
    //    then Mongo user_profile.first_name. Defaults to empty (prompt then
    //    decides whether to say "Sir/Ma'am" via the persona rule).
    let customerName =
      [leadDetails?.firstName, leadDetails?.lastName].filter(Boolean).join(" ").trim();
    if (!customerName) {
      const profileName = String(userProfile?.name || "").trim();
      const profileFirst = String((userProfile as any)?.first_name || "").trim();
      customerName = profileName || profileFirst || "";
    }

    // Persist current_project hint into the profile BEFORE rendering it, so
    // the block the bot sees has the live resolution. setActiveProject is
    // a no-op when the project hasn't changed.
    userProfile = await setActiveProject(phone, userProfile, project);
    const userProfileBlock = renderUserProfileBlock(userProfile);

    const structuredMsg = buildStructuredMessage({
      customerName,
      phone,
      project,
      daysSinceLast: conversation.daysSinceLast,
      lastProject: conversation.lastProject,
      projectContext,
      history: conversation.formatted,
      userMessage: message,
      userProfileBlock,
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
      // BUG FIX 2026-06-18: previously hardcoded docToSend: null which meant
      // every Gemini failure silently dropped document requests, leaving the
      // bot promising "I'll send it" with no actual file fired. Now we
      // regex-extract the doc_type from the customer's message so DOCUMENT_
      // REQUEST intent still triggers a real send through the dispatcher.
      // Also pull size/facing flags so multi-slot docs (floor_plan, unit_plan)
      // get correctly disambiguated.
      const fallbackDocType = regexResult.intent === "DOCUMENT_REQUEST"
        ? extractDocTypeFromMessage(message)
        : null;
      // Crude size/facing/tower extraction for multi-slot lookups. These
      // mirror what Gemini would extract via its structured output. Tower
      // patterns cover common ASBL naming: "Tower 1", "T-1", "T1", "Wing A",
      // bare letter (A, B, C) in context. Without these, the strict lookup
      // would miss tower-specific PDFs and deflect to "let me confirm",
      // which sales reported as the "asked for X, bot stalled" bug.
      const sizeMatch = message.match(/\b(\d{3,4})\s*(?:sft|sqft|sq\.\s*ft)\b/i);
      const facingMatch = message.match(/\b(east|west|north|south)\b/i);
      const towerMatch =
        message.match(/\b(?:tower|t|wing|block)\s*[-_\s]?\s*([0-9A-Z])\b/i) ||
        message.match(/\b(?:tower|t|wing|block)\s+(one|two|three|four|five|six)\b/i);
      const towerWordToNum: Record<string, string> = {
        one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
      };
      const towerStr = towerMatch
        ? (towerWordToNum[towerMatch[1].toLowerCase()] || towerMatch[1].toUpperCase())
        : null;
      geminiOutput = {
        intent: regexResult.intent,
        flags: regexResult.flags,
        project: regexResult.project,
        docToSend: fallbackDocType,
        docMeta: {
          unit_size_sft: sizeMatch ? Number(sizeMatch[1]) : null,
          facing: facingMatch ? facingMatch[1].toLowerCase() : null,
          tower: towerStr,
        },
        extractedFacts: {},
        reply: fallbackReply,
      };
      if (fallbackDocType) {
        console.log(`[Periskope Webhook] Fallback regex-extracted docToSend=${fallbackDocType} (rescued from Gemini failure)`);
      }
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
      userProfile = await setActiveProject(phone, userProfile, project);
    }

    // 7b. Merge extracted_facts into user_profiles. Scalars overwrite if
    //     new value is non-null + different; arrays append+dedupe. The
    //     in-memory userProfile is updated so funnel checks below see fresh data.
    try {
      const delta = diffExtractedFacts(userProfile, geminiOutput.extractedFacts);
      if (Object.keys(delta).length > 0) {
        userProfile = await mergeProfile(phone, userProfile, delta);
        console.log(
          `[Periskope Webhook] Profile merged — fields=${Object.keys(delta).join(",")}`,
        );
      }
    } catch (err: any) {
      console.error(`[Periskope Webhook] profile merge failed: ${err.message}`);
    }

    // 7c. Funnel-stage advancement:
    //     - Every inbound → at least "engaged" (from "new")
    //     - Captured budget OR (size + timeline) → "qualified"
    //     - Site visit / negotiating / rejection get bumped by intent below
    //       OR by the doc-send block (brochure_sent / cost_sheet_sent).
    try {
      userProfile.funnel_stage = await advanceFunnel(
        phone,
        userProfile.funnel_stage,
        "INBOUND_MSG",
      );
      const qualifiedSignal = inferQualifiedSignal(userProfile);
      if (qualifiedSignal) {
        userProfile.funnel_stage = await advanceFunnel(
          phone,
          userProfile.funnel_stage,
          qualifiedSignal,
        );
      }
      if (classification.intent === "SITE_VISIT") {
        userProfile.funnel_stage = await advanceFunnel(
          phone,
          userProfile.funnel_stage,
          "SITE_VISIT_SCHEDULED",
        );
      } else if (classification.intent === "REJECTION") {
        userProfile.funnel_stage = await advanceFunnel(
          phone,
          userProfile.funnel_stage,
          "LOST",
        );
      } else if (classification.intent === "OBJECTION") {
        userProfile.funnel_stage = await advanceFunnel(
          phone,
          userProfile.funnel_stage,
          "NEGOTIATING",
        );
      }
    } catch (err: any) {
      console.error(`[Periskope Webhook] funnel advance failed: ${err.message}`);
    }

    // 8. Map fine-grained intent → Zoho's 6-value picklist (for analytics)
    const zohoIntent = mapIntentToZoho(classification.intent);

    // 9. Save inbound message with project + (Zoho-mapped) intent tags
    await saveMessage(phone, "inbound", message, sender, project, zohoIntent);

    // Strip mid-conversation re-introduction prefixes ("Hi Shivank, picking
    // up on Loft —") that Gemini emits despite the prompt forbidding them.
    // hasHistory is true when there's at least one prior Anandita reply in
    // CONVERSATION_HISTORY — formatted by conversation_context.ts as "you: ..."
    const hasHistory =
      conversation.totalMessages > 0 &&
      /\byou:\s/.test(conversation.formatted || "");
    let reply = stripReintroduction(sanitizeReply(geminiOutput.reply), hasHistory);
    console.log(`[Periskope Webhook] Gemini reply (sanitized, history=${hasHistory}): ${reply.slice(0, 120)}`);

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

    // 12. Auto-deliver document — v5 STRICT FLOW.
    //
    //   (a) Bot must set doc_to_send + (for multi-slot types) doc_meta.
    //   (b) Strict equality lookup against project_documents on
    //       (project, doc_type, unit_size_sft, facing, tower).
    //   (c) Pre-send validator: extract sizes from reply text, compare
    //       to doc_meta and filename. BLOCK if mismatch.
    //   (d) Every send (passed / blocked / errored) gets structured-logged
    //       to doc_send_log for audit.
    //
    //   The previous Kimi-based fuzzy dispatcher is GONE — strict lookup
    //   + LLM-supplied meta is the v5 contract. Legacy fuzzy lookup is
    //   retained only as a fallback when strict returns NOT_FOUND on a
    //   single-slot doc type (e.g. brochure has no meta to match on).
    type DocSendInfo = { doc_type: string; url: string; source?: string };
    let docSent: DocSendInfo | null = null;
    let docBlocked: { reason: string } | null = null;
    const isDocRequest = geminiOutput.docToSend !== null;

    if (project && isDocRequest) {
      const docTypeFromMsg = geminiOutput.docToSend!;
      const docMeta = geminiOutput.docMeta;
      const isMultiSlot =
        docTypeFromMsg === "unit_plan"  ||
        docTypeFromMsg === "floor_plan" ||
        docTypeFromMsg === "price_sheet";
      // Flag flipped to true when SEND-ALL handled the request — the strict
      // single-doc lookup below then no-ops so we don't double-send.
      let sendAllAlreadyHandled = false;

      // SEND-ALL-VARIANTS detection: when customer asks for "all", "saare",
      // "har tower", "4 towers", "every variant" etc. of a multi-slot doc
      // type, send each variant as a separate Periskope file instead of
      // asking "which one?" QA bug 2026-06-19: customer asked for "Spectra
      // ke 4 towers ka floor plan" and bot asked for clarification instead
      // of just sending all 4. Cap at 8 sends per request to prevent abuse.
      // SEND-ALL detector — narrow regex so it only fires on EXPLICIT
      // multi-variant intent, not on phrases like "all amenities" or
      // "tell me about each project". Requires:
      //   (a) an "all" quantifier AND a multi-variant noun (towers / sizes
      //        / variants / options / wings / all of them), OR
      //   (b) a numeric quantity + multi-variant noun ("4 towers", "3 sizes").
      // Common false-positive examples now BLOCKED:
      //   "Tell me about each project" — "each" alone without towers/sizes
      //   "all amenities info" — "all" + amenities noun (amenities is single-slot)
      const ALL_QUANTIFIER = /\b(all|saare|saari|sari|har|sab|sare|every|each|all\s+of\s+them)\b/i;
      const VARIANT_NOUN = /\b(towers?|sizes?|variants?|options?|units?|wings?|configurations?|configs?|layouts?)\b/i;
      const NUMERIC_VARIANTS = /\b(\d+|do|teen|char|paanch|six|saat|aath)\s+(towers?|sizes?|variants?|options?|units?|wings?|configurations?|configs?|layouts?)\b/i;
      const wantsAllVariants = isMultiSlot && (
        (ALL_QUANTIFIER.test(message) && VARIANT_NOUN.test(message)) ||
        NUMERIC_VARIANTS.test(message)
      );
      if (wantsAllVariants) {
        // Route through the unified sendDocumentTool — same code path as
        // the admin send-doc-test endpoint + any future caller, so dead-
        // sender fallback / logging / caption format / cap are uniform.
        const { sendDocumentTool } = await import("../_utils/doc_send_tool");
        const toolResult = await sendDocumentTool({
          request: {
            project,
            doc_type: docTypeFromMsg,
            send_all_variants: true,
          },
          phone,
          sender,
        });

        const docLabelMap: Record<string, string> = {
          floor_plan: "floor plan",
          unit_plan: "unit plan",
          price_sheet: "price sheet",
        };
        const docLabel = docLabelMap[docTypeFromMsg] || docTypeFromMsg;

        if (toolResult.outcome === "SEND" && toolResult.sent_count > 0) {
          // Build a single ack message AFTER the dispatcher already shipped
          // the PDFs (so customer first sees the files, then "sharing all
          // 4 now"). The order looks more natural that way.
          const ack = `Sharing all ${toolResult.sent_count} ${docLabel}${toolResult.sent_count > 1 ? "s" : ""} for ${project} now.${toolResult.sent_count < toolResult.variants_sent.length ? " (Some still on the way.)" : ""}`;
          await saveMessage(phone, "outbound", ack, sender, project);
          try {
            await sendReply(phone, sender, ack);
          } catch (err: any) {
            console.error(`[Periskope Webhook] all-variants ack send failed: ${err.message}`);
          }
          console.log(`[Periskope Webhook] SEND-ALL-TOOL fired — ${toolResult.sent_count}/${toolResult.variants_sent.length} ${docTypeFromMsg} variants sent to ${phone} (lookup ${toolResult.ms.lookup}ms send ${toolResult.ms.send}ms)`);
          docSent = { doc_type: docTypeFromMsg, url: "(multiple)", source: "send-all-tool" };
          reply = ack;
          sendAllAlreadyHandled = true;
        } else if (toolResult.outcome === "NOT_FOUND") {
          // No rows → let downstream strict-lookup emit "no docs available".
          console.log(`[Periskope Webhook] SEND-ALL via tool: NOT_FOUND for ${project}/${docTypeFromMsg}`);
        } else {
          // ERROR — surface a casual deflection. Downstream strict lookup
          // would also fail so just skip it.
          const deflection = `Trying to send the ${docLabel}s for ${project} but the system is being slow. Lemme retry in a couple mins.`;
          await saveMessage(phone, "outbound", deflection, sender, project);
          try { await sendReply(phone, sender, deflection); } catch {}
          console.error(`[Periskope Webhook] SEND-ALL via tool: ERROR ${toolResult.error}`);
          reply = deflection;
          sendAllAlreadyHandled = true;
        }
      }

      // sendAllAlreadyHandled — skip strict lookup if SEND-ALL just fired
      // and shipped multiple PDFs. Otherwise we'd send a duplicate single
      // doc on top of the bulk send.
      try {
        if (sendAllAlreadyHandled) {
          throw new Error("__SKIP_STRICT_LOOKUP__");
        }
        const strictResult = await getDocumentStrict({
          project,
          docType: docTypeFromMsg,
          unit_size_sft: docMeta.unit_size_sft,
          facing: docMeta.facing,
          tower: docMeta.tower,
        });

        if (strictResult.ok) {
          const doc = strictResult.doc;

          // Pre-send VALIDATOR — verbal mention in reply must match doc_meta + filename
          const validation = validateDocSend(reply, docMeta, doc.filename);
          if (!validation.ok) {
            // Block the doc; send a safe verbal fallback instead.
            console.warn(
              `[Periskope Webhook] DOC BLOCKED — ${validation.reason} (file=${doc.filename})`,
            );
            await logDocSend({
              phone,
              project,
              doc_type: docTypeFromMsg,
              doc_meta: docMeta,
              matched_url: doc.url,
              matched_file: doc.filename,
              reply_text: reply,
              outcome: "blocked_mismatch",
              block_reason: validation.reason,
              sizes_in_reply: validation.sizes_in_reply,
            });
            await saveMessage(phone, "outbound", SAFE_FALLBACK_REPLY, sender, project);
            try {
              await sendReply(phone, sender, SAFE_FALLBACK_REPLY);
            } catch (err: any) {
              console.error(`[Periskope Webhook] blocked-fallback send failed: ${err.message}`);
            }
            docBlocked = { reason: validation.reason };
          } else {
            // Validation passed → send the PDF
            const captionMap: Record<string, string> = {
              brochure: `${project} brochure as discussed.`,
              price_sheet: `${project} price sheet as discussed.`,
              specifications: `${project} specifications as discussed.`,
              master_plan: `${project} master plan as discussed.`,
              tower_plan: `${project} tower plan as discussed.`,
              floor_plan: `${project} floor plan as discussed.`,
              payment_structure: `${project} payment structure as discussed.`,
              amenities: `${project} amenities sheet as discussed.`,
              unit_plan: `${project} unit plan as discussed.`,
            };
            const caption = captionMap[doc.doc_type] || `${project} ${doc.doc_type} as discussed.`;

            try {
              await sendDocViaPeriskope(phone, sender, doc.url, doc.filename, caption);
              docSent = { doc_type: doc.doc_type, url: doc.url, source: doc.source };
              console.log(
                `[Periskope Webhook] Doc sent STRICT (source=${doc.source}): ` +
                `${doc.doc_type} meta=${JSON.stringify(docMeta)} → ${doc.url}`,
              );

              // Log + advance funnel + track in user_profiles.docs_sent
              await logDocSend({
                phone,
                project,
                doc_type: docTypeFromMsg,
                doc_meta: docMeta,
                matched_url: doc.url,
                matched_file: doc.filename,
                reply_text: reply,
                outcome: "sent",
                block_reason: null,
                sizes_in_reply: validation.sizes_in_reply,
              });

              userProfile.docs_sent = await appendDocSent(
                phone,
                docTypeFromMsg,
                docMeta,
                userProfile.docs_sent,
              );

              if (docTypeFromMsg === "brochure") {
                userProfile.funnel_stage = await advanceFunnel(
                  phone,
                  userProfile.funnel_stage,
                  "DOC_BROCHURE_SENT",
                );
              } else if (docTypeFromMsg === "price_sheet") {
                userProfile.funnel_stage = await advanceFunnel(
                  phone,
                  userProfile.funnel_stage,
                  "DOC_PRICE_SHEET_SENT",
                );
              }
            } catch (err: any) {
              console.error(`[Periskope Webhook] doc send error: ${err.message}`);
              await logDocSend({
                phone,
                project,
                doc_type: docTypeFromMsg,
                doc_meta: docMeta,
                matched_url: doc.url,
                matched_file: doc.filename,
                reply_text: reply,
                outcome: "error",
                block_reason: err.message,
                sizes_in_reply: validation.sizes_in_reply,
              });
            }
          }
        } else if (strictResult.reason === "NOT_FOUND") {
          // No exact match. For multi-slot docs, surface the available options
          // and ask the customer to pick. For single-slot docs (no meta to
          // match on), try the legacy fuzzy lookup as a last resort — the
          // existing brochure / master-plan tables predate strict columns.
          if (isMultiSlot) {
            const labels = await listAvailableMetaLabels(project, docTypeFromMsg);
            if (labels.length) {
              // buildClarificationMessage signature is options: string[]. We
              // used to wrap each label into { size_label } and the template
              // literal rendered "[object Object]" — fixed 2026-06-18 by
              // passing plain strings as the signature actually wants.
              const clarif = buildClarificationMessage(
                project,
                docTypeFromMsg as any,
                labels,
              );
              await saveMessage(phone, "outbound", clarif, sender, project);
              try {
                await sendReply(phone, sender, clarif);
                console.log(
                  `[Periskope Webhook] STRICT NOT_FOUND — sent clarification with ` +
                  `${labels.length} available options`,
                );
              } catch (err: any) {
                console.error(`[Periskope Webhook] clarification send failed: ${err.message}`);
              }
              await logDocSend({
                phone,
                project,
                doc_type: docTypeFromMsg,
                doc_meta: docMeta,
                matched_url: null,
                matched_file: null,
                reply_text: reply,
                outcome: "blocked_not_found",
                block_reason: `no row matches meta; offered ${labels.length} alternatives`,
                sizes_in_reply: [],
              });
            } else {
              // No PDFs uploaded for this doc_type yet → honest deflection
              await saveMessage(phone, "outbound", SAFE_FALLBACK_REPLY, sender, project);
              try {
                await sendReply(phone, sender, SAFE_FALLBACK_REPLY);
              } catch (err: any) {
                console.error(`[Periskope Webhook] not-found fallback failed: ${err.message}`);
              }
              await logDocSend({
                phone,
                project,
                doc_type: docTypeFromMsg,
                doc_meta: docMeta,
                matched_url: null,
                matched_file: null,
                reply_text: reply,
                outcome: "blocked_not_found",
                block_reason: "no PDFs uploaded for this doc_type",
                sizes_in_reply: [],
              });
            }
          } else {
            // Single-slot legacy fallback
            const legacy = await getDocumentFor(project, docTypeFromMsg, null);
            if (legacy) {
              const validation = validateDocSend(reply, docMeta, legacy.filename);
              if (validation.ok) {
                const captionMap: Record<string, string> = {
                  brochure: `${project} brochure as discussed.`,
                  master_plan: `${project} master plan as discussed.`,
                  payment_structure: `${project} payment structure as discussed.`,
                  amenities: `${project} amenities sheet as discussed.`,
                  specifications: `${project} specifications as discussed.`,
                };
                const caption = captionMap[legacy.doc_type] || `${project} ${legacy.doc_type} as discussed.`;
                await sendDocViaPeriskope(phone, sender, legacy.url, legacy.filename, caption);
                docSent = { doc_type: legacy.doc_type, url: legacy.url, source: `legacy:${legacy.source}` };
                console.log(`[Periskope Webhook] Doc sent LEGACY (source=${legacy.source}): ${legacy.doc_type} → ${legacy.url}`);
                await logDocSend({
                  phone,
                  project,
                  doc_type: docTypeFromMsg,
                  doc_meta: docMeta,
                  matched_url: legacy.url,
                  matched_file: legacy.filename,
                  reply_text: reply,
                  outcome: "sent",
                  block_reason: null,
                  sizes_in_reply: validation.sizes_in_reply,
                });
                if (docTypeFromMsg === "brochure") {
                  userProfile.funnel_stage = await advanceFunnel(phone, userProfile.funnel_stage, "DOC_BROCHURE_SENT");
                }
              } else {
                console.warn(`[Periskope Webhook] legacy doc found but validator blocked: ${validation.reason}`);
                await saveMessage(phone, "outbound", SAFE_FALLBACK_REPLY, sender, project);
                try { await sendReply(phone, sender, SAFE_FALLBACK_REPLY); } catch {}
                await logDocSend({
                  phone,
                  project,
                  doc_type: docTypeFromMsg,
                  doc_meta: docMeta,
                  matched_url: legacy.url,
                  matched_file: legacy.filename,
                  reply_text: reply,
                  outcome: "blocked_mismatch",
                  block_reason: validation.reason,
                  sizes_in_reply: validation.sizes_in_reply,
                });
                docBlocked = { reason: validation.reason };
              }
            } else {
              await saveMessage(phone, "outbound", SAFE_FALLBACK_REPLY, sender, project);
              try { await sendReply(phone, sender, SAFE_FALLBACK_REPLY); } catch {}
              await logDocSend({
                phone,
                project,
                doc_type: docTypeFromMsg,
                doc_meta: docMeta,
                matched_url: null,
                matched_file: null,
                reply_text: reply,
                outcome: "blocked_not_found",
                block_reason: "strict + legacy both empty",
                sizes_in_reply: [],
              });
            }
          }
        } else if (strictResult.reason === "AMBIGUOUS") {
          // Multiple rows matched the bot's full meta — unusual; ask customer
          // to pick. Most often this fires because the schema upload has
          // duplicate rows; we still respond gracefully.
          const labels = (strictResult.candidates || []).map((c) => {
            const parts: string[] = [];
            if (c.unit_size_sft) parts.push(`${c.unit_size_sft} sft`);
            if (c.facing) parts.push(String(c.facing));
            if (c.tower) parts.push(`Tower ${c.tower}`);
            return parts.length ? parts.join(" ") : (c.size_label || "");
          }).filter(Boolean);
          const clarif = labels.length
            ? buildClarificationMessage(project, docTypeFromMsg as any, labels)
            : SAFE_FALLBACK_REPLY;
          await saveMessage(phone, "outbound", clarif, sender, project);
          try { await sendReply(phone, sender, clarif); } catch {}
          await logDocSend({
            phone,
            project,
            doc_type: docTypeFromMsg,
            doc_meta: docMeta,
            matched_url: null,
            matched_file: null,
            reply_text: reply,
            outcome: "blocked_mismatch",
            block_reason: `AMBIGUOUS: ${strictResult.details}`,
            sizes_in_reply: [],
          });
        } else {
          // ERROR
          console.error(`[Periskope Webhook] strict lookup ERROR: ${strictResult.details}`);
          await logDocSend({
            phone,
            project,
            doc_type: docTypeFromMsg,
            doc_meta: docMeta,
            matched_url: null,
            matched_file: null,
            reply_text: reply,
            outcome: "error",
            block_reason: strictResult.details || "unknown",
            sizes_in_reply: [],
          });
        }
      } catch (err: any) {
        // Sentinel from the strict-lookup-skip path — not a real error,
        // just signals SEND-ALL already shipped the docs. Swallow silently.
        if (err && err.message === "__SKIP_STRICT_LOOKUP__") {
          console.log(`[Periskope Webhook] Strict lookup skipped — SEND-ALL handled ${docTypeFromMsg}`);
        } else {
          console.error(`[Periskope Webhook] doc routing threw: ${err.message}`);
        await logDocSend({
          phone,
          project,
          doc_type: docTypeFromMsg,
          doc_meta: docMeta,
          matched_url: null,
          matched_file: null,
          reply_text: reply,
          outcome: "error",
          block_reason: err.message,
          sizes_in_reply: [],
        });
        }
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

    // 13b. If customer asked for callback ("call me" intent), trigger an
    // in-house voice-bot call immediately. Throttled to 1/30min per lead.
    // bot_enabled=false leads have already returned early at step ~7, so
    // by reaching here the bot is enabled for this phone.
    if (leadDetails && zohoToken && zohoIntent === "call_me") {
      const fullName =
        [leadDetails.firstName, leadDetails.lastName].filter(Boolean).join(" ").trim() ||
        "Sir/Ma'am";
      try {
        const callRes = await triggerCallbackCall(
          leadDetails.id,
          phone,
          fullName,
          leadDetails.asblProject,
          zohoToken,
        );
        if (callRes.ok) {
          console.log(
            `[Periskope Webhook] ✓ Callback call triggered for ${phone} (lead ${leadDetails.id})`,
          );
        } else {
          console.log(
            `[Periskope Webhook] ✗ Callback call skipped for ${phone}: ${callRes.reason}`,
          );
        }
      } catch (err: any) {
        console.error(
          `[Periskope Webhook] Callback call threw for ${phone}: ${err.message}`,
        );
      }
    }

    return res.status(200).json({
      success: true,
      phone,
      project,
      intent: classification.intent,
      flags: classification.flags,
      zohoIntent,
      funnelStage: userProfile.funnel_stage,
      historyMessages: conversation.totalMessages,
      docSent,
      docBlocked,
      delivered: sendOk,
    });

  } catch (err: any) {
    console.error("[Periskope Webhook] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
