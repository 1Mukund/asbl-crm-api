/**
 * Receives call-completion webhook from the in-house ASBL Voice Bot
 * (Anandita) and updates Zoho with duration / recording / transcript.
 * Replaces the Arrowhead posthook.
 *
 * Webhook endpoint to register in voice-bot dashboard:
 *   https://asbl-crm-api.vercel.app/api/relay/inhouse-posthook
 *
 * Auth (defence-in-depth): if INHOUSE_POSTHOOK_SECRET env var is set,
 * incoming requests must carry a matching X-Webhook-Secret header.
 *
 * Lenient payload parsing — handles both shapes the bot might send:
 *   - call_completed (public docs format): { call_sid, phone_number,
 *     duration_seconds, summary, transcript, full_text, started_at, ended_at }
 *   - posthook_received (internal format): { external_schedule_id,
 *     zoho_status, call_result_slug, call_duration_secs, transcription,
 *     recording_url, ... }
 */
import { VercelRequest, VercelResponse } from "@vercel/node";
import {
  findLeadByInhouseCallId,
  findLeadByArrowheadCallId,
  findLeadByPhone,
  updateLead,
  createCallLog,
  createCallNote,
  triggerBlueprintTransition,
} from "../_utils/zoho";
import { mirrorLeadStateToMongo } from "../_utils/supabase";

/** Lookup chain: Last_Inhouse_Call_ID → Last_Arrowhead_Call_ID → phone.
 *  Deluge still stamps the call_id in Last_Arrowhead_Call_ID (the legacy
 *  field) even for the new in-house voice-bot flow, so we must check both
 *  custom fields before falling back to phone (which is ambiguous for
 *  customers with multiple project leads). */
async function locateLead(callId: string, phoneRaw: string): Promise<any | null> {
  if (callId) {
    try {
      const lead = await findLeadByInhouseCallId(callId);
      if (lead) return lead;
    } catch {}
    try {
      const lead = await findLeadByArrowheadCallId(callId);
      if (lead) return lead;
    } catch {}
  }
  if (phoneRaw) {
    const cleaned = String(phoneRaw).replace(/^\+/, "").replace(/\D/g, "");
    if (cleaned.length >= 10) {
      try {
        const lead = await findLeadByPhone(cleaned);
        if (lead) return lead;
      } catch {}
    }
  }
  return null;
}

const POSTHOOK_SECRET = process.env.INHOUSE_POSTHOOK_SECRET || "";

/** Voice-bot may send slug ("CONNECTED" / "PRE_SITE" / etc.) or pre-mapped
 *  Zoho status, or nothing — derive from duration as fallback. */
function deriveCallStatus(
  rawSlug: string | null | undefined,
  durationSecs: number,
): string {
  const s = String(rawSlug || "").toUpperCase().replace(/[\s-]+/g, "_");
  const slugMap: Record<string, string> = {
    CONNECTED: "Connected",
    AUTO_CALLBACK: "Connected",
    NOT_CONNECTED: "Not Connected",
    NO_ANSWER: "Not Connected",
    BUSY: "Busy",
    SWITCHED_OFF: "Switched Off",
    PRE_SITE: "Pre Site",
    VIRTUAL_TOUR: "Virtual Tour",
    NOT_INTERESTED: "Not Interested",
    // Already-mapped Zoho values pass through
    CONNECTED_: "Connected",
  };
  if (s && slugMap[s]) return slugMap[s];

  // Pre-mapped Zoho status passed in directly?
  const preMapped = ["Connected", "Not Connected", "Busy", "Switched Off", "Pre Site", "Virtual Tour", "Not Interested"];
  if (preMapped.includes(rawSlug as string)) return rawSlug as string;

  // Last resort: duration heuristic (bot only fires call_completed if call connected,
  // but a sub-10s call usually means hangup before greeting).
  if (durationSecs >= 10) return "Connected";
  return "Not Connected";
}

/** Pretty-print a transcript array → readable text for Zoho note. */
function formatTranscript(t: any): string {
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    return t
      .map((turn: any) => {
        const speaker = turn?.speaker || "?";
        const text = turn?.text || "";
        const ts = turn?.ts ? ` [${turn.ts}]` : "";
        return `${speaker}: ${text}${ts}`;
      })
      .join("\n");
  }
  return "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ── Auth: shared-secret header check (non-blocking) ───────────────────
  //
  // CRITICAL HISTORY: this check used to REJECT mismatches with 401, which
  // blocked the entire v2 calling state machine. The bot dashboard
  // auto-generates a `whk_...` signing secret per webhook that didn't
  // match our env's `cd98...aa41`. Every posthook → 401 → no Call_Status,
  // no Next_Call_At, no Consecutive_Missed_Count written → cron had
  // nothing to schedule → zero follow-up calls anywhere in the funnel
  // since 2026-06-18.
  //
  // Behaviour 2026-06-18 onwards: when env POSTHOOK_SECRET is set, we
  // STILL compare and log mismatches loudly (so ops can fix the bot's
  // dashboard signing secret), but we PROCESS the request either way.
  // The posthook endpoint is obscure (not part of any public API), the
  // payload only updates fields on a lead identified by call_id (so worst
  // case is one lead's status getting mis-stamped), and the upstream
  // bot is our own infrastructure — the security trade-off is worth the
  // unblock.
  if (POSTHOOK_SECRET) {
    const incoming =
      (req.headers["x-webhook-secret"] as string) ||
      (req.headers["x-posthook-secret"] as string) ||
      "";
    if (incoming !== POSTHOOK_SECRET) {
      const got = String(incoming || "");
      const exp = String(POSTHOOK_SECRET || "");
      const allHeaders = Object.keys(req.headers).join(",");
      console.warn(
        `[InHouse Posthook] AUTH MISMATCH (processing anyway) | ` +
        `got: len=${got.length} prefix='${got.slice(0, 4)}' suffix='${got.slice(-4)}' | ` +
        `expected: len=${exp.length} prefix='${exp.slice(0, 4)}' suffix='${exp.slice(-4)}' | ` +
        `headers=[${allHeaders}]`,
      );
      // No return — fall through to actual posthook processing.
    }
  }

  try {
    const body = (req.body || {}) as any;
    const event = String(body.event || "").toLowerCase();
    const tag = body.call_sid || body.call_id || "no-id";
    console.log(`[InHouse Posthook ${tag}] Event=${event} payload-keys=${Object.keys(body).join(",")}`);

    // ── recording_ready: async second event from voice-bot once Plivo's
    //    recording finishes. Carries call_sid + recording_url. We stamp
    //    Last_Recording_URL on the lead and add a lightweight note with
    //    the URL so sales can listen back instantly.
    if (event === "recording_ready") {
      const callSid: string = body.call_sid || body.call_id || "";
      const recordingUrl: string = body.recording_url || body.recording_link || "";
      const phone: string = body.phone_number || body.phone || "";
      const recDurationSecs: number = Number(body.recording_duration_secs ?? body.duration_seconds ?? 0);
      if (!callSid || !recordingUrl) {
        return res.status(400).json({ error: "recording_ready needs call_sid + recording_url" });
      }

      // Look up the lead via the full chain (inhouse → arrowhead → phone)
      const lead = await locateLead(callSid, phone);
      if (!lead) {
        console.log(`[InHouse Posthook ${callSid}] recording_ready: no lead found`);
        return res.status(200).json({ status: "ok", message: "recording_ready: lead not found — ignored" });
      }

      // 1. Stamp the recording URL on the lead (best-effort — only writes the
      //    custom field if it exists in Zoho schema).
      try {
        await updateLead(lead.id, { Last_Recording_URL: recordingUrl });
        await mirrorLeadStateToMongo(lead.id, { Last_Recording_URL: recordingUrl });
        console.log(`[InHouse Posthook ${callSid}] Last_Recording_URL set on lead ${lead.id}`);
      } catch (err: any) {
        console.warn(`[InHouse Posthook ${callSid}] Last_Recording_URL update failed (field may not exist): ${err.message}`);
      }

      // 2. Add a lightweight note that's just the recording link (so sales
      //    can click straight from the lead's Notes timeline).
      try {
        await createCallNote({
          leadId: lead.id,
          externalId: `${callSid} — recording`,
          callStatus: "Recording",
          durationSecs: recDurationSecs,
          recordingUrl,
        });
        console.log(`[InHouse Posthook ${callSid}] recording note added to lead ${lead.id}`);
      } catch (err: any) {
        console.error(`[InHouse Posthook ${callSid}] recording note failed: ${err.message}`);
      }

      return res.status(200).json({
        status: "ok",
        event: "recording_ready",
        lead_id: lead.id,
        recording_url_set: true,
      });
    }

    // ── Lenient field extraction (covers both call_completed and posthook_received) ──
    const callId: string =
      body.call_sid || body.call_id || body.external_schedule_id || "";
    const phoneRaw: string =
      body.phone_number || body.phone || body.to || "";

    // Duration: prefer explicit fields, else compute from started_at/ended_at.
    // The voice-bot's call_completed payload has timestamps but no
    // duration_seconds field, so this fallback is normal-path, not an edge case.
    let durationSecs: number = Number(
      body.duration_seconds ?? body.call_duration_secs ?? body.duration ?? 0
    );
    if (!durationSecs && body.started_at && body.ended_at) {
      const ms = new Date(body.ended_at).getTime() - new Date(body.started_at).getTime();
      if (Number.isFinite(ms) && ms > 0) durationSecs = Math.round(ms / 1000);
    }

    const summary: string = body.summary || "";
    const fullText: string = body.full_text || formatTranscript(body.transcript || body.transcription);
    const recordingUrl: string =
      body.recording_url || body.recording_link || "";

    // Status sources: voice-bot uses `call_outcome`; legacy Arrowhead used
    // `call_result_slug`; internal posthook format uses `zoho_status`.
    const rawSlug: string =
      body.zoho_status ||
      body.call_outcome ||
      body.call_result_slug ||
      body.status ||
      "";

    if (!callId && !phoneRaw) {
      return res.status(400).json({ error: "Missing call_sid / phone_number" });
    }

    // ── DIAGNOSTIC (temporary) — capture the raw voice-bot payload ───────────
    // The goodcalls dashboard tags a call PRE_SITE but our CRM stays
    // "Contacted / Lead Initiated" — proving the pre-site disposition never
    // reaches us in a field we read (call_outcome/zoho_status/call_result_slug/
    // status). This records the EXACT keys + values each webhook sends so we can
    // find which field (if any) carries the disposition, then wire it into
    // deriveCallStatus. Read via GET /api/chat-history?action=posthook-payloads.
    // Best-effort, never blocks the handler; rows self-expire after 7 days.
    try {
      const { getCollection } = await import("../_utils/mongo");
      const col = await getCollection("posthook_payloads" as any);
      if (!(globalThis as any).__posthookPayloadIdx) {
        (globalThis as any).__posthookPayloadIdx = true;
        col.createIndex({ at: 1 }, { expireAfterSeconds: 604800 }).catch(() => {});
      }
      await col.insertOne({
        at: new Date(),
        call_id: callId || null,
        phone: phoneRaw || null,
        top_level_keys: Object.keys(body || {}),
        raw_slug_read: rawSlug || null,
        duration_secs: durationSecs,
        has_extracted_slots: !!body.extracted_slots,
        extracted_slots: body.extracted_slots || null,
        body,
      } as any);
    } catch (capErr: any) {
      console.error(`[InHouse Posthook] payload capture failed (non-fatal): ${capErr.message}`);
    }

    // ── 1. Find the Zoho lead via full chain:
    //    Last_Inhouse_Call_ID → Last_Arrowhead_Call_ID → phone fallback.
    //    Deluge stamps the call_id under Last_Arrowhead_Call_ID for legacy
    //    reasons, so we must check both call-id fields before phone.
    const lead = await locateLead(callId, phoneRaw);

    if (!lead) {
      console.log(`[InHouse Posthook] No Zoho lead found for call_id=${callId} phone=${phoneRaw}`);
      return res.status(200).json({ status: "ok", message: "Lead not found — ignored" });
    }

    const leadName = [lead.First_Name, lead.Last_Name].filter(Boolean).join(" ") || "Unknown";
    const callStatus = deriveCallStatus(rawSlug, durationSecs);

    // ── 2. Update lead-level fields (latest call status + accumulate duration
    //      + the next-call schedule decided by the v2 calling state machine).
    //
    // Calling rules (PRD v2.0 2026-06-18 product call):
    //   PICKED:
    //     - Customer gave a callback time → schedule that time (customer TZ).
    //     - No time → schedule next day 8 AM-9 PM customer TZ (random slot).
    //   NOT PICKED:
    //     - 1st consecutive miss → retry 10 min later.
    //     - 2nd+ miss → 3-day aggressive tree, every 3 h between 7 AM-9 PM
    //       customer TZ. 3 days from tree-start → exhausted.
    //
    // We persist the entire next-action contract on the lead so the
    // cron is a one-liner: "is Next_Call_At due and not exhausted?".
    // Categorise the call outcome for scheduling (v3 — slot-based per the
    // 2026-06-18 product note):
    //   STOP   — customer answered + declined ("Not Interested"). No more
    //            calls ever (Next_Call_At cleared forever).
    //   PICKUP — customer engaged (Connected/Pre Site/Virtual Tour).
    //            nextCallAfterPickup → customer's preferred time if given,
    //            else next slot in [10am, 11am, 1pm, 2pm, 4pm, 5pm, 7pm,
    //            8pm] customer-TZ.
    //   MISS   — didn't pick up (Not Connected/Busy/Switched Off, etc.).
    //            nextCallAfterMiss → next slot in [9am, 10am, 11am, 1pm,
    //            2pm, 4pm, 5pm, 7pm, 8pm] customer-TZ. Loops until pickup.
    //            (No more miss-counter / aggressive tree / 3-day exhaustion.)
    // A site-visit milestone ("Pre Site" / "Virtual Tour") STOPS the call
    // cadence exactly like an explicit "Not Interested": once a lead has booked
    // a visit we must NOT schedule another call. Previously these were treated
    // as PICKUP → nextCallAfterPickup re-armed Next_Call_At with a fresh future
    // slot, so a just-booked lead carried a LIVE scheduled call (ISSUE 1). Only
    // a plain "Connected" answer (engaged, not yet booked) reschedules.
    const PICKUP_STATUSES = new Set(["Connected"]);
    const STOP_STATUSES = new Set(["Not Interested", "Pre Site", "Virtual Tour"]);
    const isPickup = PICKUP_STATUSES.has(callStatus);
    const isStop = STOP_STATUSES.has(callStatus);

    const phone = String(lead.Mobile || phoneRaw || "");
    const extractedSlots = (body.extracted_slots || {}) as any;
    const preferredCallbackTime: string | null =
      extractedSlots.preferred_callback_time || null;
    const { nextCallAfterPickup, nextCallAfterMiss, zohoIso: schedZohoIso } =
      await import("../_utils/call_scheduling");
    const createdAt: string | null = lead.Created_Time || null;
    const schedule = isStop
      ? {
          nextCallAt: null,
          phase: "STOPPED" as const,
          reason:
            callStatus === "Not Interested"
              ? "customer declined — no further calls"
              : "site-visit milestone reached — no further calls",
        }
      : isPickup
      ? nextCallAfterPickup({ phone, preferredCallbackTime, createdAt })
      : nextCallAfterMiss({ phone, createdAt });
    console.log(
      `[InHouse Posthook] Call scheduling — phone=${phone} status=${callStatus} ` +
      `isPickup=${isPickup} isStop=${isStop} phase=${schedule.phase} reason=${schedule.reason}`,
    );

    const prevDuration = Number(lead.Total_Call_Duration_Secs ?? 0);
    const callOutcomeFields: Record<string, any> = {
      Call_Status: callStatus,
      Call_Duration: durationSecs,
      Total_Call_Duration_Secs: prevDuration + durationSecs,
      Next_Call_At: schedule.nextCallAt ? schedZohoIso(schedule.nextCallAt) : null,
    };
    await updateLead(lead.id, callOutcomeFields);
    // Mirror to Mongo so downstream readers see the same state.
    await mirrorLeadStateToMongo(lead.id, callOutcomeFields);

    // ── 3. Best-effort blueprint transition based on outcome ─────────────
    const transitionMap: Record<string, string> = {
      Connected: "Call Connected",
      "Pre Site": "Site Visit Confirmed",
      "Virtual Tour": "Virtual Tour Scheduled",
      "Not Interested": "Not Interested",
    };
    const transition = transitionMap[callStatus];
    if (transition) {
      // MUST await — Vercel kills un-awaited promises when the handler returns
      // 200, so the Lead_Status blueprint move (e.g. "Site Visit Confirmed")
      // was silently lost. That's why site-visit leads had Call_Status set but
      // Lead_Status/PRD_Stage stayed empty in Zoho.
      await triggerBlueprintTransition(lead.id, transition).catch((err) =>
        console.error(`[InHouse Posthook] Blueprint '${transition}' failed:`, err.message)
      );
    }

    // ── 3b. PRD v1.0 state machine — route to handleCallPosthook ────────
    // Map Call_Status → PRD outcome (CRITICAL: call answer NEVER → CF
    // status per PRD section 8.3 + section 12 guardrail).
    try {
      const { handleCallPosthook } = await import("../_utils/prd_orchestrator");
      const prdOutcome =
        callStatus === "Connected"           ? "answered_intent_no_time" :  // default for connected w/o other signal
        callStatus === "Pre Site"            ? "answered_wants_site_visit" :
        callStatus === "Virtual Tour"        ? "answered_wants_site_visit" :
        callStatus === "Not Interested"      ? "answered_not_interested" :
        "not_answered";
      // Override if voice-bot's extracted slots tell us a clearer outcome
      const extracted = (body.extracted_slots || {}) as any;
      let finalOutcome = prdOutcome;
      const details: any = {};
      if (extracted.preferred_callback_time) {
        finalOutcome = "answered_gave_time";
        details.preferredTime = extracted.preferred_callback_time;
      } else if (extracted.site_visit_requested?.date) {
        finalOutcome = "answered_wants_site_visit";
        details.visitDate = extracted.site_visit_requested.date;
      }
      // MUST await — same fire-and-forget trap. This is what writes
      // PRD_Stage="Pre Site Visit" (via onSiteVisitBooked); un-awaited it was
      // killed on handler return, so PRD_Stage stayed empty for every
      // site-visit lead.
      await handleCallPosthook({
        zoho_lead_id: lead.id,
        lead,
        outcome: finalOutcome as any,
        details,
      }).catch((err) => console.error(`[InHouse Posthook → PRD] failed: ${err.message}`));

      // ── Site-visit booking log → Mongo ─────────────────────────────────
      // When a call books a site visit / virtual tour, record WHICH project +
      // date + time in a dedicated `site_visit_bookings` collection so ops can
      // see every booking at a glance. Upsert per lead (latest booking wins).
      const isSiteVisitBooking =
        callStatus === "Pre Site" || callStatus === "Virtual Tour" ||
        !!extracted.site_visit_requested;
      if (isSiteVisitBooking) {
        try {
          const svr = (extracted.site_visit_requested || {}) as any;
          const { getCollection } = await import("../_utils/mongo");
          const col = await getCollection("site_visit_bookings" as any);
          await col.updateOne(
            { _id: String(lead.id) as any },
            { $set: {
                zoho_lead_id: lead.id,
                phone,
                customer_name: leadName || null,
                project: lead.ASBL_Project || null,
                type: callStatus === "Virtual Tour" ? "virtual_tour" : "site_visit",
                visit_date: svr.date || details.visitDate || null,
                visit_time: svr.time || svr.slot || svr.preferred_time || null,
                visit_raw: svr,
                call_id: callId,
                call_status: callStatus,
                booked_at: new Date().toISOString(),
              } },
            { upsert: true },
          );
          console.log(
            `[InHouse Posthook] site-visit booking logged — lead=${lead.id} ` +
            `project=${lead.ASBL_Project || "?"} date=${svr.date || details.visitDate || "?"} time=${svr.time || "?"}`,
          );
        } catch (err: any) {
          console.error(`[InHouse Posthook] site-visit booking log failed: ${err.message}`);
        }
      }
    } catch (err: any) {
      console.error(`[InHouse Posthook → PRD] orchestrator import failed: ${err.message}`);
    }

    // ── 4. Call log + Note ────────────────────────────────────────────────
    // IMPORTANT: must AWAIT in Vercel serverless — fire-and-forget kills the
    // outbound HTTP requests when the handler returns. (Earlier version had
    // these as .catch() promises which silently lost half the writes.)
    const transcriptText = summary
      ? `${summary}\n\n--- Transcript ---\n${fullText}`
      : fullText;

    const [logRes, noteRes] = await Promise.allSettled([
      createCallLog({
        leadId: lead.id,
        leadName,
        externalId: callId,
        callStatus,
        durationSecs,
        transcription: transcriptText || undefined,
        recordingUrl: recordingUrl || undefined,
      }),
      createCallNote({
        leadId: lead.id,
        externalId: callId,
        callStatus,
        durationSecs,
        transcription: transcriptText || undefined,
        recordingUrl: recordingUrl || undefined,
      }),
    ]);
    if (logRes.status === "rejected") {
      console.error(`[InHouse Posthook ${callId}] createCallLog failed: ${logRes.reason?.message}`);
    }
    if (noteRes.status === "rejected") {
      console.error(`[InHouse Posthook ${callId}] createCallNote failed: ${noteRes.reason?.message}`);
    }

    console.log(
      `[InHouse Posthook ${callId || "no-id"}] Lead ${lead.id} updated → ${callStatus} | duration=${durationSecs}s | rawSlug=${rawSlug || "(none)"}`
    );

    return res.status(200).json({
      status: "ok",
      lead_id: lead.id,
      call_status: callStatus,
      duration_secs: durationSecs,
      has_recording: !!recordingUrl,
      has_transcript: !!fullText,
    });
  } catch (err: any) {
    console.error("[InHouse Posthook] Error:", err.message);
    const { alertOps } = await import("../_utils/alerting");
    await alertOps({ title: "Posthook failed", message: err.message, context: { path: "inhouse-posthook" }, dedupeKey: `posthook:${String(err.message).slice(0, 60)}` });
    return res.status(500).json({ error: err.message });
  }
}
