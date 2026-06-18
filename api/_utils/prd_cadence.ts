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

// ─── CONFIG ────────────────────────────────────────────────────────────────
export const CFG = {
  /** X for no chatbot response — time after initial msg before SF status. */
  CHATBOT_NO_REPLY_WINDOW_MS: 24 * 60 * 60 * 1000, // 24h

  /** Hard safety cap on total chatbot messages per lead. */
  CHATBOT_FOLLOWUP_MAX_ATTEMPTS: 30,

  /** Gap between chatbot follow-ups (2h aggressive cadence — 2026-06-09). */
  CHATBOT_FOLLOWUP_INTERVAL_MS: 2 * 60 * 60 * 1000, // 2h

  /** Total chatbot follow-up window per lead. After 7 days from creation
   *  (cold lead) → give up and auto-transition the lead to Not Interested. */
  CHATBOT_FOLLOWUP_WINDOW_MS: 7 * 24 * 60 * 60 * 1000, // 7 days

  /** Calling-hours gate for chatbot follow-ups (IST hour-of-day range).
   *  Customer ko aadhi raat ko WhatsApp ping nahi jana chahiye. */
  CHATBOT_HOURS_START_IST: 9,  // 9 AM IST
  CHATBOT_HOURS_END_IST: 21,   // 9 PM IST (exclusive)
};

/** True when current IST hour is within the chatbot follow-up window
 *  (CHATBOT_HOURS_START_IST .. CHATBOT_HOURS_END_IST). */
export function isWithinChatbotHours(now: Date = new Date()): boolean {
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const istHour = (utcH + 5 + (utcM >= 30 ? 1 : 0)) % 24;
  return istHour >= CFG.CHATBOT_HOURS_START_IST && istHour < CFG.CHATBOT_HOURS_END_IST;
}

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
