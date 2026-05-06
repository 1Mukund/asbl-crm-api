/**
 * Outbound call trigger — country-routes the lead:
 *
 *   +91 (India) → in-house ASBL Voice Bot (Anandita) at
 *                 https://asbl-voice-bot.onrender.com/api/trigger-call
 *   +1  (US)    → Arrowhead campaign (legacy, still in use for US leads)
 *
 * Contract (kept compatible with existing Zoho Deluge):
 *   POST /api/relay/inhouse-call
 *   Body: { _zoho_lead_id, phone_number | mobile_number, ...extras }
 *
 * For the in-house path we stamp the returned call_id onto Zoho as
 * Last_Inhouse_Call_ID so /api/relay/inhouse-posthook can correlate.
 * For the Arrowhead path we keep the original Last_Arrowhead_Call_ID
 * scheme via the Deluge-side payload + /api/relay/arrowhead-posthook.
 */
import { VercelRequest, VercelResponse } from "@vercel/node";
import { triggerBlueprintTransition, updateLead } from "../_utils/zoho";

const VOICEBOT_URL =
  process.env.ASBL_VOICEBOT_URL || "https://asbl-voice-bot.onrender.com";
const VOICEBOT_API_KEY = process.env.ASBL_VOICEBOT_API_KEY || "";

const ARROWHEAD_BEARER_TOKEN = process.env.ARROWHEAD_BEARER_TOKEN || "";
const ARROWHEAD_CAMPAIGN_URL_US =
  process.env.ARROWHEAD_CAMPAIGN_URL_US ||
  "https://api.agent.arrowhead.team/api/v2/public/domain/932f86fc-ed03-42d5-a127-7dfc63216a8a/campaign/adcc6884-03d1-4bfa-8b2f-ce4da5ddc527/schedule";

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

/** Detect country region from E.164 number. India = "IN", US = "US". */
function detectRegion(e164: string): "IN" | "US" | "OTHER" {
  const digits = e164.replace(/^\+/, "");
  if (digits.startsWith("91")) return "IN";
  if (digits.startsWith("1")) return "US";
  return "OTHER";
}

/** Trigger the in-house ASBL voice bot (India calls).
 *
 *  Uses /api/schedule-call (richer than /api/trigger-call) so we can pass:
 *    - customer_name → bot greets by name instead of "Hello sir"
 *    - external_schedule_id → posthook correlates without our extra field
 *    - external_customer_id → MLID for cross-call identity
 *    - metadata → project / plid / mlid / size_pref / budget that the bot's
 *      LLM session can use as conversation context
 *
 *  Falls back to /api/trigger-call automatically on 404 (in case schedule-call
 *  was unavailable on the bot's deployment).
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
  const schedulePayload: any = { to: phone };
  if (ctx.customer_name)        schedulePayload.customer_name = ctx.customer_name;
  if (ctx.external_schedule_id) schedulePayload.external_schedule_id = ctx.external_schedule_id;
  if (ctx.external_customer_id) schedulePayload.external_customer_id = ctx.external_customer_id;
  if (ctx.metadata && Object.keys(ctx.metadata).length) {
    schedulePayload.metadata = ctx.metadata;
  }

  // Try /api/schedule-call first (richer)
  let r = await fetch(`${VOICEBOT_URL}/api/schedule-call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOICEBOT_API_KEY}`,
    },
    body: JSON.stringify(schedulePayload),
  });

  // Fallback to /api/trigger-call if schedule-call isn't deployed
  if (r.status === 404) {
    console.warn("[InHouse Call IN] /api/schedule-call returned 404 — falling back to /api/trigger-call");
    r = await fetch(`${VOICEBOT_URL}/api/trigger-call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VOICEBOT_API_KEY}`,
      },
      body: JSON.stringify({ to: phone }),
    });
  }

  const data = await r.json().catch(() => ({}));
  return { ok: r.ok && (data as any)?.success === true, status: r.status, data };
}

/** Trigger Arrowhead campaign (US calls — legacy, still active). */
async function triggerArrowheadUs(
  phone: string,
  rawBody: any,
): Promise<{ ok: boolean; status: number; data: any }> {
  // Strip our internal _zoho_lead_id before forwarding — Arrowhead doesn't need it
  const { _zoho_lead_id, ...arrowheadPayload } = rawBody;
  // Make sure Arrowhead sees the phone in its expected field
  if (!arrowheadPayload.phone_number && !arrowheadPayload.mobile_number) {
    arrowheadPayload.phone_number = phone;
  }
  const r = await fetch(ARROWHEAD_CAMPAIGN_URL_US, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ARROWHEAD_BEARER_TOKEN}`,
    },
    body: JSON.stringify(arrowheadPayload),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
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

    const region = detectRegion(phone);
    console.log(`[InHouse Call] Region=${region} phone=${phone} lead=${zohoLeadId || "(none)"}`);

    // ── A. India (+91) → in-house ASBL Voice Bot (Anandita) ────────────
    if (region === "IN") {
      if (!VOICEBOT_API_KEY) {
        return res.status(500).json({ error: "ASBL_VOICEBOT_API_KEY env var not configured" });
      }

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
        console.error(`[InHouse Call IN] Voice-bot trigger failed (${result.status}):`, result.data);
        return res.status(result.status || 500).json({
          error: result.data?.error || `voice-bot ${result.status}`,
          voicebot_response: result.data,
        });
      }

      const callId: string = result.data.call_id || result.data.external_schedule_id || "";
      const provider: string = result.data.provider || "voice-bot";
      console.log(
        `[InHouse Call IN] Triggered → call_id=${callId} provider=${provider} ` +
        `customer=${customerName || "(unknown)"} project=${metadata.project || "(none)"} ` +
        `external_schedule_id=${externalScheduleId || "(none)"}`,
      );

      // Best-effort Zoho stamping (won't block the response)
      if (zohoLeadId) {
        updateLead(zohoLeadId, {
          Lead_Status: "Lead Initiated",
          Last_Inhouse_Call_ID: callId,
        }).catch((err) =>
          console.error(`[InHouse Call IN] updateLead failed: ${err.message}`)
        );
        triggerBlueprintTransition(zohoLeadId, "Lead Initiated").catch(() => {});
      }

      return res.status(200).json({
        success: true,
        region: "IN",
        provider,
        call_id: callId,
        external_schedule_id: externalScheduleId,
        customer_name: customerName,
        to: phone,
      });
    }

    // ── B. US (+1) → Arrowhead campaign ────────────────────────────────
    if (region === "US") {
      if (!ARROWHEAD_BEARER_TOKEN) {
        return res.status(500).json({ error: "ARROWHEAD_BEARER_TOKEN env var not configured" });
      }

      const result = await triggerArrowheadUs(phone, body);
      if (!result.ok) {
        console.error(`[InHouse Call US] Arrowhead trigger failed (${result.status}):`, result.data);
        return res.status(result.status || 500).json({
          error: result.data?.error || result.data || `arrowhead ${result.status}`,
        });
      }

      console.log(`[InHouse Call US] Arrowhead campaign triggered for ${phone}`);

      // Move Zoho lead to "Lead Initiated" — same pattern as the legacy relay
      if (zohoLeadId) {
        updateLead(zohoLeadId, { Lead_Status: "Lead Initiated" }).catch((err) =>
          console.error(`[InHouse Call US] updateLead failed: ${err.message}`)
        );
        triggerBlueprintTransition(zohoLeadId, "Lead Initiated").catch(() => {});
      }

      return res.status(200).json({
        success: true,
        region: "US",
        provider: "arrowhead",
        to: phone,
        arrowhead_response: result.data,
      });
    }

    // ── C. Unsupported country — refuse rather than guess ──────────────
    return res.status(400).json({
      error: `Unsupported country code for ${phone}. Only +91 (India, in-house bot) and +1 (US, Arrowhead) are routed.`,
    });
  } catch (err: any) {
    console.error("[InHouse Call] Unexpected error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
