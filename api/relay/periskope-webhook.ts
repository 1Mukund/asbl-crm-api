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

const SENDER_NUMBERS = [
  "919063141693",
  "917995284040",
  "918977537630",
  "919059555164",
];

// ── Extract phone from Periskope webhook payload ──────────────────────────────
function extractPhone(data: any): string | null {
  const candidates = [
    data?.chat_id,
    data?.sender_phone,
    data?.from,
    data?.author,
    data?.chat?.id,
    data?.id?.remote,
    data?.key?.remoteJid,
    data?.message?.from,
    data?.message?.chat_id,
  ];

  for (const c of candidates) {
    if (!c) continue;
    let v = String(c).trim();
    if (v.includes("@")) v = v.split("@")[0];
    const phone = v.replace(/\D/g, "");
    if (phone.length >= 10 && phone.length <= 15) return phone;
  }
  return null;
}

// ── Extract message text ──────────────────────────────────────────────────────
function extractMessage(data: any): string {
  return (
    data?.body ||
    data?.text ||
    data?.message?.body ||
    data?.message?.text ||
    data?.content ||
    ""
  ).trim();
}

// ── Is this an inbound (customer) message? ────────────────────────────────────
function isInbound(data: any): boolean {
  if (data?.from_me === true || data?.is_from_me === true) return false;
  const dir = String(data?.direction || data?.message_direction || "").toLowerCase();
  if (dir === "outbound") return false;
  return true;
}

// ── Get sender for this phone (stored in Supabase, fallback to first) ─────────
async function getSenderForPhone(phone: string): Promise<string> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/leads?phone=eq.${phone}&select=whatsapp_sender&limit=1`,
      {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const rows = await r.json() as any[];
    const sender = rows?.[0]?.whatsapp_sender;
    if (sender && SENDER_NUMBERS.includes(sender)) return sender;
  } catch { /* fallback */ }

  // Fallback: deterministic pick based on phone
  const lastDigit = parseInt(phone.slice(-1), 10) || 0;
  return SENDER_NUMBERS[lastDigit % SENDER_NUMBERS.length];
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

// ── Send via Periskope ────────────────────────────────────────────────────────
async function sendReply(phone: string, sender: string, message: string): Promise<void> {
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

    console.log(`[Periskope Webhook] Event: ${event}, raw keys: ${Object.keys(data).join(",")}`);

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

    const phone   = extractPhone(data);
    const message = extractMessage(data);

    if (!phone) {
      console.log("[Periskope Webhook] Could not extract phone");
      return res.status(200).json({ skipped: true, reason: "no phone" });
    }
    if (!message) {
      console.log("[Periskope Webhook] Empty message, skipping");
      return res.status(200).json({ skipped: true, reason: "no message" });
    }

    console.log(`[Periskope Webhook] Inbound from ${phone}: ${message.slice(0, 80)}`);

    // Get sender for this customer
    const sender = await getSenderForPhone(phone);
    console.log(`[Periskope Webhook] Using sender: ${sender}`);

    // Call Anandita LLM
    const reply = await callAnandita(phone, message);
    console.log(`[Periskope Webhook] Anandita reply: ${reply.slice(0, 100)}`);

    // Send reply via Periskope
    await sendReply(phone, sender, reply);
    console.log(`[Periskope Webhook] Reply sent to ${phone} via ${sender}`);

    return res.status(200).json({ success: true, phone, sender });

  } catch (err: any) {
    console.error("[Periskope Webhook] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
