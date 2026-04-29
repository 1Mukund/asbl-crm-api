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
import { getConversationContext } from "../_utils/conversation_context";
import { sanitizeReply } from "../_utils/sanitizer";
import { getDocumentFor, sendDocViaPeriskope } from "../_utils/document_dispatcher";

const PERISKOPE_API_KEY = process.env.PERISKOPE_API_KEY || "";
const PERISKOPE_API_URL = "https://api.periskope.app/v1/messages/send";
const ANANDITA_URL      = process.env.ANANDITA_URL || "http://35.154.144.37:8080/api/chat/anandita_rm/";
const ANANDITA_API_KEY  = process.env.ANANDITA_API_KEY || "asbl_dccd9fea5d2fe188f5518574354e8fd805f0fd0a507926139fee0f1ae2ff07b1";
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

// ── Intent classification via LLM (best-effort, regex fallback) ──────────────
async function classifyIntent(message: string): Promise<string> {
  const VALID_INTENTS = ["site_visit", "virtual_tour", "not_interested", "price", "brochure", "call_me", "general"];
  const lower = message.toLowerCase();

  // Quick regex pass for obvious intents
  if (/\b(price|cost|emi|loan|kimat|kimmat|kitn[ae]|pricing|kharcha)\b/.test(lower)) return "price";
  if (/\b(brochure|pdf|floor plan|floorplan|details send|details bhej|brochure send)\b/.test(lower)) return "brochure";
  if (/\b(call me|callback|call back|phone|call|baat kar|call kar|kar lo)\b/.test(lower)) return "call_me";
  if (/\b(site visit|visit|see project|aana|aaunga|aaungi|come|aata|aati|location)\b/.test(lower)) return "site_visit";
  if (/\b(virtual tour|video call|virtual)\b/.test(lower)) return "virtual_tour";
  if (/\b(not interested|nahi chahiye|nahin chahiye|no thanks|stop|band)\b/.test(lower)) return "not_interested";

  // Fallback: ask Anandita as classifier (it might break with new prompt — graceful default)
  try {
    const classificationPrompt = `Classify this customer message into ONE of: site_visit, virtual_tour, not_interested, price, brochure, call_me, general. Reply with ONLY the label.\n\nMessage: "${message.replace(/"/g, "'")}"`;
    const r = await fetch(ANANDITA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ANANDITA_API_KEY}`,
      },
      body: JSON.stringify({
        phone: "+910000000001", // dedicated classifier phone (no history)
        message: classificationPrompt,
      }),
    });
    if (!r.ok) return "general";
    const data = (await r.json()) as any;
    const raw = (data?.message || "").toLowerCase();
    for (const intent of VALID_INTENTS) {
      if (raw.includes(intent)) return intent;
    }
  } catch { /* fall through */ }

  return "general";
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

// ── Resolve project context text from manually-curated project_facts ──────
async function getProjectContextText(project: Project | null): Promise<string> {
  if (!project) return "no specific project resolved";
  if (project === "LEGACY") return LEGACY_TEASER;

  const facts = await getProjectFacts(project);
  if (facts && facts.facts_text && facts.facts_text.trim().length > 0) {
    // Trim to ~16 KB so the prompt stays a manageable size
    const text = facts.facts_text.trim();
    return text.length > 16000 ? text.slice(0, 16000) + "\n... (content truncated)" : text;
  }

  return `No knowledge base uploaded for ${project} yet. Please tell the customer you'll have a sales executive share the details shortly.`;
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

  // 2. Wait 10 seconds (human-like delay)
  await new Promise(resolve => setTimeout(resolve, 10000));

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

    // 2. Resolve project (message > Zoho > last asked)
    const project = await resolveProject({
      message,
      zohoProject: leadDetails?.asblProject || null,
      phone,
    });
    console.log(`[Periskope Webhook] Resolved project: ${project || "(none)"}`);

    // 3. Fetch in parallel: site content + conversation history + intent
    const [projectContext, conversation, intent] = await Promise.all([
      getProjectContextText(project),
      getConversationContext(phone),
      classifyIntent(message),
    ]);
    console.log(`[Periskope Webhook] Intent: ${intent} | history: ${conversation.totalMessages} msgs | days since last: ${conversation.daysSinceLast}`);

    // 4. Save inbound message with project + intent tags
    await saveMessage(phone, "inbound", message, sender, project, intent);

    // 5. Build structured message
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
    });

    // 6. Call Anandita + sanitize reply
    const rawReply = await callAnandita(phone, structuredMsg);
    const reply = sanitizeReply(rawReply);
    console.log(`[Periskope Webhook] Anandita reply (sanitized): ${reply.slice(0, 100)}`);

    // 7. Send text reply via Periskope
    await sendReply(phone, sender, reply);

    // 7b. If intent calls for a doc (brochure/price) and we have one cached, send it too
    let docSent: { doc_type: string; url: string } | null = null;
    if (project && (intent === "brochure" || intent === "price")) {
      try {
        const doc = await getDocumentFor(project, intent);
        if (doc) {
          const caption = intent === "brochure"
            ? `${project} brochure as discussed.`
            : `${project} price sheet as discussed.`;
          await sendDocViaPeriskope(phone, sender, doc.url, doc.filename, caption);
          docSent = { doc_type: doc.doc_type, url: doc.url };
          console.log(`[Periskope Webhook] Doc sent: ${doc.doc_type} → ${doc.url}`);
        } else {
          console.log(`[Periskope Webhook] No ${intent} doc cached for ${project}`);
        }
      } catch (err: any) {
        console.error(`[Periskope Webhook] Doc send failed: ${err.message}`);
      }
    }

    // 8. Save outbound reply (tag with same project for analytics continuity)
    await saveMessage(phone, "outbound", reply, sender, project);

    // 9. Update Zoho: Last_Intent + Whatsapp_Replied
    if (leadDetails && zohoToken) {
      try {
        await updateZohoIntent(leadDetails.id, intent, zohoToken);
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
      intent,
      historyMessages: conversation.totalMessages,
      docSent,
    });

  } catch (err: any) {
    console.error("[Periskope Webhook] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
