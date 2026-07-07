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
  stalled_calls_rescheduled: number;
  errors: any[];
}> {
  const start = Date.now();
  const errors: any[] = [];
  let scanned = 0;
  let chatbotTicks = 0;
  let ssCallTicks = 0;
  let noReplyTransitions = 0;
  let exhaustionCloses = 0;
  let stalledRescheduled = 0;

  try {
    const { getAccessToken, updateLead } = await import("../_utils/zoho");
    const { mirrorLeadStateToMongo } = await import("../_utils/supabase");
    const {
      handleChatbotFollowupTick,
      handleChatbotReengagementTick,
    } = await import("../_utils/prd_orchestrator");
    const {
      CFG,
      chatbotExhausted,
    } = await import("../_utils/prd_cadence");
    const { onSsTreeExhausted } = await import("../_utils/prd_state_machine");
    const { isWithinCustomerHours } = await import("../_utils/call_scheduling");

    // v3 calling (2026-06-18 product note) has no time-bound voice exhaustion —
    // calls loop on fixed slot hours until pickup OR manual stop (Lead_Status
    // = "Not Interested" / PRD_Stage = "Spam" / Next_Call_At cleared). The
    // chatbot 7-day window auto-close path used to use voiceExhausted(); now
    // it's a no-op stub since chatbot follow-ups are also off.
    const voiceExhausted = (_lead: any): boolean => false;

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
      `Chatbot_Attempt_Count,Chatbot_Follow_up_Count,` +
      `Total_Call_Duration_Secs,` +  // needed for 7-day silence check
      `Next_Call_At,` +              // v3 call gate — slot-based scheduling
      `Last_Inhouse_Call_ID,` +      // stalled-call safety-net guard (has this lead ever been called?)
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
      return { ms: Date.now() - start, scanned: 0, chatbot_ticks: 0, ss_call_ticks: 0, no_reply_transitions: 0, exhaustion_closes: 0, stalled_calls_rescheduled: 0, errors: [] };
    }

    // Per-phone bot kill-switch lookup. The inbound webhook respects
    // user_profiles.bot_enabled = false, but the cron historically did
    // not. So sales would toggle a lead's bot OFF via the dashboard and
    // inbound replies would stop, but unsolicited cron follow-ups would
    // keep firing. Fixed 2026-06-19 by pre-fetching the disabled set
    // and skipping those phones below.
    let disabledPhones = new Set<string>();
    try {
      const { getCollection, COL } = await import("../_utils/mongo");
      const upCol = await getCollection(COL.USER_PROFILES);
      const disabledDocs = await upCol.find({ bot_enabled: false as any }, { projection: { phone: 1 } as any }).toArray();
      disabledPhones = new Set(
        disabledDocs.map((d: any) => String(d.phone || d._id || "").replace(/\D/g, "")).filter(Boolean),
      );
      if (disabledPhones.size > 0) {
        console.log(`[PRD cron] Bot kill-switch: ${disabledPhones.size} phones will be skipped this tick`);
      }
    } catch (err: any) {
      console.error(`[PRD cron] bot_enabled lookup failed: ${err.message}`);
    }

    // GLOBAL WhatsApp-follow-up pause switch. When bot_settings
    // whatsapp_followups_paused = "true", we skip the cold/ghost chatbot
    // follow-up sends this tick but STILL run the call cadence (calls are
    // unaffected). Toggle from the dashboard / ?action=set-followup-pause —
    // no deploy needed to pause or resume.
    let waFollowupsPaused = false;
    try {
      const { getBotSetting } = await import("../_utils/bot_settings");
      const row = await getBotSetting("whatsapp_followups_paused");
      waFollowupsPaused = row?.value === "true";
      if (waFollowupsPaused) console.log("[PRD cron] WhatsApp follow-ups PAUSED — skipping chatbot ticks (calls still run)");
    } catch (err: any) {
      console.error(`[PRD cron] followup-pause lookup failed: ${err.message}`);
    }

    for (const lead of leads) {
      if (!lead.PRD_Stage) continue;            // not on PRD flow yet
      if (lead.PRD_Stage === "Not Interested") continue;
      if (lead.PRD_Stage === "Spam") continue;             // sales-marked spam — never follow up
      if (lead.PRD_Stage === "Pre Site Visit") continue;  // reminder cron is separate concern

      // Bot kill-switch — skip phones where sales has disabled the bot.
      const leadPhoneNorm = String(lead.Phone || lead.Mobile || "").replace(/\D/g, "");
      if (leadPhoneNorm && disabledPhones.has(leadPhoneNorm)) {
        continue;
      }

      // SILENCE AUTO-STOP — stop outreach to a never-engaged lead, but ONLY
      // after the full cold follow-up window (15 days, CFG.COLD_FOLLOWUP_WINDOW_MS).
      //
      // BUG (fixed 2026-06-29): this used a hardcoded 7 days, citing the OLD
      // "3 follow-ups" spec. The current spec is 15 days of 7-hourly cold
      // pings for never-replied leads — but a 7-day silence stop short-circuits
      // the loop (continue) BEFORE the cold branch runs, killing cold
      // follow-ups at ~day 7. That's why leads like Sameer (created Jun 7,
      // never replied) stopped at 3 follow-ups on Jun 11 instead of running
      // through Jun 22. Aligning to the cold window lets the 15-day campaign
      // actually run; the cold branch's own !withinColdWindow check then
      // closes the lead cleanly at day 15.
      const silenceStopMs = CFG.COLD_FOLLOWUP_WINDOW_MS;
      const createdTimeForSilence = lead.Created_Time ? new Date(lead.Created_Time).getTime() : 0;
      if (createdTimeForSilence > 0 && (now - createdTimeForSilence) >= silenceStopMs) {
        const totalCallSecs = Number(lead.Total_Call_Duration_Secs ?? 0);
        const customerEngagedEver = lead.PRD_Status === "CF" || lead.PRD_Status === "CS";
        // "Connected call" proxy = any total duration > 10s (rings <10s = no answer)
        const everConnected = totalCallSecs > 10;
        if (!customerEngagedEver && !everConnected) {
          continue; // skip outreach silently
        }
      }

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

        // 1. CHATBOT FOLLOW-UPS (v2 — 2026-06-18 product call).
        //
        //    COLD branch — customer has NEVER replied to T=0 greeting:
        //      Every 7h gap (CFG.COLD_FOLLOWUP_INTERVAL_MS), gated to
        //      [7AM, 9PM) in CUSTOMER timezone, up to 15 days from
        //      Created_Time. Same sender (sticky-per-phone). Six rotating
        //      templates so 2-3 messages/day don't feel robotic.
        //
        //    GHOST branch — customer replied earlier but went silent:
        //      First fire at last-inbound + 25h (CFG.GHOST_INITIAL_DELAY_MS),
        //      every 24h after that, up to 7 days from last inbound.
        //      Message quotes a short excerpt of the customer's last reply
        //      so it reads contextual not cold-pitchy. Same sender.
        //
        //    Common gates:
        //      - chatbotExhausted (50-attempt safety cap)
        //      - 7AM-9PM CUSTOMER-local hours
        //      - PRD_Stage in {Not Interested, Spam, Pre Site Visit} → skipped
        //        upstream
        //      - bot_enabled = false (per-phone kill-switch via dashboard)
        const followupsSent = lead.Chatbot_Follow_up_Count ?? 0;
        const counterUnderCap = followupsSent < CFG.CHATBOT_FOLLOWUP_MAX_ATTEMPTS;

        // waFollowupsPaused (global switch) skips ALL cold/ghost chatbot sends
        // this tick while leaving the call cadence below untouched.
        if (!waFollowupsPaused && counterUnderCap && createdTime > 0) {
          try {
            const { getCollection, COL } = await import("../_utils/mongo");
            const wmCol = await getCollection(COL.WHATSAPP_MESSAGES);
            const phoneDoc = await wmCol.findOne(
              { _id: phone as any },
              { projection: { by_date: 1 } },
            );
            // Walk by_date desc to capture: most-recent outbound time,
            // most-recent inbound time, and the most-recent inbound TEXT
            // (used by the ghost re-engagement template to quote what the
            // customer said).
            let lastOutboundMs = 0;
            let lastInboundMs = 0;
            let lastInboundText = "";
            if (phoneDoc?.by_date) {
              const dates = Object.keys(phoneDoc.by_date).sort().reverse();
              for (const dk of dates) {
                const dayBucket = (phoneDoc.by_date[dk] as any) || {};
                // parseTs accepts ISO strings, numeric ms, and ms-as-string.
                // Returns 0 for unparseable values so the gate logic doesn't
                // crash on malformed history rows.
                const parseTs = (raw: any): number => {
                  if (raw == null) return 0;
                  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
                  const asNum = Number(raw);
                  if (Number.isFinite(asNum) && asNum > 1_000_000_000_000) return asNum;
                  const d = new Date(raw);
                  const t = d.getTime();
                  return Number.isFinite(t) ? t : 0;
                };
                if (lastOutboundMs === 0) {
                  const outArr = dayBucket.outbound || [];
                  for (let i = outArr.length - 1; i >= 0; i--) {
                    const t = parseTs(outArr[i]?.time);
                    if (t > lastOutboundMs) lastOutboundMs = t;
                    if (lastOutboundMs > 0) break;
                  }
                }
                if (lastInboundMs === 0) {
                  const inArr = dayBucket.inbound || [];
                  for (let i = inArr.length - 1; i >= 0; i--) {
                    const t = parseTs(inArr[i]?.time);
                    if (t > lastInboundMs) {
                      lastInboundMs = t;
                      lastInboundText = String(inArr[i]?.message || "");
                    }
                    if (lastInboundMs > 0) break;
                  }
                }
                if (lastOutboundMs > 0 && lastInboundMs > 0) break;
              }
            }

            const everReplied = lastInboundMs > 0;
            const inCustomerHours = isWithinCustomerHours(phone, 7, 21);

            if (!everReplied) {
              // ── COLD branch ──────────────────────────────────────────
              const sinceCreated = now - createdTime;
              const withinColdWindow = sinceCreated <= CFG.COLD_FOLLOWUP_WINDOW_MS;
              // Anchor the 7h gap on last outbound (T=0 greeting or last
              // follow-up). If we've never sent anything, anchor on
              // Created_Time so the first follow-up fires 7h after birth.
              const lastSendMs = lastOutboundMs > 0 ? lastOutboundMs : createdTime;
              const dueByInterval = (now - lastSendMs) >= CFG.COLD_FOLLOWUP_INTERVAL_MS;

              if (withinColdWindow && dueByInterval && inCustomerHours) {
                await handleChatbotFollowupTick({
                  zoho_lead_id: lead.id,
                  lead,
                  phone,
                  customer_name: fullName,
                  project: lead.ASBL_Project,
                });
                chatbotTicks++;
              } else if (!withinColdWindow) {
                // 15-day cold window expired with zero engagement → close.
                await onSsTreeExhausted(lead.id, lead);
                exhaustionCloses++;
              }
            } else {
              // ── GHOST branch ─────────────────────────────────────────
              const sinceLastInbound = now - lastInboundMs;
              const withinGhostWindow = sinceLastInbound <= CFG.GHOST_WINDOW_MS;
              const pastInitialDelay = sinceLastInbound >= CFG.GHOST_INITIAL_DELAY_MS;
              // After the first ghost fire, anchor the 24h cadence on the
              // bot's last outbound. If outbound is null (no bot reply yet
              // since the customer's last inbound), the initial-delay check
              // alone gates the first fire.
              const lastSendMs = lastOutboundMs;
              const dueByInterval =
                lastSendMs === 0 || (now - lastSendMs) >= CFG.GHOST_INTERVAL_MS;
              // Don't ping mid-conversation: lastSendMs > lastInboundMs means
              // we already replied to the customer's last message (probably
              // the inbound bot reply) — they may yet respond. Wait for
              // the INITIAL_DELAY past their inbound, not since our reply.
              const realDueByInterval =
                lastSendMs <= lastInboundMs ? true : (now - lastSendMs) >= CFG.GHOST_INTERVAL_MS;

              if (withinGhostWindow && pastInitialDelay && dueByInterval && realDueByInterval && inCustomerHours) {
                await handleChatbotReengagementTick({
                  zoho_lead_id: lead.id,
                  lead,
                  phone,
                  customer_name: fullName,
                  project: lead.ASBL_Project,
                  hours_since_last_reply: sinceLastInbound / 3_600_000,
                  last_inbound_text: lastInboundText,
                });
                chatbotTicks++;
              } else if (!withinGhostWindow) {
                // Ghost window expired with no further reply → close.
                await onSsTreeExhausted(lead.id, lead);
                exhaustionCloses++;
              }
            }
          } catch (err: any) {
            console.error(`[PRD cron] chatbot gate read failed for ${phone}: ${err.message}`);
          }
        }

        // 2. CALL FOLLOW-UP TICK (v3 — 2026-06-18, slot-based per product note).
        //    State machine fully owned by the posthook:
        //      - T=0:          handleLeadCreated fires the initial call.
        //      - posthook:     computes the next-call schedule (next slot
        //                       from the picked / not-picked hour grid in
        //                       customer TZ, capped at 7 days from born)
        //                       and writes Next_Call_At onto the lead.
        //      - this cron:    fires the call when now >= Next_Call_At,
        //                       then clears Next_Call_At so we don't
        //                       re-fire within the same cron tick if the
        //                       posthook hasn't arrived yet. Posthook
        //                       writes the next Next_Call_At when it lands.
        //
        //    Removed (2026-06-18): v1 SS-call tree (3 × 4h), v2 retry
        //    tree (10-min + 3h aggressive + 3-day exhaustion). v3 is just
        //    slot hours + 7-day lifetime cap.
        {
          const nextCallAtMs = lead.Next_Call_At ? new Date(lead.Next_Call_At).getTime() : 0;
          // Compute the next MISS-grid slot now (respects the 7-day cap — null
          // once the lead is past its lifetime). Used both as the SELF-HEAL
          // value when firing and as the SAFETY-NET reschedule value.
          const { nextCallAfterMiss, zohoIso: schedIso } = await import("../_utils/call_scheduling");
          const nextSlot = nextCallAfterMiss({ phone, createdAt: lead.Created_Time });
          const nextSlotIso = nextSlot.nextCallAt ? schedIso(nextSlot.nextCallAt) : null;

          if (nextCallAtMs > 0 && nextCallAtMs <= now) {
            try {
              // SELF-HEAL (fix 2026-07-07): set Next_Call_At to the NEXT slot
              // up front instead of null. Previously it was cleared to null and
              // ONLY the posthook re-set it — so a single missed posthook
              // (failed call / dropped call_completed webhook) stalled the lead
              // forever with Next_Call_At=null and no more calls. Setting the
              // next slot means the cadence self-recovers even if the posthook
              // never lands; the posthook simply overwrites this with the
              // outcome-accurate slot when it does arrive. (Slot is >= next grid
              // hour, so no 15-min re-fire loop.)
              await updateLead(lead.id, { Next_Call_At: nextSlotIso });
              await mirrorLeadStateToMongo(lead.id, { Next_Call_At: nextSlotIso });
              const { fireAiCallDirect } = await import("../_utils/prd_orchestrator");
              await fireAiCallDirect({
                zoho_lead_id: lead.id,
                phone,
                customer_name: fullName,
                project: lead.ASBL_Project,
              });
              ssCallTicks++;
            } catch (err: any) {
              console.error(`[PRD cron] call fire failed for ${lead.id}: ${err.message}`);
            }
          } else if (nextCallAtMs === 0 && nextSlotIso && lead.Last_Inhouse_Call_ID) {
            // SAFETY-NET (fix 2026-07-07): the lead has already had a call but
            // Next_Call_At is null while still inside the 7-day window — i.e.
            // its scheduling posthook was missed and it's stuck. Re-schedule
            // the next slot so calling resumes on the next tick. Guarded by
            // Last_Inhouse_Call_ID so we never step on a brand-new lead's T=0
            // flow, and by nextSlotIso (non-null) so past-cap leads stay closed.
            try {
              await updateLead(lead.id, { Next_Call_At: nextSlotIso });
              await mirrorLeadStateToMongo(lead.id, { Next_Call_At: nextSlotIso });
              stalledRescheduled++;
            } catch (err: any) {
              console.error(`[PRD cron] stalled-call reschedule failed for ${lead.id}: ${err.message}`);
            }
          }
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
    stalled_calls_rescheduled: stalledRescheduled,
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

  // ── Unique-lead flag sync (every hour) ────────────────────────────────────
  // Walks all Zoho leads, picks the most-recently-modified per phone, and
  // PATCHes Is_Unique_Lead=true on that one + false on its siblings. Drives
  // the "Unique Leads" Custom View in Zoho. Idempotent — only PATCHes records
  // whose computed value differs from the current Zoho value, so steady-state
  // runs are nearly free.
  if (req.query.task === "mark-unique-leads") {
    try {
      const { syncUniqueLeadFlags } = await import("../_utils/unique_leads");
      const result = await syncUniqueLeadFlags();
      await logCronRun("mark-unique-leads", result.ms, result, null);
      return res.status(200).json({ task: "mark-unique-leads", ...result });
    } catch (err: any) {
      console.error("[Mark Unique Leads Cron] Fatal:", err.message);
      await logCronRun("mark-unique-leads", 0, {}, err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Mongo lead sync (every 15 min) — Zoho -> Mongo, for in-house CRM ────
  // PURELY ADDITIVE. Keeps the Mongo `leads` collection a complete + fresh
  // copy of Zoho (incl. leads created directly in Zoho + sales manual edits)
  // so the in-house CRM can read everything from Mongo. Does NOT touch any
  // call/WhatsApp/followup logic — it only reads Zoho and writes Mongo.
  // Incremental: syncs leads modified since the last run (with a 30-min
  // overlap buffer so nothing slips through), tracked in bot_settings.
  if (req.query.task === "mongo-sync") {
    const start = Date.now();
    try {
      const { getBotSetting, setBotSetting } = await import("../_utils/bot_settings");
      const { runZohoLeadSync } = await import("../_utils/supabase");
      const lastRow = await getBotSetting("mongo_sync_last_run");
      // 30-min overlap buffer; first-ever run defaults to last 24h.
      const sinceMs = lastRow?.value
        ? new Date(lastRow.value).getTime() - 30 * 60 * 1000
        : Date.now() - 24 * 60 * 60 * 1000;
      const since = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, "+00:00");
      const result = await runZohoLeadSync({ since, maxPages: 30 });
      // Stamp the run time only on success (so a failed run re-tries the window).
      if (!result.errors.length) {
        await setBotSetting("mongo_sync_last_run", new Date(start).toISOString());
      }
      await logCronRun("mongo-sync", result.ms, result, result.errors.length ? `${result.errors.length} errors` : null);
      return res.status(200).json({ task: "mongo-sync", since, ...result });
    } catch (err: any) {
      console.error("[Mongo Sync Cron] Fatal:", err.message);
      await logCronRun("mongo-sync", Date.now() - start, {}, err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Pre-Site-Visit reminder cron (every hour) ──────────────────────────
  // Audit 2026-06-19 surfaced: leads with PRD_Stage = "Pre Site Visit" and
  // a future Site_Visit_Date were getting ZERO automated reminders because
  // no reminder cron existed (the main prd-cadence cron explicitly SKIPs
  // them with a comment "reminder cron is separate concern" but the cron
  // was never built). Now it is:
  //   - 24h before site visit → 1 reminder WhatsApp
  //   - 3h before site visit → 1 reminder WhatsApp
  // Runs hourly so the gates fire at granular hour-windows. Idempotency
  // via Mongo dedup keys: phone_visit-24h / phone_visit-3h written after
  // each send.
  if (req.query.task === "pre-site-visit-reminders") {
    const start = Date.now();
    const result: any = { ms: 0, scanned: 0, fired_24h: 0, fired_3h: 0, errors: [] as any[] };
    try {
      const { getAccessToken } = await import("../_utils/zoho");
      const { getCollection, COL } = await import("../_utils/mongo");
      const orchestrator = await import("../_utils/prd_orchestrator");
      const fireChatbot = (orchestrator as any).fireChatbotMessage as
        | undefined
        | ((p: string, m: string, proj?: string) => Promise<{ ok: boolean }>);

      const token = await getAccessToken();
      const FIELDS = "id,First_Name,Last_Name,Mobile,Phone,ASBL_Project,Site_Visit_Date,PRD_Stage";
      const now = Date.now();
      const horizonHigh = now + 26 * 3600 * 1000; // catch leads up to 26h away

      const r = await fetch(
        `https://www.zohoapis.in/crm/v3/Leads/search?` +
        `criteria=(PRD_Stage:equals:Pre Site Visit)&fields=${FIELDS}&per_page=200`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      );
      const arr: any[] = r.ok ? (((await r.json()) as any)?.data || []) : [];
      result.scanned = arr.length;

      const remCol = await getCollection("psv_reminders" as any);
      for (const lead of arr) {
        try {
          const visitMs = lead.Site_Visit_Date ? new Date(lead.Site_Visit_Date).getTime() : 0;
          if (!visitMs || visitMs <= now) continue;
          const phone = String(lead.Phone || lead.Mobile || "").replace(/\D/g, "");
          if (!phone || !fireChatbot) continue;
          const project = lead.ASBL_Project || "ASBL";
          const fullName = [lead.First_Name, lead.Last_Name].filter(Boolean).join(" ").trim() || "Sir";
          const hoursOut = (visitMs - now) / 3600000;
          // 24h window: between 23h and 25h before visit
          if (hoursOut >= 23 && hoursOut <= 25 && visitMs < horizonHigh) {
            const key = `${phone}-${visitMs}-24h`;
            const exists = await remCol.findOne({ _id: key as any });
            if (!exists) {
              const msg = `Hi ${fullName}, just a quick reminder. Your site visit to ${project} is tomorrow. Let me know if you need directions or any prep details.`;
              const sent = await fireChatbot(phone, msg, project);
              if (sent.ok) {
                await remCol.insertOne({ _id: key as any, sent_at: new Date().toISOString() } as any);
                result.fired_24h++;
              }
            }
          }
          // 3h window: between 2h and 4h before visit
          if (hoursOut >= 2 && hoursOut <= 4) {
            const key = `${phone}-${visitMs}-3h`;
            const exists = await remCol.findOne({ _id: key as any });
            if (!exists) {
              const msg = `Hi ${fullName}, your ${project} site visit is in about 3 hours. The team is ready to host you. Reply if anything changes.`;
              const sent = await fireChatbot(phone, msg, project);
              if (sent.ok) {
                await remCol.insertOne({ _id: key as any, sent_at: new Date().toISOString() } as any);
                result.fired_3h++;
              }
            }
          }
        } catch (err: any) {
          result.errors.push({ lead_id: lead.id, error: err.message });
        }
      }
      result.ms = Date.now() - start;
      await logCronRun("pre-site-visit-reminders", result.ms, result, null);
      return res.status(200).json({ task: "pre-site-visit-reminders", ...result });
    } catch (err: any) {
      console.error("[PSV Reminders Cron] Fatal:", err.message);
      result.ms = Date.now() - start;
      await logCronRun("pre-site-visit-reminders", result.ms, result, err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // Default = legacy 10-day daily follow-up sequence — DISABLED 2026-06-09.
  // Reason: messages are all hardcoded for "ASBL Loft current offer" copy
  // which is outdated (offer ended) AND would fire for BROADWAY/SPECTRA/
  // LANDMARK leads with the wrong project name. PRD chatbot follow-up
  // (3 attempts max, 24h gated, project-aware) supersedes this loop.
  // Schedule entry removed from vercel.json; this early-return ensures
  // any manual hits also no-op cleanly.
  if (req.query.task !== "prd-cadence" && req.query.task !== "meta-backfill" && req.query.task !== "mark-unique-leads" && req.query.task !== "pre-site-visit-reminders") {
    return res.status(200).json({
      task: "legacy-followup",
      disabled: true,
      reason: "Legacy 10-day daily follow-up cron disabled 2026-06-09. PRD chatbot follow-up (task=prd-cadence) is the only active outbound follow-up loop now.",
    });
  }

  // (Unreachable — kept for code archaeology, can be deleted in next pass.)
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
