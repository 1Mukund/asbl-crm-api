import { VercelRequest, VercelResponse } from "@vercel/node";
import { findLeadByArrowheadCallId, updateLead } from "../_utils/zoho";

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

    // Recording & transcription — confirmed field names from Arrowhead
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

    // Build Zoho update payload
    const updatePayload: Record<string, any> = {
      Call_Status:   zohoStatus,
      Call_Duration: callDuration,
    };

    // Call_Summary = existing Zoho field
    // Combine transcription + recording URL into Call_Summary
    if (transcription || recordingUrl) {
      const summaryParts: string[] = [];
      if (transcription) summaryParts.push(transcription);
      if (recordingUrl)  summaryParts.push(`Recording: ${recordingUrl}`);
      updatePayload.Call_Summary = summaryParts.join("\n\n");
    }

    await updateLead(lead.id, updatePayload);

    console.log(`Updated lead ${lead.id} → ${zohoStatus}${transcription ? " + transcription" : ""}${recordingUrl ? " + recording" : ""}`);
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
