/**
 * Outbound call trigger — country-routes the lead:
 *
 *   +91 (India) → in-house ASBL Voice Bot (Anandita) at
 *                 https://asbl-voice-bot.onrender.com/api/trigger-call
 *   ANY other   → Arrowhead campaign (international leads — US, UK,
 *                 UAE, Canada, AUS, etc.)
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

/** Detect country region from E.164 number.
 *  India (+91)         → in-house voice bot
 *  ANY other country   → Arrowhead campaign (international leads)
 *
 *  Previously only +1 (US/Canada) went to Arrowhead and other intl
 *  numbers (UAE +971, UK +44, AUS +61, etc.) were rejected with 400.
 *  Per Mukund: all non-Indian international leads should be routed to
 *  Arrowhead. */
function detectRegion(e164: string): "IN" | "INTL" {
  const digits = e164.replace(/^\+/, "");
  if (digits.startsWith("91")) return "IN";
  return "INTL";
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

/** Trigger Arrowhead campaign for international leads.
 *
 * Translates Deluge's legacy Retell-style payload to Arrowhead's current
 * schema. As of May 2026, Arrowhead requires:
 *   - mobile_number (Deluge sends phone_number — rename)
 *   - external_customer_id (Deluge doesn't send — derive from mlid/lead_id)
 *   - external_schedule_id (Deluge sends ✓)
 *   - customer_full_name (Deluge sends inside retell_llm_dynamic_variables.customer_name)
 *   - input_variables (Deluge sends retell_llm_dynamic_variables — rename + flatten)
 *
 * Updating Deluge code requires Zoho admin access + testing; transforming
 * on the Vercel side is cheaper and keeps Deluge stable.
 */
async function triggerArrowheadUs(
  phone: string,
  rawBody: any,
): Promise<{ ok: boolean; status: number; data: any }> {
  const {
    _zoho_lead_id,
    phone_number,
    mobile_number,
    retell_llm_dynamic_variables,
    input_variables,
    external_schedule_id,
    external_customer_id,
    customer_full_name,
    agent_id, // ignored — Arrowhead's new schema doesn't use agent_id in body
    ...rest
  } = rawBody || {};

  const dyn = retell_llm_dynamic_variables || {};

  // Translate Retell-style dynamic variables → Arrowhead input_variables
  const builtInputVars = input_variables || {
    budget:                       dyn.budget                       || "",
    intent:                       dyn.intent                       || "",
    country:                      dyn.country                      || "",
    project:                      dyn.project_name                 || dyn.project || "",
    comments:                     dyn.comments                     || "",
    customer_name:                dyn.customer_name                || "",
    web_time_spent:               dyn.web_time_spent               || dyn.time_spent_minutes || "",
    size_preference:              dyn.size_preference              || "",
    call_enrichment_data:         dyn.call_enrichment_data         || "",
    floor_level_preference:       dyn.floor_level_preference       || dyn.floor_preference || "",
    handover_timeline_preference: dyn.handover_timeline_preference || dyn.timeline || "",
  };

  const arrowheadPayload = {
    customer_full_name:    customer_full_name      || dyn.customer_name || "",
    mobile_number:         mobile_number           || phone_number       || phone,
    external_customer_id:  external_customer_id    || dyn.mlid           || _zoho_lead_id || "",
    external_schedule_id:  external_schedule_id    || "",
    input_variables:       builtInputVars,
  };

  console.log(
    `[Arrowhead] POST ${ARROWHEAD_CAMPAIGN_URL_US} | ` +
    `payload keys=${Object.keys(arrowheadPayload).join(",")} ` +
    `ext_customer=${arrowheadPayload.external_customer_id} ` +
    `ext_schedule=${arrowheadPayload.external_schedule_id}`,
  );

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
          console.error(`[InHouse Call IN] updateLead failed: ${updateRes.reason?.message || updateRes.reason}`);
        } else {
          console.log(`[InHouse Call IN] Zoho stamped Lead_Status + Last_Inhouse_Call_ID=${callId} on lead ${zohoLeadId}`);
        }
        if (transRes.status === "rejected") {
          console.error(`[InHouse Call IN] blueprint transition failed: ${transRes.reason?.message || transRes.reason}`);
        }
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

    // ── B. International (any non-IN number) → Arrowhead campaign ──────
    if (region === "INTL") {
      if (!ARROWHEAD_BEARER_TOKEN) {
        console.error(`[InHouse Call INTL] ARROWHEAD_BEARER_TOKEN env var missing — call to ${phone} NOT scheduled`);
        return res.status(500).json({
          error: "ARROWHEAD_BEARER_TOKEN env var not configured. International calls cannot be scheduled.",
          attempted_phone: phone,
        });
      }

      const result = await triggerArrowheadUs(phone, body);
      console.log(
        `[InHouse Call INTL] Arrowhead POST → ${ARROWHEAD_CAMPAIGN_URL_US} | status=${result.status} ok=${result.ok} ` +
        `response=${JSON.stringify(result.data).slice(0, 300)}`,
      );

      if (!result.ok) {
        console.error(`[InHouse Call INTL] Arrowhead trigger FAILED for ${phone} (${result.status}):`, result.data);
        return res.status(result.status || 500).json({
          error: result.data?.error || result.data || `arrowhead ${result.status}`,
          arrowhead_response: result.data,
          attempted_phone: phone,
        });
      }

      console.log(`[InHouse Call INTL] Arrowhead campaign triggered for ${phone} ✓`);

      // Move Zoho lead to "Lead Initiated" — MUST await in Vercel serverless
      // (see IN branch comment above for why fire-and-forget was wrong).
      if (zohoLeadId) {
        const [updateRes, transRes] = await Promise.allSettled([
          updateLead(zohoLeadId, { Lead_Status: "Lead Initiated" }),
          triggerBlueprintTransition(zohoLeadId, "Lead Initiated"),
        ]);
        if (updateRes.status === "rejected") {
          console.error(`[InHouse Call INTL] updateLead failed: ${updateRes.reason?.message || updateRes.reason}`);
        }
        if (transRes.status === "rejected") {
          console.error(`[InHouse Call INTL] blueprint transition failed: ${transRes.reason?.message || transRes.reason}`);
        }
      }

      return res.status(200).json({
        success: true,
        region: "INTL",
        provider: "arrowhead",
        to: phone,
        arrowhead_response: result.data,
      });
    }

    // Should never reach here — IN + INTL cover all cases now
    return res.status(500).json({ error: `Unexpected region for ${phone}` });
  } catch (err: any) {
    console.error("[InHouse Call] Unexpected error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
