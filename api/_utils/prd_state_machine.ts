/**
 * Lead Qualification + Site Visit Automation — state machine
 * Implements PRD v1.0 sections 6, 7, 8, 9 + the T=0 deviation
 * (per Mukund: at lead create, both chatbot + AI call fire in parallel
 * rather than chatbot-first then call-after-SF).
 *
 * Stages (PRD section 6.1):
 *   New Lead         — lead just entered, qualification just started
 *   Lead Initiated   — intent shown, working toward site visit
 *   Pre Site Visit   — site visit scheduled
 *   Not Interested   — terminal (closed / paused / non-responsive)
 *
 * Statuses (PRD section 6.2):
 *   NA               — system needs to act (trigger chatbot/call)
 *   CF               — customer replied to chatbot (chatbot-only flag)
 *   SF               — customer did NOT reply to chatbot (follow-up loop)
 *   CS               — customer scheduled callback at preferred time
 *   SS               — system scheduled call (no preferred time / no answer)
 *
 * CRITICAL RULE (PRD section 6.2 + 8.3 + 12):
 *   CF is ONLY for chatbot replies. Call answers NEVER set CF.
 *
 * Global overrides (PRD section 9) — apply from ANY stage/status:
 *   Customer wants site visit  → Pre Site Visit / NA
 *   Customer says not interested → Not Interested / NA
 */
import { updateLead } from "./zoho";
import { mirrorLeadStateToMongo } from "./supabase";

// ─── Canonical Stage + Status values (mirror Zoho picklist values) ──────
export type Stage =
  | "New Lead"
  | "Lead Initiated"
  | "Pre Site Visit"
  | "Not Interested";

export type Status =
  | "NA"
  | "CF"
  | "SF"
  | "CS"
  | "SS";

export type LastAction = "Chatbot" | "AI Call" | "Manual";

export type NotInterestedReason =
  | "Not Interested"
  | "User Not Responding"
  | "Budget Issue"
  | "Visit Confirmation Failed"
  | "Other";

// ─── Stage × Status validity (per PRD sections 6.2 + 8.1–8.6) ───────────
// "Not Interested" is terminal — Status irrelevant.
// "Pre Site Visit" supports NA / SF / SS (no CS, no CF — call-only confirmation flow).
const VALID_STATUS_PER_STAGE: Record<Stage, Set<Status>> = {
  "New Lead":       new Set(["NA", "CF", "SF", "CS", "SS"]),
  "Lead Initiated": new Set(["NA", "CF", "SF", "CS", "SS"]),
  "Pre Site Visit": new Set(["NA", "SF", "SS"]),
  "Not Interested": new Set(),
};

// Default Status when transitioning to a stage (PRD-aligned)
const DEFAULT_STATUS_PER_STAGE: Partial<Record<Stage, Status>> = {
  "New Lead":       "NA",
  "Lead Initiated": "SS",  // most common entry (intent w/o time)
  "Pre Site Visit": "NA",
  // Not Interested: no Status
};

// ─── Input to every transition ───────────────────────────────────────────
export interface TransitionInput {
  leadId: string;
  newStage: Stage;
  /** If null, defaults to DEFAULT_STATUS_PER_STAGE[newStage]. */
  newStatus?: Status | null;
  /** Free-text reason for audit (e.g. "first_inbound_chatbot", "site_visit_booked"). */
  reason: string;
  /** Optional fields to set in the same transaction. */
  extraFields?: Record<string, any>;
  /** Pre-fetched existing lead to detect global override conditions (opt-out etc.).
   *  If omitted, transition still works but global overrides can't fire. */
  existingLead?: any;
}

export interface TransitionResult {
  ok: boolean;
  applied: boolean;
  finalStage: Stage;
  finalStatus: Status | null;
  reason: string;
  message?: string;
}

/**
 * Single entrypoint for every Stage/Status change. Mirrors PRD's
 * "Every action must update Last Action and Last Action Time"
 * (section 12) — always writes audit fields.
 *
 * Returns finalStage + finalStatus AFTER validity adjustment.
 */
export async function transitionStage(input: TransitionInput): Promise<TransitionResult> {
  let targetStage: Stage = input.newStage;
  let targetStatus: Status | null = input.newStatus ?? DEFAULT_STATUS_PER_STAGE[targetStage] ?? null;
  const effectiveReason = input.reason;

  // ── Milestone protection: never auto-downgrade OUT of "Pre Site Visit" ────
  // Once a lead has booked a site visit (the furthest automated milestone), a
  // later call/chatbot outcome must NOT push it back to Lead Initiated / New
  // Lead / Not Interested — the max milestone is preserved so a "not
  // interested" on a follow-up call doesn't erase a scheduled site visit.
  // (Sales can still change it manually in Zoho; this only guards our
  // automated transitions, which always pass existingLead.)
  const currentStage = input.existingLead?.PRD_Stage as Stage | undefined;
  if (currentStage === "Pre Site Visit" && targetStage !== "Pre Site Visit") {
    console.log(
      `[PRD State] Lead ${input.leadId}: stage move "${currentStage}" → "${targetStage}" ` +
      `BLOCKED (milestone preserved; reason=${effectiveReason}). Recording audit only.`,
    );
    targetStage = "Pre Site Visit";
    if (!targetStatus || !VALID_STATUS_PER_STAGE["Pre Site Visit"].has(targetStatus)) {
      targetStatus = DEFAULT_STATUS_PER_STAGE["Pre Site Visit"] ?? "NA";
    }
  }

  // ── Status validity (skip for Not Interested — terminal) ─────────────
  if (targetStage !== "Not Interested") {
    const validSet = VALID_STATUS_PER_STAGE[targetStage];
    if (targetStatus && !validSet.has(targetStatus)) {
      console.warn(
        `[PRD State] Invalid Status "${targetStatus}" for Stage "${targetStage}". ` +
        `Falling back to default "${DEFAULT_STATUS_PER_STAGE[targetStage]}".`,
      );
      targetStatus = DEFAULT_STATUS_PER_STAGE[targetStage] ?? null;
    }
  } else {
    targetStatus = null;
  }

  // ── Build update payload ──────────────────────────────────────────────
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const updates: Record<string, any> = {
    PRD_Stage: targetStage,
    PRD_Status: targetStatus,
    PRD_Last_Action_Time: now,
    ...(input.extraFields || {}),
  };

  // PRD section 9: Not Interested stage → terminal cleanup
  // PRD section 8.6: Pre Site Visit → track Site_Visit_Date upstream

  try {
    await updateLead(input.leadId, updates);
    // Mirror to Mongo — every state transition (Stage/Status/extraFields)
    // also lands in the Mongo `leads` doc for downstream readers.
    await mirrorLeadStateToMongo(input.leadId, updates);
    console.log(
      `[PRD State] Lead ${input.leadId}: → ${targetStage}/${targetStatus || "(terminal)"} ` +
      `reason=${effectiveReason}`,
    );
    return {
      ok: true,
      applied: true,
      finalStage: targetStage,
      finalStatus: targetStatus,
      reason: effectiveReason,
    };
  } catch (err: any) {
    console.error(`[PRD State] Transition failed for lead ${input.leadId}: ${err.message}`);
    return {
      ok: false,
      applied: false,
      finalStage: targetStage,
      finalStatus: targetStatus,
      reason: effectiveReason,
      message: err.message,
    };
  }
}

// ─── Convenience helpers — common transitions ────────────────────────────

/** Lead just created: New Lead / NA. Triggers T=0 fan-out (chatbot + AI call). */
export async function onLeadCreated(leadId: string, lead?: any): Promise<TransitionResult> {
  return transitionStage({
    leadId,
    newStage: "New Lead",
    newStatus: "NA",
    reason: "lead_created",
    existingLead: lead,
  });
}

/** Chatbot reply received → status CF (PRD section 8.2). */
export async function onChatbotReply(leadId: string, lead?: any, customerMessage?: string): Promise<TransitionResult> {
  const currentStage = (lead?.PRD_Stage as Stage) || "New Lead";
  return transitionStage({
    leadId,
    newStage: currentStage,
    newStatus: "CF",
    reason: "chatbot_reply",
    extraFields: {
      PRD_Last_Action: "Chatbot",
      ...(customerMessage ? { Last_Customer_Response: customerMessage.slice(0, 2000) } : {}),
    },
    existingLead: lead,
  });
}

/** Chatbot follow-up reached without reply → status SF (PRD section 8.1). */
export async function onChatbotNoReply(leadId: string, lead?: any): Promise<TransitionResult> {
  const currentStage = (lead?.PRD_Stage as Stage) || "New Lead";
  return transitionStage({
    leadId,
    newStage: currentStage,
    newStatus: "SF",
    reason: "chatbot_no_reply_after_window",
    existingLead: lead,
  });
}

/** Customer gave preferred call time → Lead Initiated / CS (PRD section 8.2). */
export async function onPreferredTimeGiven(
  leadId: string,
  lead?: any,
  preferredTime?: string,
): Promise<TransitionResult> {
  return transitionStage({
    leadId,
    newStage: "Lead Initiated",
    newStatus: "CS",
    reason: "preferred_call_time_given",
    extraFields: preferredTime ? { Preferred_Call_Time: preferredTime } : {},
    existingLead: lead,
  });
}

/** Customer shows intent but no time → Lead Initiated / SS (PRD section 8.2). */
export async function onIntentNoTime(leadId: string, lead?: any): Promise<TransitionResult> {
  return transitionStage({
    leadId,
    newStage: "Lead Initiated",
    newStatus: "SS",
    reason: "intent_no_time",
    extraFields: { Intent_Captured: true },
    existingLead: lead,
  });
}

/** GLOBAL OVERRIDE: Customer wants site visit → Pre Site Visit / NA (PRD section 9). */
export async function onSiteVisitBooked(
  leadId: string,
  lead?: any,
  visitDate?: string,
): Promise<TransitionResult> {
  return transitionStage({
    leadId,
    newStage: "Pre Site Visit",
    newStatus: "NA",
    reason: "site_visit_booked",
    extraFields: visitDate ? { Site_Visit_Date: visitDate } : {},
    existingLead: lead,
  });
}

/** GLOBAL OVERRIDE: Customer says not interested → Not Interested / NA (PRD section 9). */
export async function onNotInterested(
  leadId: string,
  lead?: any,
  reason: NotInterestedReason = "Not Interested",
): Promise<TransitionResult> {
  return transitionStage({
    leadId,
    newStage: "Not Interested",
    newStatus: null,
    reason: "not_interested",
    extraFields: { Not_Interested_Reason: reason },
    existingLead: lead,
  });
}

/** Call answered — outcome routes to next state per PRD sections 8.3 / 8.4.
 *  CRITICAL: this NEVER sets status to CF (call is not chatbot). */
export type CallOutcome =
  | "answered_gave_time"
  | "answered_intent_no_time"
  | "answered_wants_site_visit"
  | "answered_not_interested"
  | "not_answered";

export async function onCallOutcome(
  leadId: string,
  lead: any,
  outcome: CallOutcome,
  details?: { preferredTime?: string; visitDate?: string },
): Promise<TransitionResult> {
  switch (outcome) {
    case "answered_gave_time":
      return transitionStage({
        leadId,
        newStage: "Lead Initiated",
        newStatus: "CS",
        reason: "call_answered_preferred_time",
        extraFields: {
          PRD_Last_Action: "AI Call",
          ...(details?.preferredTime ? { Preferred_Call_Time: details.preferredTime } : {}),
        },
        existingLead: lead,
      });
    case "answered_intent_no_time":
      return transitionStage({
        leadId,
        newStage: "Lead Initiated",
        newStatus: "SS",
        reason: "call_answered_intent_no_time",
        extraFields: { PRD_Last_Action: "AI Call", Intent_Captured: true },
        existingLead: lead,
      });
    case "answered_wants_site_visit":
      return onSiteVisitBooked(leadId, lead, details?.visitDate);
    case "answered_not_interested":
      return onNotInterested(leadId, lead, "Not Interested");
    case "not_answered":
      // Per PRD 8.4: move to Lead Initiated / SS (or SS tree continuation)
      return transitionStage({
        leadId,
        newStage: "Lead Initiated",
        newStatus: "SS",
        reason: "call_not_answered",
        extraFields: { PRD_Last_Action: "AI Call" },
        existingLead: lead,
      });
  }
}

/**
 * SS tree exhausted (max attempts hit without any answer) → terminal
 * Not Interested with reason "User Not Responding" (PRD section 8.5).
 *
 * Per user override (Option Y from clarifications): we wait until BOTH
 * chatbot AND call channels exhaust before marking. Caller decides when.
 */
export async function onSsTreeExhausted(leadId: string, lead?: any): Promise<TransitionResult> {
  return onNotInterested(leadId, lead, "User Not Responding");
}

/**
 * Pre Site Visit confirmation SS tree exhausted (PRD section 8.6 + user
 * Option A clarification) → terminal Not Interested with reason
 * "Visit Confirmation Failed".
 */
export async function onPreSiteVisitSsExhausted(leadId: string, lead?: any): Promise<TransitionResult> {
  return onNotInterested(leadId, lead, "Visit Confirmation Failed");
}
