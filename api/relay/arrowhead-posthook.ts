import { VercelRequest, VercelResponse } from "@vercel/node";
import { findLeadByArrowheadCallId, updateLead, createCallLog, createCallNote, triggerBlueprintTransition } from "../_utils/zoho";

// Map Arrowhead call_result_slug → Zoho Call_Status picklist value
function mapStatus(raw: string): string {
  const s = (raw || "").toUpperCase();
  if (s === "CONNECTED")      return "Connected";
  if (s === "AUTO_CALLBACK")  return "Connected";
  if (s === "NOT_CONNECTED")  return "Not Connected";
  if (s === "NO_ANSWER")      return "Not Connected";
  if (s === "BUSY")           return "Busy";
  if (s === "SWITCHED_OFF")   return "Switched Off";
  if (s === "PRE_SITE")       return "Pre Site";
  if (s === "VIRTUAL_TOUR")   return "Virtual Tour";
  if (s === "NOT_INTERESTED") return "Not Interested";
  return "Not Connected";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body;
    console.log("Arrowhead posthook payload:", JSON.stringify(body));

    // Extract external_schedule_id — Arrowhead may send it at different paths
    const externalScheduleId: string =
      body.external_schedule_id ||
      body.external_journey_id ||
      body.schedule?.external_schedule_id ||
      body.journey?.external_journey_id ||
      "";

    const rawStatus: string =
      body.call_result_slug ||
      body.status ||
      body.call_status ||
      "";

    const callDuration: number = Number(
      body.call_duration_in_secs || body.call_duration || body.duration || 0
    );

    const callId: string = body.call_id || body.call?.id || "";

    // Recording & transcription — field names confirmed by Arrowhead team
    const recordingUrl: string  = body.recording_url  || body.recording_link || "";
    const transcription: string = body.transcription   || body.transcript     || "";

    if (!externalScheduleId) {
      return res.status(400).json({ error: "Missing external_schedule_id" });
    }

    // Find the lead in Zoho by Last_Arrowhead_Call_ID
    const lead = await findLeadByArrowheadCallId(externalScheduleId);

    if (!lead) {
      console.log("No lead found for:", externalScheduleId);
      return res.status(200).json({ status: "ok", message: "Lead not found — ignored" });
    }

    const zohoStatus = mapStatus(rawStatus);
    const leadName = [lead.First_Name, lead.Last_Name].filter(Boolean).join(" ") || "Unknown";

    // ── Step 1: Update lead-level fields (latest call status + accumulate duration) ──
    const prevDuration = Number(lead.Total_Call_Duration_Secs ?? 0);
    await updateLead(lead.id, {
      Call_Status:              zohoStatus,
      Call_Duration:            callDuration,
      Total_Call_Duration_Secs: prevDuration + callDuration,
    });

    // ── Step 1b: Blueprint transition based on call outcome ──────────────────
    // Map every meaningful Arrowhead outcome to its blueprint stage transition
    const blueprintTransition: Record<string, string> = {
      "Connected":      "Call Connected",
      "Pre Site":       "Pre Site",
      "Virtual Tour":   "Virtual Tour",
      "Not Interested": "Not Interested",
      "Not Connected":  "Call Not Connected",
      "Busy":           "Call Not Connected",
      "Switched Off":   "Call Not Connected",
    };
    const transition = blueprintTransition[zohoStatus];
    if (transition) {
      triggerBlueprintTransition(lead.id, transition).catch((err) =>
        console.error(`Blueprint '${transition}' failed:`, err.message)
      );
    }

    // ── Step 2: Create Call log (global Calls module) ─────────────────────────
    await createCallLog({
      leadId:        lead.id,
      leadName,
      externalId:    externalScheduleId,
      callStatus:    zohoStatus,
      durationSecs:  callDuration,
      transcription: transcription || undefined,
      recordingUrl:  recordingUrl  || undefined,
    });

    // ── Step 3: Create Note on lead (shows in lead detail Notes section) ─────
    // Notes API reliably links to leads — appears in Notes + Timeline
    await createCallNote({
      leadId:        lead.id,
      externalId:    externalScheduleId,
      callStatus:    zohoStatus,
      durationSecs:  callDuration,
      transcription: transcription || undefined,
      recordingUrl:  recordingUrl  || undefined,
    });

    console.log(`Lead ${lead.id} updated → ${zohoStatus} | Call log created for ${externalScheduleId}`);

    return res.status(200).json({
      status:            "ok",
      lead_id:           lead.id,
      call_status:       zohoStatus,
      has_recording:     !!recordingUrl,
      has_transcription: !!transcription,
    });

  } catch (err: any) {
    console.error("Arrowhead posthook error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
