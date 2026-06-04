/**
 * PRD v1.0 — Cadence engine (chatbot follow-up loop + SS call tree).
 *
 * Per user clarification (Question 4): at T=0, BOTH chatbot message and
 * AI call fire simultaneously. After T=0, both channels follow PRD
 * timers INDEPENDENTLY. Per user Option Y: lead → Not Interested only
 * when BOTH channels exhaust.
 *
 * Configuration constants (PRD section 15 — user-confirmed defaults):
 */
import { updateLead } from "./zoho";
import { mirrorLeadStateToMongo } from "./supabase";

// ─── CONFIG (PRD section 15 — Sales/Product-decided values) ─────────────
export const CFG = {
  /** X for no chatbot response — time after initial msg before SF status. */
  CHATBOT_NO_REPLY_WINDOW_MS: 24 * 60 * 60 * 1000, // 24h

  /** Max chatbot follow-up attempts after SF (3 follow-ups). */
  CHATBOT_FOLLOWUP_MAX_ATTEMPTS: 3,
  /** Gap between chatbot follow-ups. */
  CHATBOT_FOLLOWUP_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24h

  /** Max SS tree call attempts (3 calls). */
  SS_CALL_MAX_ATTEMPTS: 3,
  /** Gap between SS tree call attempts. */
  SS_CALL_INTERVAL_MS: 4 * 60 * 60 * 1000, // 4h

  /** Pre Site Visit confirmation SS tree — same shape as main SS tree
   *  per user Option A clarification. */
  PRE_SITE_VISIT_CALL_MAX_ATTEMPTS: 3,
  PRE_SITE_VISIT_CALL_INTERVAL_MS: 4 * 60 * 60 * 1000, // 4h

  /** Default system-scheduled call time when customer hasn't given one.
   *  Per user: at T=0 immediate (no waiting). */
  SYSTEM_CALL_DEFAULT_DELAY_MS: 0,
};

// ─── Per-lead state read helpers ─────────────────────────────────────────

interface LeadCadenceState {
  Chatbot_Attempt_Count?: number;
  Chatbot_Follow_up_Count?: number;
  SS_Call_Attempt_Count?: number;
  PRD_Stage?: string;
  PRD_Status?: string;
  PRD_Last_Action_Time?: string;
  Site_Visit_Date?: string;
}

/** Has chatbot exhausted its follow-up budget? */
export function chatbotExhausted(lead: LeadCadenceState): boolean {
  return (lead.Chatbot_Follow_up_Count ?? 0) >= CFG.CHATBOT_FOLLOWUP_MAX_ATTEMPTS;
}

/** Has SS call tree exhausted its attempts? */
export function ssCallExhausted(lead: LeadCadenceState): boolean {
  return (lead.SS_Call_Attempt_Count ?? 0) >= CFG.SS_CALL_MAX_ATTEMPTS;
}

/** Both channels exhausted — per Option Y, trigger Not Interested. */
export function bothChannelsExhausted(lead: LeadCadenceState): boolean {
  return chatbotExhausted(lead) && ssCallExhausted(lead);
}

// ─── Counter increment helpers (persisted to Zoho) ───────────────────────

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

export async function incrementSsCallAttempt(leadId: string, lead: LeadCadenceState): Promise<number> {
  const next = (lead.SS_Call_Attempt_Count ?? 0) + 1;
  const fields = {
    SS_Call_Attempt_Count: next,
    PRD_Last_Action: "AI Call",
    PRD_Last_Action_Time: nowIso(),
  };
  await updateLead(leadId, fields);
  await mirrorLeadStateToMongo(leadId, fields);
  return next;
}

// ─── Timer helpers — when should the next action fire? ──────────────────

/** Next chatbot follow-up time, based on Last_Action_Time + interval. */
export function nextChatbotFollowupAt(lead: LeadCadenceState): Date {
  const last = lead.PRD_Last_Action_Time ? new Date(lead.PRD_Last_Action_Time) : new Date();
  return new Date(last.getTime() + CFG.CHATBOT_FOLLOWUP_INTERVAL_MS);
}

/** Next SS call time, based on Last_Action_Time + interval. */
export function nextSsCallAt(lead: LeadCadenceState): Date {
  const last = lead.PRD_Last_Action_Time ? new Date(lead.PRD_Last_Action_Time) : new Date();
  return new Date(last.getTime() + CFG.SS_CALL_INTERVAL_MS);
}

/** When the chatbot's no-reply timer expires (move NA→SF). */
export function chatbotNoReplyExpiresAt(lead: LeadCadenceState): Date {
  const last = lead.PRD_Last_Action_Time ? new Date(lead.PRD_Last_Action_Time) : new Date();
  return new Date(last.getTime() + CFG.CHATBOT_NO_REPLY_WINDOW_MS);
}

// ─── Pre-site-visit reminder/confirmation helpers ────────────────────────

/** Pre-site-visit reminder #1 (24h before visit). */
export function preSiteVisitReminder24hAt(siteVisitDate: string): Date {
  return new Date(new Date(siteVisitDate).getTime() - 24 * 60 * 60 * 1000);
}

/** Pre-site-visit reminder #2 (3h before visit). */
export function preSiteVisitReminder3hAt(siteVisitDate: string): Date {
  return new Date(new Date(siteVisitDate).getTime() - 3 * 60 * 60 * 1000);
}

/** ISO timestamp with timezone — used everywhere for Zoho datetime fields. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

// ─── Calling-hours gate (voice-bot enforces 9 AM-10 PM IST = +0530) ─────
// Voice-bot returns 403 "Outside calling hours" otherwise. We mirror the
// gate on our side so we don't burn relay calls + log noise for every
// PRD tick at night. Cron retries every 15 min; the first tick after
// 9 AM IST will fire the deferred call naturally.
export function isWithinCallingHours(now: Date = new Date()): boolean {
  // IST hour = UTC hour + 5 (+ 1 if UTC minutes >= 30) modulo 24
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const istHour = (utcH + 5 + (utcM >= 30 ? 1 : 0)) % 24;
  return istHour >= 9 && istHour < 22;
}
