/**
 * GET /api/cron/followup
 *   - Daily at 04:30 UTC (10:00 AM IST) — runs followup sequence
 *
 * Followup logic:
 *   1. Get all phones we contacted (outbound messages in whatsapp_messages)
 *   2. Filter: no inbound reply ever received
 *   3. For each, check how many follow-ups already sent (follow_up_log)
 *   4. If < 10 and enough days have passed → send next follow-up
 *   5. Log to follow_up_log
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

const SUPABASE_URL       = process.env.SUPABASE_URL || "";
const SUPABASE_KEY       = process.env.SUPABASE_SECRET_KEY || "";
const PERISKOPE_API_KEY  = process.env.PERISKOPE_API_KEY || "";
const PERISKOPE_API_URL  = "https://api.periskope.app/v1/messages/send";

// ── 10 follow-up messages — professional English, no emojis ─────────────────
// From Anandita Reddy, Relationship Manager at ASBL
const FOLLOWUP_MESSAGES: string[] = [
  // Day 1
  `Dear Customer,

This is Anandita Reddy from ASBL. I wanted to follow up on your recent enquiry regarding ASBL Loft. We currently have a limited-time offer available that I believe would be of interest to you.

Please reply to this message at your convenience and I will be happy to share the details.`,

  // Day 2
  `Dear Customer,

I am reaching out again regarding your interest in ASBL Loft. The current pricing is very competitive and we have been receiving a strong response from prospective buyers.

I would be glad to walk you through the options available. Please feel free to reply and we can take it from there.`,

  // Day 3
  `Dear Customer,

I wanted to bring to your attention that the west-facing 1695 sq ft units at ASBL Loft are in high demand. Availability for this particular configuration is limited.

If you would like me to reserve a unit for your consideration, please reply and I will arrange it right away.`,

  // Day 4
  `Dear Customer,

Just a quick follow-up to let you know that the current offer at ASBL Loft is available for a limited period. Both the pricing and payment terms are very favorable at this time.

Should you have any questions, please do not hesitate to reply or call me directly.`,

  // Day 5
  `Dear Customer,

I am writing to inform you that only a few west-facing 1695 sq ft units remain available at ASBL Loft. This size and orientation has been among the most sought-after in the project.

I would recommend an early decision to secure the unit of your choice. Please reply and I will assist you promptly.`,

  // Day 6
  `Dear Customer,

The special pricing currently available at ASBL Loft is applicable for a limited number of bookings. Once these are utilised, the pricing will revert to standard rates.

If you are considering a purchase, now would be a good time to connect. Please reply at your convenience.`,

  // Day 7
  `Dear Customer,

We have seen considerable booking activity at ASBL Loft over the past few days. While floor plan and unit selection is still available, choices may become limited soon.

Please reply if you would like to discuss further. I am happy to answer any questions you may have.`,

  // Day 8
  `Dear Customer,

I wanted to remind you that the current offer at ASBL Loft is nearing its close. Securing the same terms at a later date may not be possible.

If now is a good time to connect, please reply and we can schedule a call or a site visit as per your preference.`,

  // Day 9
  `Dear Customer,

The west-facing 1695 sq ft configuration at ASBL Loft continues to receive strong interest. If you are evaluating this option, I am happy to provide all the details clearly and without any pressure.

Please reply whenever you are ready and I will ensure you have everything you need to make an informed decision.`,

  // Day 10
  `Dear Customer,

This will be my final follow-up message. I completely understand if the timing is not right at the moment.

Should you ever wish to revisit ASBL Loft or have any questions in the future, please feel free to reach out. The offer remains open and I am always available to assist you.`,
];

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function supabaseGet(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return r.json();
}

async function supabasePost(table: string, body: object): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      apikey:          SUPABASE_KEY,
      Authorization:   `Bearer ${SUPABASE_KEY}`,
      Prefer:          "resolution=ignore-duplicates", // skip if already sent
    },
    body: JSON.stringify(body),
  });
}

// ── Log a cron run (best-effort, never throws) ────────────────────────────────
async function logCronRun(
  task: string,
  durationMs: number,
  result: any,
  error: string | null,
): Promise<void> {
  try {
    const { appendCronLog } = await import("../_utils/ops_collections");
    await appendCronLog({ task, duration_ms: durationMs, result, error });
  } catch (err: any) {
    console.error(`[CronLog] log failed: ${err.message}`);
  }
}

// ── Get sender for phone (Phase 8: Mongo) ────────────────────────────────────
async function getSender(phone: string): Promise<string | null> {
  try {
    const { getSenderForPhone } = await import("../_utils/ops_collections");
    return await getSenderForPhone(phone);
  } catch {
    return null;
  }
}

// ── Send via Periskope ────────────────────────────────────────────────────────
async function sendMessage(phone: string, sender: string, message: string): Promise<void> {
  // Typing indicator
  try {
    await fetch("https://api.periskope.app/v1/chats/typing", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        Authorization:   `Bearer ${PERISKOPE_API_KEY}`,
        "x-phone":       sender,
      },
      body: JSON.stringify({ chat_id: `${phone}@c.us` }),
    });
  } catch { /* not critical */ }

  await new Promise(r => setTimeout(r, 3000)); // 3s delay

  const r = await fetch(PERISKOPE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      Authorization:   `Bearer ${PERISKOPE_API_KEY}`,
      "x-phone":       sender,
    },
    body: JSON.stringify({ chat_id: phone, message }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Periskope error ${r.status}: ${t}`);
  }
}


// ─── PRD v1.0 cadence processor (runs every 15 min) ─────────────────────
// Scans for leads where chatbot follow-up timer or SS call timer is due,
// then routes through prd_orchestrator. Honours channel exhaustion per
// user Option Y (both must exhaust before Not Interested).
async function runPrdCadenceProcessor(): Promise<{
  ms: number;
  scanned: number;
  chatbot_ticks: number;
  ss_call_ticks: number;
  no_reply_transitions: number;
  exhaustion_closes: number;
  errors: any[];
}> {
  const start = Date.now();
  const errors: any[] = [];
  let scanned = 0;
  let chatbotTicks = 0;
  let ssCallTicks = 0;
  let noReplyTransitions = 0;
  let exhaustionCloses = 0;

  try {
    const { getAccessToken } = await import("../_utils/zoho");
    const {
      handleChatbotFollowupTick,
      handleSsCallTick,
      handleChatbotNoReplyTimer,
    } = await import("../_utils/prd_orchestrator");
    const {
      CFG,
      bothChannelsExhausted,
      chatbotExhausted,
      ssCallExhausted,
    } = await import("../_utils/prd_cadence");
    const { onSsTreeExhausted } = await import("../_utils/prd_state_machine");

    const token = await getAccessToken();
    const now = Date.now();
    const nowIso = new Date(now).toISOString().replace(/\.\d{3}Z$/, "+00:00");

    // Pull ALL leads where PRD_Stage is non-terminal. PRD lifecycle (3
     // chatbot follow-ups × 24h + 3 SS calls × 4h) means a lead is "active"
     // for up to 3 days. With 500+ leads and only per_page=100, the cron
     // earlier only saw the 100 most-recently-modified — older leads silently
     // skipped → 272 phones (51%) got T=0 only, no follow-ups ever. Fixed
     // 2026-05-26 by paginating up to 10 pages of 200 (= 2000 leads max,
     // well over current volume).
    const FIELDS =
      `id,First_Name,Last_Name,Mobile,Phone,ASBL_Project,Created_Time,` +
      `PRD_Stage,PRD_Status,PRD_Last_Action_Time,PRD_Last_Action,` +
      `Chatbot_Attempt_Count,Chatbot_Follow_up_Count,SS_Call_Attempt_Count,` +
      `Site_Visit_Date,Last_Customer_Response,Intent_Captured,` +
      `Last_Resubmission_At`;
    const leads: any[] = [];
    const MAX_PAGES = 10;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await fetch(
        `https://www.zohoapis.in/crm/v3/Leads?fields=${FIELDS}` +
        `&per_page=200&page=${page}&sort_by=Modified_Time&sort_order=desc`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      );
      if (r.status === 204) break;
      if (!r.ok) {
        throw new Error(`Zoho list failed page ${page}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      }
      const text = await r.text();
      let data: any = null;
      if (text.trim()) { try { data = JSON.parse(text); } catch {} }
      const rows = (data?.data || []) as any[];
      leads.push(...rows);
      if (!data?.info?.more_records) break;
    }
    if (!leads.length) {
      return { ms: Date.now() - start, scanned: 0, chatbot_ticks: 0, ss_call_ticks: 0, no_reply_transitions: 0, exhaustion_closes: 0, errors: [] };
    }

    for (const lead of leads) {
      if (!lead.PRD_Stage) continue;            // not on PRD flow yet
      if (lead.PRD_Stage === "Not Interested") continue;
      if (lead.PRD_Stage === "Pre Site Visit") continue;  // reminder cron is separate concern

      scanned++;
      try {
        const phone = String(lead.Phone || lead.Mobile || "").replace(/\D/g, "");
        if (!phone) continue;
        const fullName = [lead.First_Name, lead.Last_Name].filter(Boolean).join(" ").trim() || "Sir";

        const lastActionTime = lead.PRD_Last_Action_Time
          ? new Date(lead.PRD_Last_Action_Time).getTime()
          : 0;
        const createdTime = lead.Created_Time
          ? new Date(lead.Created_Time).getTime()
          : 0;
        // Customer replied — don't spam more chatbot follow-ups. CF (chatbot
        // replied) and CS (preferred call time given) both mean engagement.
        const customerEngaged = lead.PRD_Status === "CF" || lead.PRD_Status === "CS";

        // 1. CHATBOT FOLLOW-UPS — decoupled from PRD_Status (was broken since
        //    voice-bot posthook flips Status to "SS" within ~30s of T=0,
        //    so no lead ever stayed in "NA" long enough for the old NA→SF
        //    24h transition to fire). New logic: fire follow-up #N when
        //    Created_Time + N*24h has elapsed AND customer hasn't engaged.
        //    Caps at 3 follow-ups per PRD spec.
        const followupsSent = lead.Chatbot_Follow_up_Count ?? 0;
        if (
          !customerEngaged &&
          followupsSent < CFG.CHATBOT_FOLLOWUP_MAX_ATTEMPTS &&
          createdTime > 0 &&
          now - createdTime >= (followupsSent + 1) * CFG.CHATBOT_FOLLOWUP_INTERVAL_MS
        ) {
          await handleChatbotFollowupTick({
            zoho_lead_id: lead.id,
            lead,
            phone,
            customer_name: fullName,
            project: lead.ASBL_Project,
          });
          chatbotTicks++;
        }

        // 2. SS call tick: SS state, due for next call attempt.
        //    SS_Call_Attempt_Count includes the T=0 call (set by
        //    handleLeadCreated). Cap is 3 total attempts.
        if (lead.PRD_Status === "SS" && !ssCallExhausted(lead)) {
          if (lastActionTime > 0 && now - lastActionTime >= CFG.SS_CALL_INTERVAL_MS) {
            await handleSsCallTick({
              zoho_lead_id: lead.id,
              lead,
              phone,
              customer_name: fullName,
              project: lead.ASBL_Project,
            });
            ssCallTicks++;
          }
        }

        // 4. Both exhausted check (Option Y): close as User Not Responding
        if (bothChannelsExhausted(lead)) {
          await onSsTreeExhausted(lead.id, lead);
          exhaustionCloses++;
        }
      } catch (err: any) {
        errors.push({ lead_id: lead.id, error: err.message });
      }
    }
  } catch (err: any) {
    errors.push({ stage: "prd_cadence_processor", error: err.message });
  }

  return {
    ms: Date.now() - start,
    scanned,
    chatbot_ticks: chatbotTicks,
    ss_call_ticks: ssCallTicks,
    no_reply_transitions: noReplyTransitions,
    exhaustion_closes: exhaustionCloses,
    errors: errors.slice(0, 10),
  };
}

// ── Main Handler ──────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Security: only allow Vercel cron or internal calls
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && req.method !== "GET") {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── PRD v1.0 cadence processor (every 15 min) ────────────────────────────
  if (req.query.task === "prd-cadence") {
    try {
      const result = await runPrdCadenceProcessor();
      await logCronRun("prd-cadence", result.ms, result, result.errors.length ? `${result.errors.length} errors` : null);
      return res.status(200).json({ task: "prd-cadence", ...result });
    } catch (err: any) {
      console.error("[PRD Cadence Cron] Fatal:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Meta lead backfill safety-net (runs every 15 min) ────────────────────
  // If Meta's webhook for any reason doesn't deliver a leadgen event to
  // our /api/ingest/meta endpoint (network blip, Meta auto-pause after
  // failures, app webhook URL drift), this cron polls the Meta Graph API
  // directly for each configured form, fetches the latest leads, and runs
  // them through ingestLead(). Idempotent — duplicates only bump
  // Resubmission_Count and outreach is suppressed by the 30-min cooldown.
  //
  // Form IDs come from env META_BACKFILL_FORM_IDS (comma-separated). If
  // unset, falls back to the two known ASBL Loft forms from May 2026.
  // Lookback window: last 2 hours (matches expected webhook delivery
  // window + 4x safety margin).
  if (req.query.task === "meta-backfill") {
    const start = Date.now();
    const result: any = { ms: 0, scanned: 0, created: 0, updated: 0, failed: 0, per_form: [] };
    try {
      const metaToken = process.env.META_PAGE_ACCESS_TOKEN || "";
      if (!metaToken) throw new Error("META_PAGE_ACCESS_TOKEN missing");

      const formIdsRaw = process.env.META_BACKFILL_FORM_IDS ||
        "3894470884180255,980466747851896";
      const formIds = formIdsRaw.split(",").map((s) => s.trim()).filter(Boolean);

      const { buildNormalizedLead } = await import("../ingest/meta");
      const { ingestLead } = await import("../_utils/ingest");

      // Lookback 2 hours
      const sinceUnix = Math.floor((Date.now() - 2 * 3600 * 1000) / 1000);

      for (const fid of formIds) {
        const created: any[] = [];
        const updated: any[] = [];
        const failed: any[] = [];
        let seen = 0;
        let errorMsg: string | null = null;
        try {
          const url =
            `https://graph.facebook.com/v19.0/${fid}/leads?` +
            `fields=id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id&` +
            `limit=50&` +
            `filtering=${encodeURIComponent(JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: sinceUnix }]))}&` +
            `access_token=${encodeURIComponent(metaToken)}`;
          const r = await fetch(url);
          const data = (await r.json()) as any;
          if (!r.ok || data?.error) {
            errorMsg = data?.error?.message || `HTTP ${r.status}`;
          } else {
            const items = Array.isArray(data?.data) ? data.data : [];
            seen = items.length;
            for (const item of items) {
              try {
                const enriched = { ...item, leadgen_id: item.id, form_id: fid };
                const lead = buildNormalizedLead(enriched);
                if (!lead) {
                  failed.push({ id: item.id, reason: "normalize_failed" });
                  continue;
                }
                const ir = await ingestLead(lead);
                if (ir.action === "created") created.push({ id: item.id, zoho: ir.zoho_lead_id, mobile: lead.mobile });
                else updated.push({ id: item.id, zoho: ir.zoho_lead_id });
              } catch (err: any) {
                failed.push({ id: item.id, error: (err.message || String(err)).slice(0, 200) });
              }
            }
          }
        } catch (err: any) {
          errorMsg = err.message;
        }
        result.per_form.push({
          form_id: fid,
          seen,
          created_count: created.length,
          updated_count: updated.length,
          failed_count: failed.length,
          error: errorMsg,
          created_sample: created.slice(0, 5),
          failed_sample: failed.slice(0, 3),
        });
        result.scanned += seen;
        result.created += created.length;
        result.updated += updated.length;
        result.failed += failed.length;
      }

      result.ms = Date.now() - start;
      await logCronRun("meta-backfill", result.ms, result, null);
      return res.status(200).json({ task: "meta-backfill", ...result });
    } catch (err: any) {
      result.ms = Date.now() - start;
      console.error("[Meta Backfill Cron] Fatal:", err.message);
      await logCronRun("meta-backfill", result.ms, result, err.message);
      return res.status(500).json({ error: err.message, ...result });
    }
  }

  // Default = daily follow-up sequence (legacy 10-message cron at 10AM IST).
  const followupStartTs = Date.now();
  try {
    const now = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    // 1. Get all unique phones that got outbound messages
    //    (Phase 4: migrated from Supabase to Mongo whatsapp_messages collection)
    const { getAllByDirection } = await import("../_utils/whatsapp_messages");
    const outbound = await getAllByDirection("outbound", 5000);

    // earliest outbound per phone
    const firstOutbound = new Map<string, number>(); // phone → timestamp
    for (const row of outbound) {
      if (!firstOutbound.has(row.phone)) {
        firstOutbound.set(row.phone, new Date(row.created_at).getTime());
      }
    }

    // 2. Get all phones that have replied (inbound)
    const inbound = await getAllByDirection("inbound", 5000);
    const repliedPhones = new Set(inbound.map((r: any) => r.phone));

    // 3. Get follow-up log (Phase 8: Mongo)
    const { getAllFollowUpLog } = await import("../_utils/ops_collections");
    const followupLog = await getAllFollowUpLog(5000);
    const followupCount = new Map<string, number>(); // phone → max day sent
    for (const row of followupLog) {
      const current = followupCount.get(row.phone) || 0;
      if (row.follow_up_day > current) followupCount.set(row.phone, row.follow_up_day);
    }

    const results: string[] = [];

    // 4. Process each phone
    for (const [phone, firstSentMs] of firstOutbound) {
      // Skip if they've replied
      if (repliedPhones.has(phone)) continue;

      const daysSinceFirst = Math.floor((now - firstSentMs) / ONE_DAY_MS);
      const lastFollowupDay = followupCount.get(phone) || 0;
      const nextFollowupDay = lastFollowupDay + 1;

      // Only send if: enough days passed AND still within 10 days
      if (nextFollowupDay > 10) continue;
      if (daysSinceFirst < nextFollowupDay) continue;

      // Get sender
      const sender = await getSender(phone);
      if (!sender) {
        console.log(`[Followup] No sender found for ${phone}, skipping`);
        continue;
      }

      // Get message
      const message = FOLLOWUP_MESSAGES[nextFollowupDay - 1];

      try {
        await sendMessage(phone, sender, message);

        // Log to Mongo (Phase 8)
        const { appendFollowUpLog } = await import("../_utils/ops_collections");
        await appendFollowUpLog({
          phone, follow_up_day: nextFollowupDay, sender,
        });

        // Save to whatsapp_messages (Phase 4: Mongo)
        const { insertMessage } = await import("../_utils/whatsapp_messages");
        await insertMessage({
          phone, direction: "outbound", message, sender,
          project: null, intent: null,
          created_at: new Date().toISOString(),
        });

        console.log(`[Followup] ✅ ${phone} → Day ${nextFollowupDay}`);
        results.push(`${phone}: Day ${nextFollowupDay} sent`);

        // Delay between messages to avoid rate limits
        await new Promise(r => setTimeout(r, 2000));

      } catch (err: any) {
        console.error(`[Followup] ❌ ${phone}: ${err.message}`);
        results.push(`${phone}: ERROR - ${err.message}`);
      }
    }

    const durationMs = Date.now() - followupStartTs;
    await logCronRun("followup", durationMs, { processed: results.length, results }, null);

    return res.status(200).json({
      success: true,
      processed: results.length,
      durationMs,
      results,
    });

  } catch (err: any) {
    const durationMs = Date.now() - followupStartTs;
    console.error("[Followup Cron] Error:", err.message);
    await logCronRun("followup", durationMs, null, err.message);
    return res.status(500).json({ error: err.message });
  }
}
