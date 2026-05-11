/**
 * Cadence scheduler — spec section 12.
 *
 * Five cadences, all run by a single Vercel cron handler that wakes
 * every 5-10 minutes and processes leads whose Next_Action_At <= now.
 * Each cadence defines a sequence of steps. Lead's Active_Cadence +
 * Cadence_Step track position.
 *
 * Cadence config (each step has a delayMin after the previous step
 * fires, plus the action to perform):
 *
 *  outreach          — Stage = New Lead, default after lead create
 *    Step 1: T+0       parallel WA template + voice dial
 *    Step 2: T+15min   retry on whichever channel had no engagement
 *    Step 3: T+2h      second retry, both channels
 *    Step 4: T+24h     final WA template nudge
 *
 *  recovery          — Stage = New Lead, Status = No Response
 *    Step 1: T+0       WA recovery template
 *    Step 2: T+24h     voice retry
 *    Step 3: T+72h     final WA template
 *
 *  cooled            — Stage = In Conversation, Status = No Response
 *    Step 1: T+24h     single WA template re-engagement
 *
 *  reminder          — Stage = Site Visit Scheduled
 *    Step 1: T-24h before visit  WA reminder
 *    Step 2: T-3h before visit   WA reminder + voice call if no reply
 *
 *  decision_followup — Stage = Site Visit Done
 *    Step 1: T+1d      WA follow-up "How did the visit go?"
 *    Step 2: T+3d      Voice call to discuss decision
 *    Step 3: T+7d      WA final nudge with urgency
 *
 * Exit conditions per spec — handled by step-runners that check current
 * Stage/Status before acting, and the cron loop that recomputes
 * Next_Action_At after each step.
 */
import { updateLead } from "./zoho";

export type CadenceName = "outreach" | "recovery" | "cooled" | "reminder" | "decision_followup";

export type StepActionType = "send_wa_template" | "send_wa_message" | "dial" | "send_reminder" | "no_action";

export interface CadenceStep {
  /** Delay AFTER the previous step (in ms). First step uses delay from enrollment time. */
  delay_ms: number;
  /** What this step does. */
  action: StepActionType;
  /** WA template name when action = send_wa_template. */
  template_name?: string;
  /** Per-spec hint: which channel to use for retry on this step. */
  channel?: "whatsapp" | "voice" | "both";
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const CADENCES: Record<CadenceName, CadenceStep[]> = {
  outreach: [
    { delay_ms: 0,         action: "send_wa_template", template_name: "loft_welcome_v1", channel: "both" },
    { delay_ms: 15 * 60_000, action: "send_wa_template", template_name: "loft_nudge_v1", channel: "both" },
    { delay_ms: 2 * HOUR_MS, action: "send_wa_template", template_name: "loft_retry_v1", channel: "both" },
    { delay_ms: 24 * HOUR_MS, action: "send_wa_template", template_name: "loft_final_nudge_v1", channel: "whatsapp" },
  ],
  recovery: [
    { delay_ms: 0,           action: "send_wa_template", template_name: "loft_recovery_v1", channel: "whatsapp" },
    { delay_ms: 24 * HOUR_MS, action: "dial",                                                channel: "voice" },
    { delay_ms: 72 * HOUR_MS, action: "send_wa_template", template_name: "loft_recovery_final_v1", channel: "whatsapp" },
  ],
  cooled: [
    { delay_ms: 24 * HOUR_MS, action: "send_wa_template", template_name: "loft_cooled_v1", channel: "whatsapp" },
  ],
  reminder: [
    // Step 1: T-24h BEFORE visit (negative delay relative to Site_Visit_Date)
    { delay_ms: -24 * HOUR_MS, action: "send_reminder", template_name: "loft_reminder_24h_v1", channel: "whatsapp" },
    // Step 2: T-3h BEFORE visit
    { delay_ms: -3 * HOUR_MS,  action: "send_reminder", template_name: "loft_reminder_3h_v1", channel: "both" },
  ],
  decision_followup: [
    { delay_ms: 1 * DAY_MS, action: "send_wa_template", template_name: "loft_post_visit_v1", channel: "whatsapp" },
    { delay_ms: 3 * DAY_MS, action: "dial",                                                  channel: "voice" },
    { delay_ms: 7 * DAY_MS, action: "send_wa_template", template_name: "loft_post_visit_final_v1", channel: "whatsapp" },
  ],
};

/**
 * Enrol a lead in a cadence — sets Active_Cadence, Cadence_Step=1, and
 * Next_Action_At based on the first step's delay.
 *
 * For reminder cadence, the caller must pass siteVisitDate so we anchor
 * steps relative to that timestamp rather than enrolment time.
 */
export async function enrollCadence(
  leadId: string,
  cadence: CadenceName,
  opts: { siteVisitDate?: string } = {},
): Promise<{ ok: boolean; next_action_at: string; next_action_type: StepActionType }> {
  const steps = CADENCES[cadence as CadenceName];
  if (!steps || !steps.length) {
    throw new Error(`unknown cadence: ${cadence}`);
  }
  const firstStep = steps[0];

  // Anchor: reminder relative to site_visit_date, others relative to now
  let anchor: number;
  if (cadence === "reminder") {
    if (!opts.siteVisitDate) throw new Error("siteVisitDate required for reminder cadence");
    anchor = new Date(opts.siteVisitDate).getTime();
  } else {
    anchor = Date.now();
  }
  const nextActionAt = new Date(anchor + firstStep.delay_ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");

  await updateLead(leadId, {
    Active_Cadence: cadence,
    Cadence_Step: 1,
    Next_Action_At: nextActionAt,
    Next_Action_Type: firstStep.action,
  });
  console.log(
    `[Cadence] Lead ${leadId} enrolled in ${cadence} — step=1/${steps.length} ` +
    `next_action=${firstStep.action} at=${nextActionAt}`,
  );
  return { ok: true, next_action_at: nextActionAt, next_action_type: firstStep.action };
}

/**
 * Cancel the active cadence on a lead — used when Stage transitions
 * (e.g. visit confirmed, customer replied, lead Closed). Spec section 11
 * fn_CancelAllCadences equivalent.
 */
export async function cancelCadence(leadId: string): Promise<void> {
  try {
    await updateLead(leadId, {
      Active_Cadence: "none",
      Cadence_Step: 0,
      Next_Action_At: null,
      Next_Action_Type: "no_action",
    });
    console.log(`[Cadence] Lead ${leadId} cadence cancelled`);
  } catch (err: any) {
    console.error(`[Cadence] Cancel failed for ${leadId}: ${err.message}`);
  }
}

/**
 * Advance to the next step in the current cadence. If no more steps,
 * the cadence is considered exhausted — caller can fire next stage
 * transition (e.g. Closed • Unreachable for outreach exhausted).
 *
 * Returns step info + whether the cadence is now exhausted.
 */
export async function advanceCadence(
  leadId: string,
  lead: any,
): Promise<{ ok: boolean; advanced: boolean; exhausted: boolean; new_step?: number; next_action_at?: string; next_action_type?: StepActionType }> {
  const cadence = lead?.Active_Cadence as CadenceName | "none" | undefined;
  if (!cadence || (cadence as string) === "none") {
    return { ok: true, advanced: false, exhausted: false };
  }
  const steps = CADENCES[cadence as CadenceName];
  if (!steps) return { ok: false, advanced: false, exhausted: false };

  const currentStep = Number(lead?.Cadence_Step) || 0;
  const nextStepIdx = currentStep; // 1-indexed, so currentStep=1 means next is steps[1]
  if (nextStepIdx >= steps.length) {
    // Exhausted
    await cancelCadence(leadId);
    return { ok: true, advanced: false, exhausted: true };
  }
  const nextStep = steps[nextStepIdx];

  // Anchor for reminder is site_visit_date, else now
  let anchor: number;
  if (cadence === "reminder") {
    const svd = lead?.Site_Visit_Date;
    if (!svd) return { ok: false, advanced: false, exhausted: false };
    anchor = new Date(svd).getTime();
  } else {
    anchor = Date.now();
  }
  const nextActionAt = new Date(anchor + nextStep.delay_ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");

  await updateLead(leadId, {
    Cadence_Step: nextStepIdx + 1,
    Next_Action_At: nextActionAt,
    Next_Action_Type: nextStep.action,
  });
  return {
    ok: true,
    advanced: true,
    exhausted: false,
    new_step: nextStepIdx + 1,
    next_action_at: nextActionAt,
    next_action_type: nextStep.action,
  };
}

/** Look up the step config for a lead's current cadence + step. */
export function currentStepConfig(lead: any): CadenceStep | null {
  const cadence = lead?.Active_Cadence as CadenceName | "none" | undefined;
  if (!cadence || cadence === "none") return null;
  const steps = CADENCES[cadence as CadenceName];
  if (!steps) return null;
  const idx = (Number(lead?.Cadence_Step) || 1) - 1;
  return steps[idx] || null;
}
