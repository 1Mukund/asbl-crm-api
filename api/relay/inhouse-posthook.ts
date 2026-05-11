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

  // ── Auth: shared-secret header check (skipped if no secret configured) ──
  if (POSTHOOK_SECRET) {
    const incoming =
      (req.headers["x-webhook-secret"] as string) ||
      (req.headers["x-posthook-secret"] as string) ||
      "";
    if (incoming !== POSTHOOK_SECRET) {
      console.warn("[InHouse Posthook] Rejected — bad/missing X-Webhook-Secret");
      return res.status(401).json({ error: "Unauthorized" });
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

    // ── 2. Update lead-level fields (latest call status + accumulate duration) ──
    const prevDuration = Number(lead.Total_Call_Duration_Secs ?? 0);
    await updateLead(lead.id, {
      Call_Status: callStatus,
      Call_Duration: durationSecs,
      Total_Call_Duration_Secs: prevDuration + durationSecs,
    });

    // ── 3. Best-effort blueprint transition based on outcome ─────────────
    const transitionMap: Record<string, string> = {
      Connected: "Call Connected",
      "Pre Site": "Site Visit Confirmed",
      "Virtual Tour": "Virtual Tour Scheduled",
      "Not Interested": "Not Interested",
    };
    const transition = transitionMap[callStatus];
    if (transition) {
      triggerBlueprintTransition(lead.id, transition).catch((err) =>
        console.error(`[InHouse Posthook] Blueprint '${transition}' failed:`, err.message)
      );
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
    return res.status(500).json({ error: err.message });
  }
}
