/**
 * Zoho → Anandita LLM → Periskope WhatsApp relay
 *
 * Flow:
 *   1. Zoho Deluge calls this with lead data
 *   2. We build a context prompt and send to Anandita LLM
 *   3. Anandita generates a personalised first message
 *   4. We send it via Periskope
 *
 * POST /api/relay/periskope
 * Body: { phone, first_name, project, budget, size_preference, lead_source }
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

const PERISKOPE_API_KEY  = process.env.PERISKOPE_API_KEY  || "";
const PERISKOPE_API_URL  = "https://api.periskope.app/v1/messages/send";
const ANANDITA_URL       = process.env.ANANDITA_URL  || "http://35.154.144.37:8080/api/chat/";
const ANANDITA_API_KEY   = process.env.ANANDITA_API_KEY  || "asbl_9b9b6b7ff1f758be40aca7ceb03d7d0d9c57d788b4457d5ca5819620b25d146a";
const SUPABASE_URL       = process.env.SUPABASE_URL || "";
const SUPABASE_KEY       = process.env.SUPABASE_SECRET_KEY || "";

// Round-robin sender numbers (stored without + prefix)
const SENDER_NUMBERS = [
  "919063141693",
  "917995284040",
  "918977537630",
  "919059555164",
];

// Get next sender via atomic Supabase RPC (true round-robin)
async function getNextSender(): Promise<string> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_next_sender_index`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "apikey":        SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ num_senders: SENDER_NUMBERS.length }),
    });
    const idx = await r.json() as number;
    const safeIdx = (typeof idx === "number" && idx >= 0) ? idx % SENDER_NUMBERS.length : 0;
    return SENDER_NUMBERS[safeIdx];
  } catch (err) {
    // Fallback: random pick if Supabase fails
    console.error("[Periskope] Sender index fetch failed, using random:", err);
    return SENDER_NUMBERS[Math.floor(Math.random() * SENDER_NUMBERS.length)];
  }
}

// ── Build personalised first message from template ────────────────────────────
function generateMessage(
  firstName: string,
  project: string,
  budget: string,
  sizePreference: string,
): string {
  const name = firstName?.trim() || "there";

  // Build enquiry detail line
  const details: string[] = [];
  if (project)        details.push(`*${project}*`);
  if (budget)         details.push(`budget ${budget}`);
  if (sizePreference) details.push(`${sizePreference}`);

  const enquiryLine = details.length > 0
    ? `Aapne hamare ${details.join(", ")} ke liye enquiry ki thi.`
    : `Aapne hamare ek project ke liye enquiry ki thi.`;

  return (
    `Hi ${name}! 👋\n\n` +
    `Main Aanandita Reddy hoon, ASBL mein aapki dedicated Relationship Manager. ${enquiryLine}\n\n` +
    `Aapke ghar kharidne ke safar ko smooth aur easy banana mera kaam hai. ` +
    `Koi bhi sawaal ho — pricing, location, availability — yahan reply karein, main haazir hoon! 🏠`
  );
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
    console.error("[Periskope] Failed to save message:", err);
  }
}

// ── Store sender mapping in Supabase ─────────────────────────────────────────
async function storeSenderMapping(phone: string, sender: string): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sender_map`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "apikey":        SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Prefer":        "resolution=merge-duplicates",
      },
      body: JSON.stringify({ phone, sender, updated_at: new Date().toISOString() }),
    });
  } catch (err) {
    console.error("[Periskope] Failed to store sender mapping:", err);
  }
}

// ── Step 2: Send via Periskope ────────────────────────────────────────────────
async function sendViaPeriskope(phone: string, sender: string, message: string): Promise<any> {
  const r = await fetch(PERISKOPE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${PERISKOPE_API_KEY}`,
      "x-phone":       sender,
    },
    body: JSON.stringify({ chat_id: phone, message }),
  });

  const text = await r.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!r.ok) throw new Error(`Periskope error ${r.status}: ${text}`);
  return data;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  try {
    const {
      phone,
      first_name      = "",
      project         = "",
      budget          = "",
      size_preference = "",
      lead_source     = "",
    } = req.body || {};

    if (!phone) return res.status(400).json({ error: "phone required" });

    // 1. Get next sender (round-robin via Supabase)
    const sender = await getNextSender();

    console.log(`[Periskope] Generating message for ${phone} (${first_name}, ${project}) via ${sender}`);

    // 2. Build personalised first message
    const message = generateMessage(first_name, project, budget, size_preference);

    console.log(`[Periskope] Message: ${message.slice(0, 100)}...`);

    // 3. Send via Periskope
    const result = await sendViaPeriskope(phone, sender, message);

    // Store sender mapping so replies use the same number
    await storeSenderMapping(phone, sender);

    // Save outbound message to Supabase for chat history
    await saveMessage(phone, "outbound", message, sender);

    console.log(`[Periskope] Sent to ${phone} via ${sender}`);
    return res.status(200).json({ success: true, phone, sender, message, ...result });

  } catch (err: any) {
    console.error("[Periskope] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
