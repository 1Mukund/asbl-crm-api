/**
 * PRD v2.0 — Chatbot cadence + counter helpers.
 *
 * Voice-call cadence (PRD v1 SS-call tree, 3 attempts × 4h) has been
 * fully replaced by the posthook-driven state machine in
 * api/_utils/call_scheduling.ts (2026-06-18). This file now owns only
 * chatbot side state.
 */
import { updateLead } from "./zoho";
import { mirrorLeadStateToMongo } from "./supabase";

// ─── CONFIG (v2 2026-06-18 product call) ───────────────────────────────────
//
// COLD branch (customer never replied):
//   Every 7 hours, gated to 7AM-9PM customer-local, for 15 days from
//   Created_Time. Same sender as T=0 (sticky-per-phone).
//
// GHOST branch (replied once, then silent):
//   First fire at last-inbound + 25h, every 24h after that, for 7 days
//   from last inbound. Message includes customer's last reply for context.
//   Same sender.
export const CFG = {
  /** X for no chatbot response — time after initial msg before SF status. */
  CHATBOT_NO_REPLY_WINDOW_MS: 24 * 60 * 60 * 1000, // 24h

  /** Hard safety cap on total chatbot messages per lead. Cold (~30 in 15d)
   *  + ghost (~7 in 7d) worst-case = ~37, with 50 as safety overhead. */
  CHATBOT_FOLLOWUP_MAX_ATTEMPTS: 50,

  // ─── COLD branch ─────────────────────────────────────────────────────
  /** Gap between cold follow-ups. */
  COLD_FOLLOWUP_INTERVAL_MS: 7 * 60 * 60 * 1000, // 7h
  /** Total window for cold follow-ups from Created_Time. */
  COLD_FOLLOWUP_WINDOW_MS: 15 * 24 * 60 * 60 * 1000, // 15 days
  /** Customer-local hour window. */
  COLD_HOURS_START: 7,   // 7 AM
  COLD_HOURS_END: 21,    // 9 PM (exclusive)

  // ─── GHOST branch ────────────────────────────────────────────────────
  /** Delay AFTER customer's last inbound before first re-engagement. */
  GHOST_INITIAL_DELAY_MS: 25 * 60 * 60 * 1000, // 25h
  /** Gap between subsequent ghost re-engagement attempts. */
  GHOST_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24h
  /** Total window for ghost re-engagement from last inbound. */
  GHOST_WINDOW_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
  /** Same customer-local hour window. */
  GHOST_HOURS_START: 7,
  GHOST_HOURS_END: 21,
};

// ─── Per-lead state ──────────────────────────────────────────────────────

interface LeadCadenceState {
  Chatbot_Attempt_Count?: number;
  Chatbot_Follow_up_Count?: number;
  PRD_Stage?: string;
  PRD_Status?: string;
  PRD_Last_Action_Time?: string;
  Site_Visit_Date?: string;
}

/** Has chatbot exhausted its follow-up budget? */
export function chatbotExhausted(lead: LeadCadenceState): boolean {
  return (lead.Chatbot_Follow_up_Count ?? 0) >= CFG.CHATBOT_FOLLOWUP_MAX_ATTEMPTS;
}

// ─── Counter increment helpers (persisted to Zoho + mirrored to Mongo) ───

export async function incrementChatbotAttempt(leadId: string, lead: LeadCadenceState): Promise<number> {
  const next = (lead.Chatbot_Attempt_Count ?? 0) + 1;
  const fields = {
    Chatbot_Attempt_Count: next,
    PRD_Last_Action: "Chatbot",
    PRD_Last_Action_Time: nowIso(),
  };
  await updateLead(leadId, fields);
  await mirrorLeadStateToMongo(leadId, fields);
  return next;
}

export async function incrementChatbotFollowup(leadId: string, lead: LeadCadenceState): Promise<number> {
  const next = (lead.Chatbot_Follow_up_Count ?? 0) + 1;
  const fields = {
    Chatbot_Follow_up_Count: next,
    PRD_Last_Action: "Chatbot",
    PRD_Last_Action_Time: nowIso(),
  };
  await updateLead(leadId, fields);
  await mirrorLeadStateToMongo(leadId, fields);
  return next;
}

/** ISO timestamp with timezone — used everywhere for Zoho datetime fields. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
