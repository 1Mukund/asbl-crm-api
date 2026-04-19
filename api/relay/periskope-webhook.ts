/**
 * Periskope → Anandita LLM → Periskope reply handler
 *
 * Flow:
 *   1. Customer replies on WhatsApp
 *   2. Periskope fires webhook here (event_type: "message.created")
 *   3. Filter inbound messages only
 *   4. Detect intent from customer message
 *   5. Call Anandita LLM for reply
 *   6. Send reply via Periskope
 *   7. Update Zoho: Last_Intent (triggers Workflow → Blueprint stage change)
 *
 * Webhook URL: https://asbl-crm-api.vercel.app/api/relay/periskope-webhook
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

const PERISKOPE_API_KEY = process.env.PERISKOPE_API_KEY || "";
const PERISKOPE_API_URL = "https://api.periskope.app/v1/messages/send";
const ANANDITA_URL      = process.env.ANANDITA_URL || "http://35.154.144.37:8080/api/chat/";
const ANANDITA_API_KEY  = process.env.ANANDITA_API_KEY || "asbl_9b9b6b7ff1f758be40aca7ceb03d7d0d9c57d788b4457d5ca5819620b25d146a";
const SUPABASE_URL      = process.env.SUPABASE_URL || "";
const SUPABASE_KEY      = process.env.SUPABASE_SECRET_KEY || "";
const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID || "";
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || "";
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || "";
const ZOHO_API_BASE      = "https://www.zohoapis.in/crm/v3";

// ── Intent detection ──────────────────────────────────────────────────────────
// Returns one of: not_interested | site_visit | price | brochure | call_me | general
function detectIntent(message: string): string {
  const msg = message.toLowerCase();

  // Not interested — negative signals
  if (/not interested|nahi chahiye|nhi chahiye|nahin chahiye|interested nahi|interest nahi|band karo|mat karo|mujhe nahi|mujhe nhi|no thanks|don't contact|do not contact|stop|unsubscribe|remove me|bura|galat|spam/i.test(msg)) {
    return "not_interested";
  }

  // Virtual tour intent — check BEFORE site_visit
  if (/virtual tour|virtual visit|online tour|online dekh|zoom|video call|video pe dikhao|virtually|virtual/i.test(msg)) {
    return "virtual_tour";
  }

  // Site visit intent — physical visit confirmed
  // Includes time-based confirmations like "kal 2 baje", "Sunday aaunga", day+time combos
  if (/site visit|visit karna|visit krna|aa jaun|aa sakta|aa rha|aa raha|physical|dekhna chahta|dekhna chahti|location|address|kahan hai|kahan h|show flat|flat dikhao|project dikhao|aaunga|aaungi|kal \d|aaj \d|sunday|saturday|monday|tuesday|wednesday|thursday|friday|parso|kal aata|kal aaunga|kal milte|baje aa|baje visit|time confirm|slot confirm|visit confirm|confirmed visit/i.test(msg)) {
    return "site_visit";
  }

  // Price intent
  if (/price|cost|rate|kitna|budget|amount|kitne ka|kitne mein|kaafi mehnga|affordable|emi|loan/i.test(msg)) {
    return "price";
  }

  // Brochure intent
  if (/brochure|pdf|details|information|info bhejo|send|bhej do|share karo/i.test(msg)) {
    return "brochure";
  }

  // Call me intent
  if (/call karo|call me|call krna|phone karo|baat karna|baat krni|call back|callback/i.test(msg)) {
    return "call_me";
  }

  // Positive general interest
  if (/haan|ha |yes|interested|batao|bataiye|theek hai|thik hai|okay|ok|acha|accha|sure|zaroor/i.test(msg)) {
    return "general";
  }

  return "general";
}

// ── Zoho: Get access token ─────────────────────────────────────────────────────
async function getZohoToken(): Promise<string> {
  const r = await fetch(
    `https://accounts.zoho.in/oauth/v2/token?grant_type=refresh_token&client_id=${ZOHO_CLIENT_ID}&client_secret=${ZOHO_CLIENT_SECRET}&refresh_token=${ZOHO_REFRESH_TOKEN}`,
    { method: "POST" }
  );
  const data = await r.json() as any;
  if (!data.access_token) throw new Error("Zoho token error: " + JSON.stringify(data));
  return data.access_token;
}

// ── Zoho: Find lead by phone ───────────────────────────────────────────────────
async function findLeadByPhone(phone: string, token: string): Promise<string | null> {
  // Try Mobile field first
  const r = await fetch(
    `${ZOHO_API_BASE}/Leads/search?criteria=(Mobile:equals:${phone})&fields=id`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
  const data = await r.json() as any;
  if (data?.data?.[0]?.id) return data.data[0].id;

  // Try Phone field as fallback
  const r2 = await fetch(
    `${ZOHO_API_BASE}/Leads/search?criteria=(Phone:equals:${phone})&fields=id`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
  const data2 = await r2.json() as any;
  return data2?.data?.[0]?.id || null;
}

// ── Zoho: Update lead intent ───────────────────────────────────────────────────
async function updateZohoIntent(leadId: string, intent: string, token: string): Promise<void> {
  const updateData: any = {
    id: leadId,
    Last_Intent: intent,
    Whatsapp_Replied: true,
  };

  await fetch(`${ZOHO_API_BASE}/Leads`, {
    method: "PATCH",
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: [updateData] }),
  });

  console.log(`[Periskope Webhook] Zoho updated — Lead ${leadId}: Last_Intent=${intent}`);
}

// ── Save message to Supabase ──────────────────────────────────────────────────
async function saveMessage(phone: string, direction: "inbound" | "outbound", message: string, sender: string): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_messages`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "apikey":        SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ phone, direction, message, sender }),
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
    const body   = req.body || {};
    const event  = String(body?.event_type || body?.event || body?.type || "");
    const data   = body?.data || body;

    console.log(`[Periskope Webhook] FULL BODY: ${JSON.stringify(body).slice(0, 2000)}`);
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

    // 1. Detect intent
    const intent = detectIntent(message);
    console.log(`[Periskope Webhook] Intent detected: ${intent}`);

    // 2. Save inbound message to Supabase
    await saveMessage(phone, "inbound", message, sender);

    // 3. Call Anandita LLM for reply
    const reply = await callAnandita(phone, message);
    console.log(`[Periskope Webhook] Anandita reply: ${reply.slice(0, 100)}`);

    // 4. Send reply via Periskope
    await sendReply(phone, sender, reply);

    // 5. Save outbound reply to Supabase
    await saveMessage(phone, "outbound", reply, sender);

    // 6. Update Zoho with intent — awaited before response (fire-and-forget gets killed by Vercel)
    try {
      const token  = await getZohoToken();
      const leadId = await findLeadByPhone(phone, token);
      if (leadId) {
        await updateZohoIntent(leadId, intent, token);
      } else {
        console.log(`[Periskope Webhook] Lead not found in Zoho for phone ${phone}`);
      }
    } catch (err: any) {
      console.error("[Periskope Webhook] Zoho update error:", err.message);
    }

    return res.status(200).json({ success: true, phone, intent });

  } catch (err: any) {
    console.error("[Periskope Webhook] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
