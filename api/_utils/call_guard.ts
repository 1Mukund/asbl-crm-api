/**
 * EXECUTION-TIME (dial-time) call guard — the last line of defence before an
 * outbound AI call actually dials.
 *
 * Background (two production issues this closes):
 *   ISSUE 1 — Pre Site Visit / Not Interested / Spam leads still got AI calls.
 *   ISSUE 2 — one phone (MLID) got calls from multiple project records (PLIDs).
 *
 * Root cause for both: the cadence enforces "stop for a reached milestone /
 * closed lead" and "one primary caller per phone (LATEST-born project)" ONLY at
 * SCHEDULING time (the cron, on a possibly-stale paginated snapshot). Nothing
 * re-validated at EXECUTION time. So a stale/re-armed Next_Call_At, a cron
 * pagination race, a self-heal / safety-net reschedule, or a manual re-fire
 * could bypass both gates and dial the wrong / already-converted lead.
 *
 * This guard re-checks BOTH invariants right before the dial:
 *   1. TERMINAL gate  — read this lead's CURRENT stage cheaply + reliably from
 *      Mongo (leads doc keyed by the indexed zoho_lead_id). If it has reached a
 *      site-visit milestone or is closed → abort.
 *   2. PRIMARY gate   — re-derive the LATEST-born primary caller for the phone
 *      from the full sibling set (fetchLeadRecordsByPhone + pickPrimaryLeadId).
 *      If this record isn't that primary → abort. Siblings never dial.
 *
 * It is ADDITIVE — a safety net layered on top of the existing scheduling-time
 * gates, never a replacement. Every PROACTIVE dial funnels through
 * prd_orchestrator.fireAiCall (cron follow-up, self-heal, safety-net, retry,
 * and T=0), so wiring the guard there covers all of them in one place. Reactive
 * calls (customer "call me" / sales manual click) POST /api/relay/inhouse-call
 * directly and are intentionally NOT gated here — those are explicit consent.
 *
 * Fail-open: any read error on a sub-check is swallowed and that check is
 * skipped, so the guard itself can never silence the whole funnel. The two
 * checks are independent — a failure of the (phone-based) primary check never
 * disables the (id-based) terminal check.
 */
import { fetchLeadRecordsByPhone, pickPrimaryLeadId } from "./primary_lead";
import { isSiteVisitMilestone, isTerminalLeadStatus } from "./prd_state_machine";

export type CallBlockReason = "terminal" | "not-primary";

export interface CallGuardResult {
  allowed: boolean;
  blockedBy?: CallBlockReason;
  reason: string;
  primaryId?: string | null;
}

/** PRD_Stage values that mean "stop the cadence — never proactively dial". */
const TERMINAL_STAGES = new Set(["Pre Site Visit", "Not Interested", "Spam"]);

/**
 * Decide whether a PROACTIVE outbound call for `zohoLeadId` (on `phone`) is
 * still allowed at the moment of dialing. Read-only — the caller is
 * responsible for clearing a landmine Next_Call_At when this returns a block.
 */
export async function assertProactiveCallAllowed(opts: {
  zohoLeadId: string;
  phone: string;
}): Promise<CallGuardResult> {
  const { zohoLeadId, phone } = opts;

  // ── ISSUE 1 — TERMINAL gate ────────────────────────────────────────────
  // Cheap, reliable read of THIS lead's current stage from Mongo, keyed on the
  // indexed zoho_lead_id (always present + freshly mirrored by every PRD write
  // path). A brand-new T=0 lead whose doc isn't mirrored yet simply isn't
  // terminal, so a missing doc safely continues.
  if (zohoLeadId) {
    try {
      const { getCollection, COL } = await import("./mongo");
      const col = await getCollection<any>(COL.LEADS);
      const doc = await col.findOne(
        { zoho_lead_id: zohoLeadId } as any,
        { projection: { prd_stage: 1, lead_status: 1 } as any },
      );
      if (doc) {
        const stage = String(doc.prd_stage || "");
        const terminal =
          TERMINAL_STAGES.has(stage) ||
          isSiteVisitMilestone(stage) ||
          isTerminalLeadStatus(doc.lead_status);
        if (terminal) {
          return {
            allowed: false,
            blockedBy: "terminal",
            reason:
              `lead ${zohoLeadId} reached a terminal/milestone stage ` +
              `(PRD_Stage="${stage}", Lead_Status="${doc.lead_status ?? ""}") — dial aborted`,
          };
        }
      }
    } catch (err: any) {
      // Fail-open on this check only — continue to the primary gate.
      console.error(`[call_guard] terminal-check read failed (continuing): ${err.message}`);
    }
  }

  // ── ISSUE 2 — PRIMARY (latest-born) gate ───────────────────────────────
  // Re-derive the latest-born primary caller for the phone from the FULL
  // sibling set (Mongo-first; Zoho fallback inside the helper). Only that one
  // record may proactively dial; every sibling stays silent.
  if (phone) {
    try {
      const records = await fetchLeadRecordsByPhone(phone);
      if (records.length) {
        const hasThis = records.some((r) => String(r.id) === String(zohoLeadId));
        // A brand-new T=0 lead may not be in the sibling set yet. Treat it as
        // LATEST-born (born = now) so a genuine freshest-interest lead is never
        // falsely blocked — matching the "latest-born wins" primary rule.
        const pool = hasThis
          ? records
          : [
              {
                id: zohoLeadId,
                PRD_Stage: "New Lead",
                Inncircles_Born_Date: new Date().toISOString(),
              },
              ...records,
            ];
        const primaryId = pickPrimaryLeadId(pool);
        if (primaryId && String(primaryId) !== String(zohoLeadId)) {
          return {
            allowed: false,
            blockedBy: "not-primary",
            reason:
              `lead ${zohoLeadId} is not the latest-born primary caller for its ` +
              `phone (primary=${primaryId}) — dial aborted`,
            primaryId,
          };
        }
        return { allowed: true, reason: "ok — terminal + primary re-validated", primaryId };
      }
    } catch (err: any) {
      // Fail-open — the scheduling-time primary dedup remains the first line.
      console.error(`[call_guard] primary-check read failed (failing open): ${err.message}`);
    }
  }

  return { allowed: true, reason: "ok — no block condition found" };
}
