/**
 * PRD v1.0 — central orchestrator. Every external event (lead create,
 * chatbot reply, call outcome, site visit booking, opt-out) goes through
 * this module so state transitions + counter updates + side effects are
 * applied consistently.
 *
 * Per user clarification:
 *   - T=0 (lead-created): fire chatbot WhatsApp + AI call SIMULTANEOUSLY
 *   - Channels run independent timers afterwards
 *   - Lead → Not Interested only when BOTH channels exhaust (Option Y)
 *   - Pre Site Visit confirmation also uses SS tree (Option A)
 */
import { sendDocViaPeriskope } from "./document_dispatcher";
import {
  onLeadCreated,
  onChatbotReply,
  onChatbotNoReply,
  onCallOutcome,
  onSiteVisitBooked,
  onNotInterested,
  onSsTreeExhausted,
  onPreSiteVisitSsExhausted,
  CallOutcome,
  Stage,
} from "./prd_state_machine";
import {
  CFG,
  bothChannelsExhausted,
  chatbotExhausted,
  ssCallExhausted,
  incrementChatbotAttempt,
  incrementChatbotFollowup,
  incrementSsCallAttempt,
} from "./prd_cadence";

const PERISKOPE_API_KEY = process.env.PERISKOPE_API_KEY || "";
const PERISKOPE_API_URL = "https://api.periskope.app/v1/messages/send";

// ─── 10 round-robin sender numbers (Periskope sender pool) ──────────────
const SENDER_POOL = [
  "919063141693",
  "917794028484",
  "917396077334",
  "919059555164",
  "918977537630",
  "917207048181",
  "917396130606",
  "917386023002",
  "919247524774",
  "917995284040",
];

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

async function pickSender(phone: string): Promise<string> {
  // Try existing sender mapping first (returning customer = same RM)
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/whatsapp_sender_map?phone=eq.${encodeURIComponent(phone)}&select=sender&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    const rows = (await r.json()) as Array<{ sender: string }>;
    if (Array.isArray(rows) && rows[0]?.sender) return rows[0].sender;
  } catch {}
  // Round-robin via Supabase atomic RPC
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_next_sender_index`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ num_senders: SENDER_POOL.length }),
    });
    const idx = (await r.json()) as number;
    const safe = (typeof idx === "number" && idx >= 0) ? idx % SENDER_POOL.length : 0;
    return SENDER_POOL[safe];
  } catch {
    return SENDER_POOL[Math.floor(Math.random() * SENDER_POOL.length)];
  }
}

// ─── Action triggers ─────────────────────────────────────────────────────

/** Fire a WhatsApp message via Periskope (initial or follow-up).
 *  Saves the outbound row to Supabase for chat-history visibility. */
async function fireChatbotMessage(phone: string, message: string, project?: string): Promise<{ ok: boolean; error?: string }> {
  const sender = await pickSender(phone);
  try {
    const r = await fetch(PERISKOPE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PERISKOPE_API_KEY}`,
        "x-phone": sender,
      },
      body: JSON.stringify({ chat_id: phone, message }),
    });
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 200);
      console.error(`[PRD Orch] WhatsApp send failed (${r.status}): ${txt}`);
      return { ok: false, error: txt };
    }
    // Save to whatsapp_messages so it shows in dashboard + LLM history
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({ phone, direction: "outbound", message, sender, project: project || null }),
      });
      await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sender_map`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify({ phone, sender, updated_at: new Date().toISOString() }),
      });
    } catch {}
    return { ok: true };
  } catch (err: any) {
    console.error(`[PRD Orch] WhatsApp throw: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** Fire an outbound AI call via our self-deployed relay (country-routes
 *  to in-house bot for +91, Arrowhead for international). */
async function fireAiCall(opts: {
  zoho_lead_id: string;
  phone: string;
  customer_name: string;
  project?: string;
  is_resubmission?: boolean;
  last_page_visited?: string;
  budget?: string;
  size_preference?: string;
  preferred_call_time?: string;
}): Promise<{ ok: boolean; error?: string; response?: any }> {
  const SELF_BASE_URL = process.env.SELF_PUBLIC_URL || "https://asbl-crm-api.vercel.app";
  const externalScheduleId = `prd-${opts.zoho_lead_id}-${Date.now()}`;
  const payload: Record<string, any> = {
    _zoho_lead_id: opts.zoho_lead_id,
    phone_number: opts.phone,
    customer_full_name: opts.customer_name,
    customer_name: opts.customer_name,
    external_schedule_id: externalScheduleId,
    external_customer_id: opts.zoho_lead_id,
    retell_llm_dynamic_variables: {
      customer_name: opts.customer_name,
      customer_phone: opts.phone,
      project_name: opts.project || "",
      is_resubmission: opts.is_resubmission ? "true" : "false",
      last_page_visited: opts.last_page_visited || "",
      budget: opts.budget || "",
      size_preference: opts.size_preference || "",
      preferred_call_time: opts.preferred_call_time || "",
    },
  };
  try {
    const r = await fetch(`${SELF_BASE_URL}/api/relay/inhouse-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`[PRD Orch] AI call relay failed (${r.status}):`, j);
      return { ok: false, error: `relay ${r.status}`, response: j };
    }
    console.log(`[PRD Orch] AI call relay OK (region=${j?.region}, call_id=${j?.call_id || "?"})`);
    return { ok: true, response: j };
  } catch (err: any) {
    console.error(`[PRD Orch] AI call throw: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ─── Event entry points ──────────────────────────────────────────────────

export interface OnLeadCreatedInput {
  zoho_lead_id: string;
  phone: string;
  customer_name: string;
  project?: string;
  lead?: any;
  is_resubmission?: boolean;
  last_page_visited?: string;
  budget?: string;
  size_preference?: string;
}

/**
 * T=0 entry — lead just created. Per user override: fire BOTH chatbot
 * message AND AI call simultaneously. Both channels then follow PRD
 * timers independently from here on.
 *
 * Returns Promise that completes once both side effects have been
 * dispatched. The actual responses from Periskope / voice-bot are
 * async — we don't block on them.
 */
export async function handleLeadCreated(input: OnLeadCreatedInput): Promise<{
  state: any;
  chatbot: { ok: boolean; error?: string };
  ai_call: { ok: boolean; error?: string };
}> {
  // 1. Stage/Status → New Lead / NA
  const state = await onLeadCreated(input.zoho_lead_id, input.lead);

  // 2. Fire chatbot + AI call IN PARALLEL (per user spec)
  const greeting = buildInitialChatbotGreeting(input);
  const [chatbot, ai_call] = await Promise.all([
    fireChatbotMessage(input.phone, greeting, input.project),
    fireAiCall({
      zoho_lead_id: input.zoho_lead_id,
      phone: input.phone,
      customer_name: input.customer_name,
      project: input.project,
      is_resubmission: input.is_resubmission,
      last_page_visited: input.last_page_visited,
      budget: input.budget,
      size_preference: input.size_preference,
    }),
  ]);

  // 3. Bump counters (per channel)
  await incrementChatbotAttempt(input.zoho_lead_id, input.lead || {});
  if (ai_call.ok) {
    await incrementSsCallAttempt(input.zoho_lead_id, input.lead || {});
  }

  console.log(
    `[PRD Orch] T=0 fanout for lead ${input.zoho_lead_id} — ` +
    `chatbot=${chatbot.ok ? "OK" : "FAIL"} call=${ai_call.ok ? "OK" : "FAIL"}`,
  );
  return { state, chatbot, ai_call };
}

/** Build the initial WhatsApp greeting. Anandita-style, brief. */
function buildInitialChatbotGreeting(input: OnLeadCreatedInput): string {
  const name = (input.customer_name || "").trim() || "Sir/Ma'am";
  const project = input.project || "our project";

  const contextBits: string[] = [];
  if (input.budget)          contextBits.push(`budget ${input.budget}`);
  if (input.size_preference) contextBits.push(input.size_preference);
  const enquiry = contextBits.length
    ? `I see you've enquired about ${project} with ${contextBits.join(", ")}.`
    : `I see you've enquired about ${project}.`;

  return (
    `Hi ${name}, this is Anandita from ASBL. ${enquiry}\n\n` +
    `When would be a good time for a quick call to discuss pricing, ` +
    `availability, and offers? Or feel free to reply here with any ` +
    `questions you may have.`
  );
}

/** Customer replied to chatbot → status CF. */
export async function handleChatbotReply(opts: {
  zoho_lead_id: string;
  lead: any;
  customer_message: string;
}): Promise<void> {
  await onChatbotReply(opts.zoho_lead_id, opts.lead, opts.customer_message);
  // Per PRD section 9 global overrides: detect site-visit intent or
  // not-interested intent in the customer's message and override.
  if (detectsSiteVisitIntent(opts.customer_message)) {
    await onSiteVisitBooked(opts.zoho_lead_id, opts.lead);
    return;
  }
  if (detectsNotInterestedIntent(opts.customer_message)) {
    await onNotInterested(opts.zoho_lead_id, opts.lead);
    return;
  }
  // Otherwise: chatbot conversation continues. CF status stays.
  // Bot's LLM (Gemini + Kimi) handles the actual reply via existing
  // periskope-webhook flow — we just track state here.
}

/** Chatbot no-reply window expired → SF, schedule follow-up. */
export async function handleChatbotNoReplyTimer(opts: { zoho_lead_id: string; lead: any }): Promise<void> {
  // If chatbot already exhausted, don't continue
  if (chatbotExhausted(opts.lead)) {
    if (bothChannelsExhausted(opts.lead)) {
      await onSsTreeExhausted(opts.zoho_lead_id, opts.lead);
    }
    return;
  }
  await onChatbotNoReply(opts.zoho_lead_id, opts.lead);
  // The follow-up message will be dispatched by the cron processor
  // (Phase 7 wiring) — we just transitioned status here.
}

/** A scheduled chatbot follow-up tick fires → send next message + increment. */
export async function handleChatbotFollowupTick(opts: {
  zoho_lead_id: string;
  lead: any;
  phone: string;
  customer_name: string;
  project?: string;
}): Promise<void> {
  if (chatbotExhausted(opts.lead)) {
    if (bothChannelsExhausted(opts.lead)) {
      await onSsTreeExhausted(opts.zoho_lead_id, opts.lead);
    }
    return;
  }
  const followupIdx = (opts.lead.Chatbot_Follow_up_Count ?? 0) + 1;
  const msg = buildFollowupMessage(opts.customer_name, opts.project, followupIdx);
  const r = await fireChatbotMessage(opts.phone, msg, opts.project);
  if (r.ok) {
    await incrementChatbotFollowup(opts.zoho_lead_id, opts.lead);
  }
}

/** SS call tree tick fires → place next call + increment. */
export async function handleSsCallTick(opts: {
  zoho_lead_id: string;
  lead: any;
  phone: string;
  customer_name: string;
  project?: string;
}): Promise<void> {
  if (ssCallExhausted(opts.lead)) {
    if (bothChannelsExhausted(opts.lead)) {
      await onSsTreeExhausted(opts.zoho_lead_id, opts.lead);
    }
    return;
  }
  const r = await fireAiCall({
    zoho_lead_id: opts.zoho_lead_id,
    phone: opts.phone,
    customer_name: opts.customer_name,
    project: opts.project,
  });
  if (r.ok) {
    await incrementSsCallAttempt(opts.zoho_lead_id, opts.lead);
  }
}

/** Call posthook arrived → route per outcome (PRD sections 8.3 / 8.4). */
export async function handleCallPosthook(opts: {
  zoho_lead_id: string;
  lead: any;
  outcome: CallOutcome;
  details?: { preferredTime?: string; visitDate?: string };
}): Promise<void> {
  await onCallOutcome(opts.zoho_lead_id, opts.lead, opts.outcome, opts.details);
}

// ─── Helper: detect intent from customer message ────────────────────────
// These mirror PRD section 9 global override semantics.

const SITE_VISIT_KEYWORDS = [
  "site visit", "sample flat", "show flat", "visit kar", "visit karna",
  "visit kab", "come and see", "sample dekhna", "model flat", "showroom",
  "office", "experience center", "kab aaye", "aapke paas",
];

const NOT_INTERESTED_KEYWORDS = [
  "not interested", "no interest", "nahi chahiye", "mat bhejo",
  "stop calling", "do not call", "don't call", "remove me", "unsubscribe",
  "stop messaging", "no thank you", "no thanks", "out of budget",
];

export function detectsSiteVisitIntent(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return SITE_VISIT_KEYWORDS.some((k) => m.includes(k));
}

export function detectsNotInterestedIntent(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return NOT_INTERESTED_KEYWORDS.some((k) => m.includes(k));
}

// ─── Templates ──────────────────────────────────────────────────────────

function buildFollowupMessage(customerName: string, project: string | undefined, idx: number): string {
  const name = (customerName || "").trim() || "Sir/Ma'am";
  const proj = project || "ASBL";
  // 3 distinct follow-ups so we don't sound robotic
  const messages = [
    `Hi ${name}, just following up on my earlier message about ${proj}. ` +
    `Would you like me to share the brochure / pricing, or shall I help you schedule a quick site visit?`,
    `${name}, sharing one more time — ${proj} has limited inventory left in the popular configurations. ` +
    `Are you available for a 10-minute call or a site visit this weekend?`,
    `Hi ${name}, this will be my final check-in. ${proj} ki current offers limited time ke liye hain. ` +
    `If you're still considering, just reply and I'll send you the details and book a slot.`,
  ];
  return messages[Math.min(idx - 1, messages.length - 1)];
}

// Re-export key state-machine helpers so callers can import everything
// from prd_orchestrator if they prefer a single import.
export {
  onLeadCreated,
  onChatbotReply,
  onSiteVisitBooked,
  onNotInterested,
  onCallOutcome,
  onPreSiteVisitSsExhausted,
};
