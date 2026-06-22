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
  chatbotExhausted,
  incrementChatbotAttempt,
  incrementChatbotFollowup,
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
  // Phase 8: migrated from Supabase to Mongo (whatsapp_sender_map + _counters.sender_idx).
  try {
    const { getSenderForPhone, getNextSenderIndex } = await import("./ops_collections");
    const existing = await getSenderForPhone(phone);
    if (existing) return existing;
    const idx = await getNextSenderIndex(SENDER_POOL.length);
    return SENDER_POOL[idx] || SENDER_POOL[0];
  } catch {
    return SENDER_POOL[Math.floor(Math.random() * SENDER_POOL.length)];
  }
}

// ─── Action triggers ─────────────────────────────────────────────────────

/** Detect a "this sender's WhatsApp phone is dead" response from Periskope.
 *  Covers their UNAUTHORIZED_ERROR + "phone server instance is switched off"
 *  message + generic 401/403/500 + the "/phone/restart" hint. When this hits
 *  we don't fail the send — we mark the sender dead and fall through to the
 *  next pool member. */
function isDeadSenderResponse(status: number, body: string): boolean {
  const b = body.toLowerCase();
  if (b.includes("phone server") && b.includes("switched off")) return true;
  if (b.includes("/phone/restart")) return true;
  if (b.includes("unauthorized_error")) return true;
  // 401 from Periskope on a per-x-phone send almost always means the phone
  // is offline (not the API key — we'd see that on every request, not one).
  if (status === 401) return true;
  return false;
}

/** Fire a WhatsApp message via Periskope (initial or follow-up).
 *
 *  Pool-wide fallback: if the sticky-mapped sender is dead (Periskope 401
 *  / "phone server switched off"), iterate through the full SENDER_POOL
 *  until one succeeds. On success, re-stick the phone to the winning
 *  sender. Dead senders are recorded in Mongo with a 1-hour TTL so other
 *  phones routed during this hour also skip them.
 *
 *  Before this fix (bug observed 2026-06-18 for lead 919951382116 / Range):
 *  a dead sticky-sender would permanently block the lead — no greeting,
 *  no follow-up, no callback. Customer goes silent in our funnel.
 */
async function fireChatbotMessage(phone: string, message: string, project?: string): Promise<{ ok: boolean; error?: string }> {
  // Build send order: sticky first, then everything else in pool order.
  // Skip senders we already know are dead (within the 1h TTL).
  const ops = await import("./ops_collections");
  const stickySender = await ops.getSenderForPhone(phone);
  const deadSet = await ops.getDeadSenders().catch(() => new Set<string>());

  const ordered: string[] = [];
  if (stickySender && !deadSet.has(stickySender)) ordered.push(stickySender);
  for (const s of SENDER_POOL) {
    if (s === stickySender) continue;
    if (deadSet.has(s)) continue;
    ordered.push(s);
  }
  // If everyone known-dead, still try the full pool — TTL might be stale.
  if (!ordered.length) ordered.push(...SENDER_POOL);

  let lastErr = "";
  let tried = 0;
  for (const sender of ordered) {
    tried++;
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

      if (r.ok) {
        // Save to whatsapp_messages so it shows in dashboard + LLM history.
        try {
          const { insertMessage } = await import("./whatsapp_messages");
          await insertMessage({
            phone, direction: "outbound", message, sender,
            project: project || null, intent: null,
            created_at: new Date().toISOString(),
          });
          // Re-stick phone to the sender that actually delivered.
          await ops.setSenderForPhone(phone, sender);
        } catch {}
        if (tried > 1) {
          console.log(`[PRD Orch] WhatsApp sent to ${phone} via ${sender} (after ${tried - 1} dead-sender fallback${tried > 2 ? "s" : ""})`);
        }
        return { ok: true };
      }

      const txt = (await r.text()).slice(0, 200);
      lastErr = `${r.status}:${txt}`;
      if (isDeadSenderResponse(r.status, txt)) {
        console.warn(`[PRD Orch] Sender ${sender} dead (${r.status}) — marking + trying next`);
        await ops.markSenderDead(sender).catch(() => {});
        continue;
      }
      // Non-sender error (4xx for bad payload, customer blocked us, etc.)
      // — won't be fixed by trying another sender. Stop here.
      console.error(`[PRD Orch] WhatsApp send failed via ${sender} (${r.status}): ${txt}`);
      return { ok: false, error: txt };
    } catch (err: any) {
      lastErr = err.message;
      console.warn(`[PRD Orch] Sender ${sender} threw — trying next: ${err.message}`);
      continue;
    }
  }

  console.error(`[PRD Orch] WhatsApp send EXHAUSTED — all ${tried} senders failed for ${phone}. Last error: ${lastErr}`);
  return { ok: false, error: `all senders exhausted: ${lastErr}` };
}

/** Fire an outbound AI call via our self-deployed relay → in-house voice-bot
 *  (Plivo for +91 India, Telnyx for everything else; voice-bot picks).
 *
 *  No calling-hours gate on our side. T=0 calls fire immediately; follow-up
 *  calls are scheduled by call_scheduling.ts using the customer's timezone
 *  (8 AM-9 PM customer-local for pickup follow-up, 7 AM-9 PM customer-local
 *  for the not-picked aggressive retry tree). */
/** Public alias for the cron — call_scheduling.ts decides WHEN to fire;
 *  this just dispatches. */
export async function fireAiCallDirect(opts: {
  zoho_lead_id: string;
  phone: string;
  customer_name: string;
  project?: string;
}): Promise<{ ok: boolean; error?: string; response?: any }> {
  return fireAiCall(opts);
}

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

  // 3. Bump chatbot counter. Voice-call attempts under PRD v2.0 are
  //    tracked entirely in the posthook (Consecutive_Missed_Count +
  //    Aggressive_Tree_Start_At), so no SS-side counter to bump here.
  await incrementChatbotAttempt(input.zoho_lead_id, input.lead || {});

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
  if (chatbotExhausted(opts.lead)) return;
  await onChatbotNoReply(opts.zoho_lead_id, opts.lead);
  // The follow-up message will be dispatched by the cron processor
  // (Phase 7 wiring) — we just transitioned status here.
}

/** A scheduled chatbot follow-up tick fires → send next message + increment.
 *  COLD-lead path — customer has never replied. Uses the 6-template rotating
 *  bank in buildFollowupMessage. */
export async function handleChatbotFollowupTick(opts: {
  zoho_lead_id: string;
  lead: any;
  phone: string;
  customer_name: string;
  project?: string;
}): Promise<void> {
  if (chatbotExhausted(opts.lead)) return;
  const followupIdx = (opts.lead.Chatbot_Follow_up_Count ?? 0) + 1;
  const msg = buildFollowupMessage(opts.customer_name, opts.project, followupIdx);
  const r = await fireChatbotMessage(opts.phone, msg, opts.project);
  if (r.ok) {
    await incrementChatbotFollowup(opts.zoho_lead_id, opts.lead);
  }
}

/** GHOST re-engagement tick fires for warm-then-silent leads (customer replied
 *  at some point but has been quiet for >= GHOST_THRESHOLD_MS).
 *  Uses the context-aware buildReengagementMessage bank instead of cold-pitch
 *  templates. Counter shared with regular chatbot follow-up to enforce the
 *  same 30-attempt safety cap. */
export async function handleChatbotReengagementTick(opts: {
  zoho_lead_id: string;
  lead: any;
  phone: string;
  customer_name: string;
  project?: string;
  hours_since_last_reply: number;
}): Promise<void> {
  if (chatbotExhausted(opts.lead)) return;
  const followupIdx = (opts.lead.Chatbot_Follow_up_Count ?? 0) + 1;
  const msg = buildReengagementMessage(
    opts.customer_name,
    opts.project,
    opts.hours_since_last_reply,
    followupIdx,
  );
  const r = await fireChatbotMessage(opts.phone, msg, opts.project);
  if (r.ok) {
    await incrementChatbotFollowup(opts.zoho_lead_id, opts.lead);
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

/** COLD follow-up — customer has never replied. Rotating bank of 6
 *  messages covering different angles (brochure, site visit, pricing,
 *  configurations, urgency, soft check-in) so 2-hour cadence doesn't
 *  feel robotic. Index wraps around so attempt #7 = #1 again. */
function buildFollowupMessage(customerName: string, project: string | undefined, idx: number): string {
  const name = (customerName || "").trim() || "Sir/Ma'am";
  const proj = project || "ASBL";
  const messages = [
    // 1: Brochure / pricing offer
    `Hi ${name}, just following up on my earlier message about ${proj}. ` +
    `Would you like me to share the brochure / pricing, or shall I help you schedule a quick site visit?`,
    // 2: Inventory urgency
    `${name}, sharing one more time — ${proj} me popular configurations me limited inventory hai. ` +
    `Are you available for a 10-minute call or a site visit this weekend?`,
    // 3: Final-tone gentle
    `Hi ${name}, just one more check-in. ${proj} ki current options aapke budget aur preference ke hisaab se discuss kar sakte hain. ` +
    `Reply karein, main details share kar dungi.`,
    // 4: Configuration-focused
    `${name}, kya aapko ${proj} me kisi specific configuration / size ya floor me interest hai? ` +
    `Bata dijiye, main matching options + pricing share karti hu.`,
    // 5: Site visit nudge
    `Hi ${name}, ${proj} me ek quick site visit consider karenge? Even 30 minutes me poora project samajh aa jata hai. ` +
    `Apka koi preferred day batayenge?`,
    // 6: Soft re-engage
    `${name}, ek choti si update — ${proj} ke kuch new amenities + payment options confirm hue hain. ` +
    `Interested ho to reply karein, main share karti hu.`,
  ];
  return messages[(idx - 1) % messages.length];
}

/** GHOST RE-ENGAGEMENT — customer ne pehle reply kiya tha but ab silent
 *  ho gaya hai. Context-aware: acknowledges the prior conversation
 *  instead of generic cold-pitch. Rotating bank of 4 messages. */
export function buildReengagementMessage(
  customerName: string,
  project: string | undefined,
  hoursSinceLastReply: number,
  idx: number,
): string {
  const name = (customerName || "").trim() || "Sir/Ma'am";
  const proj = project || "ASBL";
  const messages = [
    `Hi ${name}, hamari pichli baat ${proj} ke baare me chal rahi thi — koi update share karu? ` +
    `Pricing, inventory, ya site visit slot — jo bhi chahiye, bata dijiye.`,

    `${name}, hope you're doing well. Pichli conversation ke baad agar koi specific question rah gaya ho ${proj} ke baare me, ` +
    `feel free to ask. Main 5 min me reply kar sakti hu.`,

    `Hi ${name}, ek quick check-in — ${proj} pe abhi tak final decision liya kya? ` +
    `Agar koi confusion ya specific detail chahiye to message kar dijiye, main turant respond karungi.`,

    `${name}, hamare pichle chat ke baad ek update — ${proj} me kuch fresh inventory aur payment options confirm hue hain. ` +
    `Ek 5-min call ya site visit lagaun?`,
  ];
  return messages[(idx - 1) % messages.length];
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
