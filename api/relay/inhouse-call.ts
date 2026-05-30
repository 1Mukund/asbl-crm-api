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

// Voice-bot base URL. If the env var still points at the suspended Render
// host we override it to the new self-hosted voice.asbl.in domain — saves
// a round-trip through the user updating Vercel env vars.
const RAW_VOICEBOT_URL = process.env.ASBL_VOICEBOT_URL || "";
const VOICEBOT_URL =
  RAW_VOICEBOT_URL && !RAW_VOICEBOT_URL.includes("onrender.com")
    ? RAW_VOICEBOT_URL
    : "https://voice.asbl.in";
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

/** Trigger the in-house ASBL voice bot for ANY country.
 *
 *  Per 2026-05-30 voice-bot change: the bot itself routes Plivo (+91) vs
 *  Telnyx (all other country codes). We just pass the E.164 phone number
 *  and the bot picks the right provider. No region-detection logic on our
 *  side anymore — keeping it here would just risk drift if the voice-bot
 *  team adds new providers later.
 *
 *  The rich payload (customer_name, external_schedule_id, external_customer_id,
 *  metadata) is sent — the bot ignores fields it doesn't understand. Returns
 *  ok=true only when the bot replies with success:true.
 */
async function triggerInHouseBot(
  phone: string,
  ctx: {
    customer_name?: string;
    external_schedule_id?: string;
    external_customer_id?: string;
    metadata?: Record<string, any>;
  },
): Promise<{ ok: boolean; status: number; data: any }> {
  const payload: any = { to: phone };
  if (ctx.customer_name)        payload.customer_name = ctx.customer_name;
  if (ctx.external_schedule_id) payload.external_schedule_id = ctx.external_schedule_id;
  if (ctx.external_customer_id) payload.external_customer_id = ctx.external_customer_id;
  if (ctx.metadata && Object.keys(ctx.metadata).length) {
    payload.metadata = ctx.metadata;
  }

  const r = await fetch(`${VOICEBOT_URL}/api/trigger-call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOICEBOT_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok && (data as any)?.success === true, status: r.status, data };
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

    const callId: string = result.data.call_id || result.data.external_schedule_id || "";
    const provider: string = result.data.provider || (isIndia ? "plivo" : "telnyx");
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
    // Promise.allSettled lets both writes proceed in parallel and we
    // still log either failure individually.
    if (zohoLeadId) {
      const [updateRes, transRes] = await Promise.allSettled([
        updateLead(zohoLeadId, {
          Lead_Status: "Lead Initiated",
          Last_Inhouse_Call_ID: callId,
        }),
        triggerBlueprintTransition(zohoLeadId, "Lead Initiated"),
      ]);
      if (updateRes.status === "rejected") {
        console.error(`[InHouse Call] updateLead failed: ${updateRes.reason?.message || updateRes.reason}`);
      } else {
        console.log(`[InHouse Call] Zoho stamped Lead_Status + Last_Inhouse_Call_ID=${callId} on lead ${zohoLeadId}`);
      }
      if (transRes.status === "rejected") {
        console.error(`[InHouse Call] blueprint transition failed: ${transRes.reason?.message || transRes.reason}`);
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
