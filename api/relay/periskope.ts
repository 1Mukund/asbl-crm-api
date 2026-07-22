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
import { displayProject } from "../_utils/project_detection";

const PERISKOPE_API_KEY  = process.env.PERISKOPE_API_KEY  || "";
const PERISKOPE_API_URL  = "https://api.periskope.app/v1/messages/send";
const ANANDITA_URL       = process.env.ANANDITA_URL  || "http://35.154.144.37:8080/api/chat/anandita_rm/";
const ANANDITA_API_KEY   = process.env.ANANDITA_API_KEY  || "asbl_dccd9fea5d2fe188f5518574354e8fd805f0fd0a507926139fee0f1ae2ff07b1";
const SUPABASE_URL       = process.env.SUPABASE_URL || "";
const SUPABASE_KEY       = process.env.SUPABASE_SECRET_KEY || "";

// Round-robin sender numbers (stored without + prefix)
// All 10 connected Periskope senders — Anandita RM team (updated 2026-07-22)
const SENDER_NUMBERS = [
  "917793952828",
  "919247598804",
  "919247597422",
  "919247597421",
  "919247597423",
  "919247597420",
  "919247597418",
  "919247597426",
  "919247597419",
  "919247597417",
];

// Phone-sticky sender pick — if this phone already has a sender mapped
// (any prior outbound from PRD orchestrator / resubmission / this endpoint),
// reuse it so the customer always sees messages from the SAME number.
// Only round-robin for truly new phones. Bug observed 2026-06-18: without
// stickiness this endpoint silently rotated senders across follow-ups +
// overwrote the map, so customers saw 2-3 different ASBL numbers.
async function pickStickySender(phone: string): Promise<string> {
  try {
    const { getSenderForPhone, getNextSenderIndex } = await import("../_utils/ops_collections");
    const existing = await getSenderForPhone(phone);
    if (existing) return existing;
    const idx = await getNextSenderIndex(SENDER_NUMBERS.length);
    return SENDER_NUMBERS[idx] || SENDER_NUMBERS[0];
  } catch (err) {
    console.error("[Periskope] Sender pick failed, using random:", err);
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

  // Build enquiry detail line. Never leak the new-launch codename (LEGACY).
  const details: string[] = [];
  if (project)        details.push(displayProject(project));
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

// Same dead-sender detector as prd_orchestrator. Periskope flags an offline
// WhatsApp server as 401 + "phone server instance is switched off" + a
// /phone/restart hint. We treat those as "this sender is dead, try the next
// one" instead of failing the whole request.
function isDeadSenderResponse(status: number, body: string): boolean {
  const b = body.toLowerCase();
  if (b.includes("phone server") && b.includes("switched off")) return true;
  if (b.includes("/phone/restart")) return true;
  if (b.includes("unauthorized_error")) return true;
  if (status === 401) return true;
  return false;
}

// ── Step 2: Send via Periskope, with pool-wide fallback on dead senders. ──
async function sendViaPeriskopeWithFallback(
  phone: string, startingSender: string, message: string,
): Promise<{ data: any; sender: string }> {
  const { markSenderDead, getDeadSenders } = await import("../_utils/ops_collections");
  const deadSet = await getDeadSenders().catch(() => new Set<string>());

  const ordered: string[] = [];
  if (!deadSet.has(startingSender)) ordered.push(startingSender);
  for (const s of SENDER_NUMBERS) {
    if (s === startingSender) continue;
    if (deadSet.has(s)) continue;
    ordered.push(s);
  }
  // If everyone known-dead, still try the full pool — TTL might be stale.
  if (!ordered.length) ordered.push(...SENDER_NUMBERS);

  let lastErr = "";
  let tried = 0;
  for (const sender of ordered) {
    tried++;
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

    if (r.ok) {
      if (tried > 1) {
        console.log(`[Periskope] Sent ${phone} via ${sender} (after ${tried - 1} dead-sender fallback${tried > 2 ? "s" : ""})`);
      }
      return { data, sender };
    }

    lastErr = `${r.status}:${text}`;
    if (isDeadSenderResponse(r.status, text)) {
      console.warn(`[Periskope] Sender ${sender} dead (${r.status}) — marking + trying next`);
      await markSenderDead(sender).catch(() => {});
      continue;
    }
    // Non-sender error (4xx on bad payload / blocked recipient / etc.)
    throw new Error(`Periskope error ${r.status}: ${text}`);
  }

  throw new Error(`Periskope all senders exhausted (${tried} tried). Last: ${lastErr}`);
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

    // 1. Pick sender — sticky-per-phone (re-uses existing mapping if present,
    //    falls through to round-robin only for new phones). The send call
    //    will fall through to other pool members if this sender is dead.
    const startingSender = await pickStickySender(phone);

    console.log(`[Periskope] Generating message for ${phone} (${first_name}, ${project}) via ${startingSender}`);

    // 2. Build personalised first message
    const message = generateMessage(first_name, project, budget, size_preference);

    console.log(`[Periskope] Message: ${message.slice(0, 100)}...`);

    // 3. Send via Periskope (with dead-sender fallback)
    const { data: result, sender: actualSender } = await sendViaPeriskopeWithFallback(
      phone, startingSender, message,
    );

    // Sticky update policy: only set sticky if (a) no sticky existed yet OR
    // (b) we used the existing sticky. Don't promote the fallback when the
    // sticky was just temporarily dead — let the customer's conversation
    // return to the original sender once ops restarts that phone.
    const { getSenderForPhone } = await import("../_utils/ops_collections");
    const priorSticky = await getSenderForPhone(phone);
    if (!priorSticky || priorSticky === actualSender) {
      await storeSenderMapping(phone, actualSender);
    }

    // Save outbound message to Mongo for chat history
    await saveMessage(phone, "outbound", message, actualSender);

    console.log(`[Periskope] Sent to ${phone} via ${actualSender} (sticky preserved at ${priorSticky || actualSender})`);
    return res.status(200).json({ success: true, phone, sender: actualSender, message, ...result });

  } catch (err: any) {
    console.error("[Periskope] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
