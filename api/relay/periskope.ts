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
import { insertMessage as mongoInsertMessage } from "../_utils/whatsapp_messages";

const PERISKOPE_API_KEY  = process.env.PERISKOPE_API_KEY  || "";
const PERISKOPE_API_URL  = "https://api.periskope.app/v1/messages/send";
const ANANDITA_URL       = process.env.ANANDITA_URL  || "http://35.154.144.37:8080/api/chat/anandita_rm/";
const ANANDITA_API_KEY   = process.env.ANANDITA_API_KEY  || "asbl_dccd9fea5d2fe188f5518574354e8fd805f0fd0a507926139fee0f1ae2ff07b1";
const SUPABASE_URL       = process.env.SUPABASE_URL || "";
const SUPABASE_KEY       = process.env.SUPABASE_SECRET_KEY || "";

// Round-robin sender numbers (stored without + prefix)
// All 10 connected Periskope senders — Anandita LLM RM team
const SENDER_NUMBERS = [
  "919063141693", // Angad
  "917794028484", // Kapil
  "917396077334", // Bala SK
  "919059555164", // Reddy
  "918977537630",
  "917207048181", // Varun
  "917396130606", // Mayur
  "917386023002",
  "919247524774",
  "917995284040", // Anandita
];

// Get next sender via atomic Mongo counter (Phase 8: was Supabase RPC).
async function getNextSender(): Promise<string> {
  try {
    const { getNextSenderIndex } = await import("../_utils/ops_collections");
    const idx = await getNextSenderIndex(SENDER_NUMBERS.length);
    return SENDER_NUMBERS[idx] || SENDER_NUMBERS[0];
  } catch (err) {
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
  if (project)        details.push(project);
  if (budget)         details.push(`budget ${budget}`);
  if (sizePreference) details.push(sizePreference);

  const enquiryLine = details.length > 0
    ? `I understand you have recently expressed interest in ${details.join(", ")}.`
    : `I understand you have recently expressed interest in one of our projects.`;

  return (
    `Dear ${name},\n\n` +
    `My name is Anandita Reddy and I am your dedicated Relationship Manager at ASBL. ${enquiryLine}\n\n` +
    `I am here to assist you through every step of your home buying journey. Please feel free to reply to this message with any questions you may have regarding pricing, availability, floor plans, or anything else, and I will get back to you promptly.`
  );
}

// ── Save message to Mongo (Phase 4: migrated from Supabase) ──────────────────
async function saveMessage(phone: string, direction: "inbound" | "outbound", message: string, sender: string): Promise<void> {
  try {
    await mongoInsertMessage({
      phone, direction, message, sender,
      project: null, intent: null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[Periskope] Failed to save message:", err);
  }
}

// ── Store sender mapping in Mongo (Phase 8: was Supabase) ────────────────────
async function storeSenderMapping(phone: string, sender: string): Promise<void> {
  try {
    const { setSenderForPhone } = await import("../_utils/ops_collections");
    await setSenderForPhone(phone, sender);
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
