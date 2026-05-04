/**
 * Triggers an outbound call via the in-house ASBL Voice Bot (Anandita).
 * Replaces the prior Arrowhead relay.
 *
 * Contract (kept compatible with existing Zoho Deluge):
 *   POST /api/relay/inhouse-call
 *   Body: { _zoho_lead_id, phone_number | mobile_number, ...extras }
 *
 * Internally posts to https://asbl-voice-bot.onrender.com/api/trigger-call
 * with { to: "+91…" }, then writes the returned call_id back to Zoho as
 * Last_Inhouse_Call_ID so the posthook can correlate later.
 */
import { VercelRequest, VercelResponse } from "@vercel/node";
import { triggerBlueprintTransition, updateLead } from "../_utils/zoho";

const VOICEBOT_URL =
  process.env.ASBL_VOICEBOT_URL || "https://asbl-voice-bot.onrender.com";
const VOICEBOT_API_KEY = process.env.ASBL_VOICEBOT_API_KEY || "";

/** Normalise phone input → E.164 with leading "+". */
function toE164(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  // Heuristic: if 10 digits and looks Indian, prepend 91
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!VOICEBOT_API_KEY) {
    return res
      .status(500)
      .json({ error: "ASBL_VOICEBOT_API_KEY env var not configured" });
  }

  try {
    const body = (req.body || {}) as any;
    const zohoLeadId: string = body._zoho_lead_id || "";
    const phone = toE164(body.phone_number || body.mobile_number || body.to || "");

    if (!phone || phone.length < 11) {
      return res.status(400).json({
        error: "phone_number required (E.164 format, e.g. +919876543210)",
      });
    }

    console.log(`[InHouse Call] Trigger request: lead=${zohoLeadId || "(none)"} phone=${phone}`);

    // ── 1. Hit voice-bot trigger-call ────────────────────────────────────
    const r = await fetch(`${VOICEBOT_URL}/api/trigger-call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VOICEBOT_API_KEY}`,
      },
      body: JSON.stringify({ to: phone }),
    });
    const data = (await r.json().catch(() => ({}))) as any;

    if (!r.ok || !data?.success) {
      console.error(`[InHouse Call] Voice-bot trigger failed (${r.status}):`, data);
      return res
        .status(r.status || 500)
        .json({ error: data?.error || `voice-bot ${r.status}`, voicebot_response: data });
    }

    const callId: string = data.call_id;
    const provider: string = data.provider || "unknown";
    console.log(`[InHouse Call] Triggered → call_id=${callId} provider=${provider}`);

    // ── 2. Update Zoho lead in parallel (best-effort, non-blocking) ──────
    if (zohoLeadId) {
      // a) Stamp Last_Inhouse_Call_ID for posthook correlation + flip Lead_Status
      updateLead(zohoLeadId, {
        Lead_Status: "Lead Initiated",
        Last_Inhouse_Call_ID: callId,
      }).catch((err) =>
        console.error(`[InHouse Call] updateLead failed: ${err.message}`)
      );

      // b) Best-effort blueprint transition (silently no-op if not configured)
      triggerBlueprintTransition(zohoLeadId, "Lead Initiated").catch(() => {
        /* ignore — transition may not exist */
      });
    } else {
      console.warn("[InHouse Call] _zoho_lead_id missing — skipping Zoho update");
    }

    return res.status(200).json({
      success: true,
      call_id: callId,
      provider,
      to: phone,
    });
  } catch (err: any) {
    console.error("[InHouse Call] Unexpected error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
