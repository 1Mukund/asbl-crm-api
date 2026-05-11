/**
 * ASBL Loft state machine — Vercel TypeScript implementation of spec
 * Section 7 (Transition rules) and Section 11 (Deluge functions).
 *
 * Per spec, every Stage transition goes through fn_TransitionStage(),
 * which enforces the universal overrides (opt-out, broker), writes the
 * audit fields, runs side effects, and fires ad-platform events.
 *
 * This module is the canonical entrypoint — webhooks, cadences,
 * compliance handlers all call into transitionStage() rather than
 * touching Stage/Status fields directly. Direct field updates outside
 * this module skip audit logging and break the state machine guarantees.
 */
import { updateLead } from "./zoho";

// ─── Canonical Stage + Status values (mirror Zoho picklist values) ──────
export type Stage =
  | "New Lead"
  | "In Conversation"
  | "Site Visit Scheduled"
  | "Site Visit Done"
  | "Booked"
  | "Closed";

export type Status =
  | "Outreach Pending"
  | "Talking"
  | "Awaiting Reply"
  | "No Response"
  | "Callback Pending";

export type StateChangeSource =
  | "whatsapp_bot"
  | "voice_bot"
  | "chatbot"
  | "system"
  | "vendor_webhook"
  | "manual";

export type ClosureReason =
  | "Not Interested"
  | "Unreachable"
  | "Wrong Number"
  | "Broker"
  | "Visit No-Show"
  | "Opted Out"
  | "Disqualified";

// ─── Stage × Status validity matrix (spec section 4.1) ──────────────────
const VALID_STATUS_PER_STAGE: Record<Stage, Set<Status>> = {
  "New Lead": new Set(["Outreach Pending", "Talking", "Awaiting Reply", "No Response", "Callback Pending"]),
  "In Conversation": new Set(["Outreach Pending", "Talking", "Awaiting Reply", "No Response", "Callback Pending"]),
  "Site Visit Scheduled": new Set(["Outreach Pending", "Talking", "Awaiting Reply", "No Response"]),
  "Site Visit Done": new Set(["Outreach Pending", "Talking", "Awaiting Reply", "No Response", "Callback Pending"]),
  // Booked + Closed are terminal — Status is irrelevant
  Booked: new Set(),
  Closed: new Set(),
};

// ─── Default Status per Stage (spec section 4.1) ────────────────────────
const DEFAULT_STATUS_PER_STAGE: Partial<Record<Stage, Status>> = {
  "New Lead": "Outreach Pending",
  "In Conversation": "Talking",
  "Site Visit Scheduled": "Awaiting Reply",
  "Site Visit Done": "Outreach Pending",
};

// ─── Reason → Closure reason mapping (spec section 11) ──────────────────
const REASON_TO_CLOSURE: Record<string, ClosureReason> = {
  opt_out: "Opted Out",
  not_interested: "Not Interested",
  unreachable: "Unreachable",
  recovery_exhausted: "Unreachable",
  cadence_exhausted: "Unreachable",
  wrong_number: "Wrong Number",
  broker: "Broker",
  visit_no_show: "Visit No-Show",
  disqualified: "Disqualified",
};

export interface TransitionInput {
  leadId: string;
  newStage: Stage;
  /** Optional — if null, defaults to DEFAULT_STATUS_PER_STAGE[newStage]. */
  newStatus?: Status | null;
  reason: string;
  source?: StateChangeSource;
  /** Pre-fetched existing lead to avoid re-fetching. Optional. */
  existingLead?: any;
}

export interface TransitionResult {
  ok: boolean;
  applied: boolean;
  finalStage: Stage;
  finalStatus: Status | null;
  reason: string;
  closureReason?: ClosureReason;
  message?: string;
}

/**
 * Single entrypoint for every Stage change. Mirrors spec section 11's
 * fn_TransitionStage. Enforces:
 *   - Universal overrides (opt-out / broker → Closed)
 *   - Stage × Status validity (per section 4.1)
 *   - Audit fields (Stage_Updated_At, Status_Updated_At, Last_State_*)
 *   - Closure reason mapping for terminal states
 *   - Booking date / closed at timestamps
 *
 * Does NOT fire side effects (cadence enrollment / ad events) — those
 * are handled by the caller via separate helpers so transition logic
 * stays focused. See spec section 7 transition tables for per-row side
 * effects (cancel cadence, enroll cadence, fire ad event).
 */
export async function transitionStage(input: TransitionInput): Promise<TransitionResult> {
  const lead = input.existingLead;
  const currentStage: string | undefined = lead?.Stage;
  const currentStatus: string | undefined = lead?.Status;
  const isOptOutAll = lead?.F_Opt_Out_All === true;
  const isBroker = lead?.F_Marked_Broker === true;

  let targetStage: Stage = input.newStage;
  let targetStatus: Status | null = input.newStatus ?? DEFAULT_STATUS_PER_STAGE[targetStage] ?? null;
  let effectiveReason = input.reason;

  // ── Universal overrides (spec section 7.6) ────────────────────────────
  // These always win over the requested transition.
  if (effectiveReason !== "opt_out" && isOptOutAll) {
    targetStage = "Closed";
    targetStatus = null;
    effectiveReason = "opt_out";
  }
  if (effectiveReason !== "broker" && isBroker) {
    targetStage = "Closed";
    targetStatus = null;
    effectiveReason = "broker";
  }

  // ── No-op guard ──
  if (currentStage === targetStage && currentStatus === (targetStatus || "")) {
    return {
      ok: true,
      applied: false,
      finalStage: targetStage,
      finalStatus: targetStatus,
      reason: effectiveReason,
      message: "no_change",
    };
  }

  // ── Status validity (only for non-terminal stages) ────────────────────
  if (targetStage !== "Booked" && targetStage !== "Closed") {
    if (targetStatus && !VALID_STATUS_PER_STAGE[targetStage].has(targetStatus)) {
      // Caller specified an invalid Status for this Stage — fall back
      // to the default for safety, never crash.
      console.warn(
        `[StateMachine] Invalid Status "${targetStatus}" for Stage "${targetStage}". ` +
        `Falling back to default "${DEFAULT_STATUS_PER_STAGE[targetStage]}".`,
      );
      targetStatus = DEFAULT_STATUS_PER_STAGE[targetStage] ?? null;
    }
  }

  // ── Build update payload ──────────────────────────────────────────────
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const updates: Record<string, any> = {
    Stage: targetStage,
    Stage_Updated_At: now,
    Last_State_Change_Source: input.source || "system",
    Last_State_Change_Reason: effectiveReason.slice(0, 200),
  };
  if (targetStage === "Booked" || targetStage === "Closed") {
    // Terminal — wipe Status so list views don't show stale values.
    updates.Status = null;
  } else if (targetStatus) {
    updates.Status = targetStatus;
    updates.Status_Updated_At = now;
  }

  // Closure reason mapping for terminal Closed state
  let closureReason: ClosureReason | undefined;
  if (targetStage === "Closed") {
    closureReason = REASON_TO_CLOSURE[effectiveReason] || "Unreachable";
    updates.Closure_Reason = closureReason;
    updates.Closed_At = now;
  }
  if (targetStage === "Booked") {
    updates.Booking_Date = now.slice(0, 10);
  }

  try {
    await updateLead(input.leadId, updates);
    console.log(
      `[StateMachine] Lead ${input.leadId}: ${currentStage}/${currentStatus} → ${targetStage}/${targetStatus || "(terminal)"} ` +
      `reason=${effectiveReason} src=${updates.Last_State_Change_Source}`,
    );
    return {
      ok: true,
      applied: true,
      finalStage: targetStage,
      finalStatus: targetStatus,
      reason: effectiveReason,
      closureReason,
    };
  } catch (err: any) {
    console.error(`[StateMachine] Transition failed for lead ${input.leadId}: ${err.message}`);
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

/** Convenience: just set a Status within the current Stage (no Stage change). */
export async function setStatus(
  leadId: string,
  existingLead: any,
  newStatus: Status,
  reason: string,
  source: StateChangeSource = "system",
): Promise<TransitionResult> {
  const stage: Stage = existingLead?.Stage || "New Lead";
  return transitionStage({
    leadId,
    newStage: stage,
    newStatus,
    reason,
    source,
    existingLead,
  });
}

/** Convenience: simple "first inbound on either channel" handler from
 *  spec section 7.1. Bumps to In Conversation/Talking from New Lead,
 *  otherwise just marks Talking within current Stage. */
export async function handleInboundReply(
  leadId: string,
  existingLead: any,
  channel: "whatsapp" | "voice",
): Promise<TransitionResult> {
  const stage: Stage = existingLead?.Stage || "New Lead";
  if (stage === "New Lead") {
    return transitionStage({
      leadId,
      newStage: "In Conversation",
      newStatus: "Talking",
      reason: `first_inbound_${channel}`,
      source: channel === "whatsapp" ? "whatsapp_bot" : "voice_bot",
      existingLead,
    });
  }
  // Otherwise stay in current Stage, set Status to Talking
  return setStatus(leadId, existingLead, "Talking", `inbound_${channel}`, channel === "whatsapp" ? "whatsapp_bot" : "voice_bot");
}

/** Mark lead Closed with a specific reason (universal override #2 in spec 7.6). */
export async function closeLead(
  leadId: string,
  existingLead: any,
  reason: keyof typeof REASON_TO_CLOSURE | string,
  source: StateChangeSource = "system",
): Promise<TransitionResult> {
  return transitionStage({
    leadId,
    newStage: "Closed",
    newStatus: null,
    reason: String(reason),
    source,
    existingLead,
  });
}

/** Convenience: a customer sent a STOP / opt-out keyword. Sets Opt_Out_All
 *  flag AND closes the lead. Spec section 16.2 + 7.6. */
export async function optOutAll(
  leadId: string,
  existingLead: any,
  source: StateChangeSource = "system",
): Promise<TransitionResult> {
  // Set both opt-out flags first
  await updateLead(leadId, {
    Opt_Out_WhatsApp: true,
    Opt_Out_Calls: true,
    F_Opt_Out_All: true,
  });
  return closeLead(
    leadId,
    { ...existingLead, F_Opt_Out_All: true },
    "opt_out",
    source,
  );
}
