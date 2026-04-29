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
import { resolveProject, Project } from "../_utils/project_detection";
import { getProjectFacts } from "../_utils/project_facts";
import { getInventoryForProject } from "../_utils/inventory_sheet";
import { getConversationContext } from "../_utils/conversation_context";
import { sanitizeReply } from "../_utils/sanitizer";
import { getDocumentFor, sendDocViaPeriskope } from "../_utils/document_dispatcher";

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

// ── Zoho: Get access token ────────────────────────────────────────────────────
async function getZohoToken(): Promise<string> {
  const r = await fetch(
    `https://accounts.zoho.in/oauth/v2/token?grant_type=refresh_token&client_id=${ZOHO_CLIENT_ID}&client_secret=${ZOHO_CLIENT_SECRET}&refresh_token=${ZOHO_REFRESH_TOKEN}`,
    { method: "POST" }
  );
  const data = await r.json() as any;
  if (!data.access_token) throw new Error("Zoho token error: " + JSON.stringify(data));
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

  const parts: string[] = [];

  // 1. Manual project notes (from dashboard's Edit KB form, if any)
  const facts = await getProjectFacts(project);
  if (facts?.facts_text?.trim()) {
    parts.push("## PROJECT NOTES (manually curated)");
    parts.push(facts.facts_text.trim());
  }

  // 2. Live inventory + pricing from the master Google Sheet
  try {
    const inv = await getInventoryForProject(project);
    if (inv.markdown) {
      parts.push("");
      parts.push("## CURRENT INVENTORY & PRICING");
      parts.push(inv.markdown);
    }
  } catch (err: any) {
    console.error(`[Webhook] Inventory fetch failed: ${err.message}`);
  }

  if (parts.length === 0) {
    return `No knowledge base or inventory available for ${project} yet. Tell the customer you'll have a sales executive revert with details.`;
  }

  const combined = parts.join("\n").trim();
  // Trim to ~18 KB to keep prompt size reasonable
  return combined.length > 18000 ? combined.slice(0, 18000) + "\n... (truncated)" : combined;
}

// ── Build structured message for the LLM ─────────────────────────────────────
function buildStructuredMessage(opts: {
  customerName: string;
  phone: string;
  project: Project | null;
  daysSinceLast: number | null;
  lastProject: string | null;
  projectContext: string;
  history: string;
  userMessage: string;
  intent: string;
  flags: string[];
}): string {
  const lastProjectTag = opts.lastProject || "none";
  const daysTag = opts.daysSinceLast === null ? "first time" : String(opts.daysSinceLast);
  const currentProjectTag = opts.project || "not specified";
  const flagsTag = opts.flags.length > 0 ? opts.flags.join(", ") : "(none)";

  return [
    `<CUSTOMER>`,
    `Name: ${opts.customerName || "(not provided)"}`,
    `Phone: ${opts.phone}`,
    `Last asked project: ${lastProjectTag}`,
    `Currently asking about project: ${currentProjectTag}`,
    `Days since last interaction: ${daysTag}`,
    `</CUSTOMER>`,
    ``,
    `<INTENT>${opts.intent}</INTENT>`,
    `<FLAGS>${flagsTag}</FLAGS>`,
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

// ── Call Anandita LLM ─────────────────────────────────────────────────────────
async function callAnandita(phone: string, message: string): Promise<string> {
  const r = await fetch(ANANDITA_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${ANANDITA_API_KEY}`,
    },
    body: JSON.stringify({ phone: `+${phone}`, message }),
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Anandita error ${r.status}: ${err}`);
  }

  const data = await r.json() as any;
  const reply: string = data?.message || data?.reply || "";
  if (!reply.trim()) throw new Error("Anandita returned empty reply");
  return reply.trim();
}

// ── Send via Periskope with typing delay ──────────────────────────────────────
async function sendReply(phone: string, sender: string, message: string): Promise<void> {
  // 1. Send typing indicator
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

  // 2. Short human-like pause (3s — long enough to feel natural, short
  //    enough that a fast follow-up customer message doesn't race past us)
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 3. Send actual message
  const r = await fetch(PERISKOPE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${PERISKOPE_API_KEY}`,
      "x-phone":       sender,
    },
    body: JSON.stringify({ chat_id: phone, message }),
  });

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

    // 1. Zoho lookup (name + ASBL_Project) — best-effort, parallel with rest
    let leadDetails: LeadDetails | null = null;
    let zohoToken = "";
    try {
      zohoToken = await getZohoToken();
      leadDetails = await findLeadDetailsByPhone(phone, zohoToken);
    } catch (err: any) {
      console.error(`[Periskope Webhook] Zoho lookup failed: ${err.message}`);
    }

    // 2. Fetch conversation history first (needed for classifier context)
    const conversation = await getConversationContext(phone);
    const last3 = lastNHistoryLines(conversation.formatted, 3);

    // 3. Run intent classifier (gets project hint) in parallel with regex-based fallback
    const classification = await classifyIntentLLM(message, last3);
    console.log(
      `[Periskope Webhook] Intent: ${classification.intent} | flags: ${classification.flags.join(",") || "(none)"} | project hint: ${classification.project || "(none)"}`
    );

    // 4. Resolve project: classifier hint > regex on message > Zoho lead > last asked
    const projectFromClassifier = projectHintToProject(classification.project);
    const project =
      projectFromClassifier ||
      (await resolveProject({
        message,
        zohoProject: leadDetails?.asblProject || null,
        phone,
      }));
    console.log(`[Periskope Webhook] Resolved project: ${project || "(none)"}`);

    // 5. Fetch project context (KB + live inventory)
    const projectContext = await getProjectContextText(project);
    console.log(`[Periskope Webhook] history: ${conversation.totalMessages} msgs | days since last: ${conversation.daysSinceLast}`);

    // 6. Map fine-grained intent → Zoho's 6-value picklist (for analytics)
    const zohoIntent = mapIntentToZoho(classification.intent);

    // 7. Save inbound message with project + (Zoho-mapped) intent tags
    await saveMessage(phone, "inbound", message, sender, project, zohoIntent);

    // 8. Build structured message — pass classifier intent + flags to main agent
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
      intent: classification.intent,
      flags: classification.flags,
    });

    // 9. Call Anandita main agent + sanitize reply
    const rawReply = await callAnandita(phone, structuredMsg);
    const reply = sanitizeReply(rawReply);
    console.log(`[Periskope Webhook] Anandita reply (sanitized): ${reply.slice(0, 100)}`);

    // 10. Save outbound IMMEDIATELY so a fast follow-up message from the
    //     customer sees the bot's reply in CONVERSATION_HISTORY, even if
    //     Periskope's typing-indicator delay hasn't fired the actual send yet.
    await saveMessage(phone, "outbound", reply, sender, project);

    // 11. Send text reply via Periskope (3s typing delay inside)
    await sendReply(phone, sender, reply);

    // 12. Auto-deliver document via Periskope when classifier signals a doc-type intent
    let docSent: { doc_type: string; url: string } | null = null;
    if (project && (classification.intent === "DOCUMENT_REQUEST" || zohoIntent === "brochure" || zohoIntent === "price")) {
      try {
        // Map fine-grained intent → doc_type lookup (brochure / price_sheet)
        const docType = classification.intent === "DOCUMENT_REQUEST" ? "brochure" : zohoIntent;
        const doc = await getDocumentFor(project, docType);
        if (doc) {
          const caption = `${project} ${doc.doc_type} as discussed.`;
          await sendDocViaPeriskope(phone, sender, doc.url, doc.filename, caption);
          docSent = { doc_type: doc.doc_type, url: doc.url };
          console.log(`[Periskope Webhook] Doc sent: ${doc.doc_type} → ${doc.url}`);
        } else {
          console.log(`[Periskope Webhook] No ${docType} doc cached for ${project}`);
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
    });

  } catch (err: any) {
    console.error("[Periskope Webhook] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
