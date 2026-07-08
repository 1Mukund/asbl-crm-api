/**
 * Outbound call trigger — ALL countries now route through the in-house
 * ASBL Voice Bot (Anandita) at https://voice.asbl.in/api/trigger-call.
 *
 * History:
 *   - Pre-2026-05-21: Render-hosted voice-bot (asbl-voice-bot.onrender.com),
 *     India calls only. International calls → Arrowhead (US-only originally,
 *     then expanded to all non-India).
 *   - 2026-05-21: Voice-bot moved to self-hosted nginx behind voice.asbl.in.
 *   - 2026-05-30 (this change): Voice-bot team added Telnyx for international
 *     routing in addition to Plivo for India. Arrowhead is no longer used —
 *     every call (any country code) is dispatched through the same in-house
 *     endpoint with the same payload shape; the voice-bot itself selects the
 *     telephony provider (Plivo for +91, Telnyx for everything else).
 *
 * Contract (kept compatible with existing Zoho Deluge):
 *   POST /api/relay/inhouse-call
 *   Body: { _zoho_lead_id, phone_number | mobile_number, ...extras }
 *
 * Posthook for ALL calls now lands on /api/relay/inhouse-posthook (the
 * voice-bot fires call_completed there for both Plivo and Telnyx calls).
 * Zoho field Last_Inhouse_Call_ID is the single correlation key.
 */
import { VercelRequest, VercelResponse } from "@vercel/node";
import { triggerBlueprintTransition, updateLead } from "../_utils/zoho";
import { mirrorLeadStateToMongo } from "../_utils/supabase";

// Voice-bot base URL. Default to angad-bot.onrender.com (current production
// bot as of 2026-06-03). The earlier voice.asbl.in self-hosted instance
// had issues so we moved back to a fresh Render-hosted deployment.
// History:
//   2026-05-21: voice.asbl.in (self-hosted, replaced suspended Render)
//   2026-06-03: angad-bot.onrender.com (new bot, current)
// Env override (ASBL_VOICEBOT_URL) wins if explicitly set — no string-
// matching guards anymore so any future re-host works without code edit.
const VOICEBOT_URL = (process.env.ASBL_VOICEBOT_URL || "https://angad-bot.onrender.com").replace(/\/+$/, "");
const VOICEBOT_API_KEY = process.env.ASBL_VOICEBOT_API_KEY || "";

/** Normalise phone input → E.164 with leading "+". */
function toE164(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  // Strip everything that isn't a digit (drops +, spaces, dashes, parens).
  let digits = trimmed.replace(/\D/g, "");
  // Drop leading zeros — STD / international trunk prefixes (e.g. "0 98765…",
  // "00 91 98765…"). Voice-bot dev requires E.164 with NO leading 0, and the
  // old code passed "09876543210" straight through as "+09876543210" (invalid).
  digits = digits.replace(/^0+/, "");
  if (!digits) return "";
  // Bare 10-digit → Indian mobile → prepend 91.
  if (digits.length === 10) return `+91${digits}`;
  // Otherwise it already carries a country code (91XXXXXXXXXX, 1XXXXXXXXXX, …).
  return `+${digits}`;
}

/** Trigger the in-house ASBL voice bot for ANY country.
 *
 *  Bot routes Plivo (+91) vs Telnyx (everything else) internally — we
 *  just pass the E.164 phone number and the bot picks the right provider.
 *
 *  Endpoint: POST /api/schedule-call (auth-protected)
 *  ---------
 *  History:
 *    Pre-2026-06-08: We were on the legacy /api/calls/initiate (no auth)
 *      because bot's env had a stale ASBL_VOICEBOT_API_KEY that didn't
 *      match our Bearer header → 401 on /api/schedule-call.
 *    2026-06-09: Confirmed via dev's curl test that /api/calls/initiate
 *      uses a DIFFERENT (and broken) Telnyx outbound voice profile that
 *      bars most international destinations with
 *      "Calls to this destination region are barred." 500. NRI calls
 *      (e.g. +14084619317) work cleanly on /api/schedule-call. Switched
 *      back to the auth-protected path now that the API key has landed.
 *
 *  Response shape normalisation:
 *    /api/schedule-call  → { success, call_id, status, provider }
 *    /api/calls/initiate → { ok, requestUuid, engine }    (legacy fallback)
 *  Both shapes are handled by triggerInHouseBot — success / call_id are
 *  derived from whichever fields are present.
 */
async function triggerInHouseBot(
  phone: string,
  ctx: {
    customer_name?: string;
    external_schedule_id?: string;
    external_customer_id?: string;
    metadata?: Record<string, any>;
  },
): Promise<{ ok: boolean; status: number; data: any; call_id: string }> {
  const payload: any = { to: phone };
  if (ctx.customer_name)        payload.customer_name = ctx.customer_name;
  if (ctx.external_schedule_id) payload.external_schedule_id = ctx.external_schedule_id;
  if (ctx.external_customer_id) payload.external_customer_id = ctx.external_customer_id;
  if (ctx.metadata && Object.keys(ctx.metadata).length) {
    payload.metadata = ctx.metadata;
  }

  const r = await fetch(`${VOICEBOT_URL}/api/schedule-call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOICEBOT_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  const d = (data as any) || {};
  // Normalise: success flag from either shape; call_id from either field.
  const okFlag = r.ok && (d.success === true || d.ok === true);
  const callId = String(d.call_id || d.requestUuid || d.external_schedule_id || "");
  return { ok: okFlag, status: r.status, data, call_id: callId };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = (req.body || {}) as any;
    const zohoLeadId: string = body._zoho_lead_id || "";
    const phone = toE164(body.phone_number || body.mobile_number || body.to || "");

    if (!phone || phone.length < 11) {
      return res.status(400).json({
        error: "phone_number required (E.164 format, e.g. +919876543210 or +14155551234)",
      });
    }

    if (!VOICEBOT_API_KEY) {
      return res.status(500).json({ error: "ASBL_VOICEBOT_API_KEY env var not configured" });
    }

    // Single path — voice-bot picks Plivo (+91) vs Telnyx (rest) on its end.
    const isIndia = phone.replace(/^\+/, "").startsWith("91");
    console.log(`[InHouse Call] phone=${phone} (${isIndia ? "IN/Plivo" : "INTL/Telnyx"}) lead=${zohoLeadId || "(none)"}`);

    // Extract context that Zoho Deluge already supplies on every trigger.
    // This is what enables Anandita to greet by name + speak about the
    // right project (was missing earlier — bot knew nothing about the lead).
    const customerName: string =
      body.customer_full_name ||
      body.customer_name ||
      (body.retell_llm_dynamic_variables?.customer_name) ||
      "";
    const externalScheduleId: string = body.external_schedule_id || "";
    const externalCustomerId: string =
      body.external_customer_id ||
      body.retell_llm_dynamic_variables?.mlid ||
      "";

    // Pass everything Deluge gave us (project, mlid, plid, etc.) as
    // metadata so the voice-bot's LLM session has full context.
    const dynVars = body.retell_llm_dynamic_variables || {};
    const metadata: Record<string, any> = {
      project: dynVars.project_name || body.project || "",
      plid: dynVars.plid || "",
      mlid: dynVars.mlid || "",
      customer_phone: dynVars.customer_phone || phone,
      customer_name: customerName,
    };
    // Strip empty values so we don't ship noise
    for (const k of Object.keys(metadata)) {
      if (!metadata[k]) delete metadata[k];
    }

    const result = await triggerInHouseBot(phone, {
      customer_name: customerName || undefined,
      external_schedule_id: externalScheduleId || undefined,
      external_customer_id: externalCustomerId || undefined,
      metadata: Object.keys(metadata).length ? metadata : undefined,
    });
    if (!result.ok) {
      console.error(`[InHouse Call] Voice-bot trigger failed (${result.status}):`, result.data);
      return res.status(result.status || 500).json({
        error: result.data?.error || `voice-bot ${result.status}`,
        voicebot_response: result.data,
      });
    }

    // Normalised in triggerInHouseBot — works for both /api/schedule-call
    // (call_id field) and /api/calls/initiate (requestUuid field).
    const callId: string = result.call_id;
    const provider: string = result.data.provider || result.data.engine || (isIndia ? "plivo" : "telnyx");
    console.log(
      `[InHouse Call] Triggered → call_id=${callId} provider=${provider} ` +
      `customer=${customerName || "(unknown)"} project=${metadata.project || "(none)"} ` +
      `external_schedule_id=${externalScheduleId || "(none)"}`,
    );

    // Zoho stamping — MUST await in Vercel serverless. Earlier version
    // used .catch() fire-and-forget which gets killed when the handler
    // returns 200, so Last_Inhouse_Call_ID never persisted → posthook
    // could not correlate the completion back to the lead → Call_Status
    // never set, blueprint never transitioned, sales saw the lead stuck.
    //
    // CRITICAL — Lead_Status MUST NOT be in the direct-field PATCH.
    // Zoho's blueprint enforces transitions on Lead_Status: a direct
    // PATCH from a non-allowed state ("Virtual Tour", "Contacted", etc.)
    // is rejected by Zoho's validation AND drops every OTHER field in the
    // same PATCH with it — so Last_Inhouse_Call_ID disappears silently.
    // Confirmed by live test on 2026-06-03 (lead 1288576000000693005,
    // call 1ab17a11-...) — PATCH with {Lead_Status, Last_Inhouse_Call_ID}
    // returned 200 but neither field changed in Zoho. Same bug we hit on
    // mark-spam (commit c072d8c) — now fixed here too. Lead_Status flips
    // only via triggerBlueprintTransition; the field stamp is its own
    // standalone PATCH.
    if (zohoLeadId) {
      // Stamp BOTH fields:
      //   Last_Inhouse_Call_ID = bot's call_id (Plivo requestUuid / Telnyx call_control_id)
      //   Last_Arrowhead_Call_ID = external_schedule_id we sent (stable lookup key)
      //
      // Why both? On Plivo connected calls, the bot promotes requestUuid →
      // CallUUID once the WebSocket starts, and the originally-returned
      // requestUuid stops being a valid lookup key on the bot side. The
      // external_schedule_id we passed in (e.g. "1714-BROADWAY-call-5"
      // from Deluge, or "prd-<lead_id>-<ts>" from PRD orchestrator) is
      // always stable on the bot — so it's the more reliable backfill
      // key. Deluge already stamps Last_Arrowhead_Call_ID for its own
      // path; this ensures PRD T=0 / WhatsApp callback paths also stamp it.
      const stampFields: Record<string, any> = { Last_Inhouse_Call_ID: callId };
      if (externalScheduleId) {
        stampFields.Last_Arrowhead_Call_ID = externalScheduleId;
      }
      const [updateRes, transRes] = await Promise.allSettled([
        updateLead(zohoLeadId, stampFields),
        triggerBlueprintTransition(zohoLeadId, "Lead Initiated"),
      ]);
      if (updateRes.status === "rejected") {
        console.error(`[InHouse Call] updateLead(call-id fields) failed: ${updateRes.reason?.message || updateRes.reason}`);
      } else {
        console.log(
          `[InHouse Call] Zoho stamped Last_Inhouse_Call_ID=${callId}` +
          (externalScheduleId ? ` + Last_Arrowhead_Call_ID=${externalScheduleId}` : "") +
          ` on lead ${zohoLeadId}`,
        );
        // Mirror to Mongo so downstream readers (cron, dashboards) see
        // the same call_id without an extra Zoho roundtrip.
        await mirrorLeadStateToMongo(zohoLeadId, stampFields);
      }
      if (transRes.status === "rejected") {
        console.error(`[InHouse Call] blueprint transition 'Lead Initiated' failed: ${transRes.reason?.message || transRes.reason}`);
      }
    }

    return res.status(200).json({
      success: true,
      region: isIndia ? "IN" : "INTL",
      provider,
      call_id: callId,
      external_schedule_id: externalScheduleId,
      customer_name: customerName,
      to: phone,
    });
  } catch (err: any) {
    console.error("[InHouse Call] Unexpected error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
