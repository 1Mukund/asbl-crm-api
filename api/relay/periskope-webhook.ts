/**
 * Periskope → Anandita LLM → Periskope reply handler
 *
 * Flow:
 *   1. Customer replies on WhatsApp
 *   2. Periskope fires webhook here (event_type: "message.created")
 *   3. We filter inbound messages only
 *   4. Call Anandita LLM with customer's message
 *   5. Send Anandita's reply back via Periskope
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

const SENDER_NUMBERS = [
  "919063141693",
  "917995284040",
  "918977537630",
  "919059555164",
];

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
    console.log(`[Periskope Webhook] Typing indicator sent`);
  } catch {
    // Typing not critical, continue anyway
  }

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
    console.log(`[Periskope Webhook] Event: ${event}, data keys: ${Object.keys(data).join(",")}`);;

    // Only handle message.created / message.received
    if (event !== "message.created" && event !== "message.received") {
      console.log(`[Periskope Webhook] Skipped event: ${event}`);
      return res.status(200).json({ skipped: true, event });
    }

    // Only inbound messages
    if (!isInbound(data)) {
      console.log("[Periskope Webhook] Outbound message, skipping");
      return res.status(200).json({ skipped: true, reason: "outbound" });
    }

    // Customer phone from chat_id, sender from org_phone
    const phone  = parsePhone(data?.chat_id);
    const sender = parsePhone(data?.org_phone);
    const message = String(data?.body || "").trim();

    if (!phone) {
      console.log("[Periskope Webhook] Could not extract customer phone from chat_id");
      return res.status(200).json({ skipped: true, reason: "no phone" });
    }
    if (!sender) {
      console.log("[Periskope Webhook] Could not extract org_phone (our sender)");
      return res.status(200).json({ skipped: true, reason: "no sender" });
    }
    if (!message) {
      console.log("[Periskope Webhook] Empty message body, skipping");
      return res.status(200).json({ skipped: true, reason: "no message" });
    }

    console.log(`[Periskope Webhook] Inbound from ${phone} → org: ${sender} | msg: ${message.slice(0, 80)}`);

    // Save inbound message to Supabase
    await saveMessage(phone, "inbound", message, sender);

    // Call Anandita LLM
    const reply = await callAnandita(phone, message);
    console.log(`[Periskope Webhook] Anandita reply: ${reply.slice(0, 100)}`);

    // Send reply via Periskope
    await sendReply(phone, sender, reply);
    console.log(`[Periskope Webhook] Reply sent to ${phone} via ${sender}`);

    // Save outbound reply to Supabase
    await saveMessage(phone, "outbound", reply, sender);

    return res.status(200).json({ success: true, phone, sender });

  } catch (err: any) {
    console.error("[Periskope Webhook] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
