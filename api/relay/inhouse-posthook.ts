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
  findLeadByPhone,
  updateLead,
  createCallLog,
  createCallNote,
  triggerBlueprintTransition,
} from "../_utils/zoho";

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
    console.log(`[InHouse Posthook] Event=${event} payload-keys=${Object.keys(body).join(",")}`);

    // ── Lenient field extraction (covers both call_completed and posthook_received) ──
    const callId: string =
      body.call_sid || body.call_id || body.external_schedule_id || "";
    const phoneRaw: string =
      body.phone_number || body.phone || body.to || "";
    const durationSecs: number = Number(
      body.duration_seconds ?? body.call_duration_secs ?? body.duration ?? 0
    );
    const summary: string = body.summary || "";
    const fullText: string = body.full_text || formatTranscript(body.transcript || body.transcription);
    const recordingUrl: string =
      body.recording_url || body.recording_link || "";
    const rawSlug: string = body.zoho_status || body.call_result_slug || body.status || "";

    if (!callId && !phoneRaw) {
      return res.status(400).json({ error: "Missing call_sid / phone_number" });
    }

    // ── 1. Find the Zoho lead — call_id first (precise), phone fallback ──
    let lead: any = null;
    if (callId) {
      lead = await findLeadByInhouseCallId(callId);
    }
    if (!lead && phoneRaw) {
      const phone = String(phoneRaw).replace(/^\+/, "");
      lead = await findLeadByPhone(phone);
    }

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

    // ── 4. Call log + Note (fire-and-forget so webhook returns fast) ─────
    const transcriptText = summary
      ? `${summary}\n\n--- Transcript ---\n${fullText}`
      : fullText;

    createCallLog({
      leadId: lead.id,
      leadName,
      externalId: callId,
      callStatus,
      durationSecs,
      transcription: transcriptText || undefined,
      recordingUrl: recordingUrl || undefined,
    }).catch((err) =>
      console.error(`[InHouse Posthook] createCallLog failed: ${err.message}`)
    );

    createCallNote({
      leadId: lead.id,
      externalId: callId,
      callStatus,
      durationSecs,
      transcription: transcriptText || undefined,
      recordingUrl: recordingUrl || undefined,
    }).catch((err) =>
      console.error(`[InHouse Posthook] createCallNote failed: ${err.message}`)
    );

    console.log(
      `[InHouse Posthook] Lead ${lead.id} updated → ${callStatus} | duration=${durationSecs}s | call_id=${callId}`
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
