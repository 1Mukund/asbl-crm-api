/**
 * PRD v1.0 — central orchestrator. Every external event (lead create,
 * chatbot reply, call outcome, site visit booking, opt-out) goes through
 * this module so state transitions + counter updates + side effects are
 * applied consistently.
 *
 * Per user clarification:
 *   - T=0 (lead-created): fire chatbot WhatsApp + AI call SIMULTANEOUSLY
 *   - Channels run independent timers afterwards
 *   - Lead → Not Interested only when BOTH channels exhaust (Option Y)
 *   - Pre Site Visit confirmation also uses SS tree (Option A)
 */
import { sendDocViaPeriskope } from "./document_dispatcher";
import {
  onLeadCreated,
  onChatbotReply,
  onChatbotNoReply,
  onCallOutcome,
  onSiteVisitBooked,
  onNotInterested,
  onSsTreeExhausted,
  onPreSiteVisitSsExhausted,
  CallOutcome,
  Stage,
} from "./prd_state_machine";
import {
  CFG,
  chatbotExhausted,
  incrementChatbotAttempt,
  incrementChatbotFollowup,
} from "./prd_cadence";
import { displayProject, displayName } from "./project_detection";

const PERISKOPE_API_KEY = process.env.PERISKOPE_API_KEY || "";
const PERISKOPE_API_URL = "https://api.periskope.app/v1/messages/send";

// ─── 10 round-robin sender numbers (Periskope sender pool) ──────────────
const SENDER_POOL = [
  "917793952828",
  "919247598804",
  "919247597422",
  "919247597421",
  "919247597423",
  "919247597420",
  "919247597418",
  "919247597426",
  "919247597419",
  "919247597417",
];

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

async function pickSender(phone: string): Promise<string> {
  // Phase 8: migrated from Supabase to Mongo (whatsapp_sender_map + _counters.sender_idx).
  try {
    const { getSenderForPhone, getNextSenderIndex } = await import("./ops_collections");
    const existing = await getSenderForPhone(phone);
    if (existing) return existing;
    const idx = await getNextSenderIndex(SENDER_POOL.length);
    return SENDER_POOL[idx] || SENDER_POOL[0];
  } catch {
    return SENDER_POOL[Math.floor(Math.random() * SENDER_POOL.length)];
  }
}

// ─── Action triggers ─────────────────────────────────────────────────────

/** Detect a "this sender's WhatsApp phone is dead" response from Periskope.
 *  Covers their UNAUTHORIZED_ERROR + "phone server instance is switched off"
 *  message + generic 401/403/500 + the "/phone/restart" hint. When this hits
 *  we don't fail the send — we mark the sender dead and fall through to the
 *  next pool member. */
function isDeadSenderResponse(status: number, body: string): boolean {
  const b = body.toLowerCase();
  if (b.includes("phone server") && b.includes("switched off")) return true;
  if (b.includes("/phone/restart")) return true;
  if (b.includes("unauthorized_error")) return true;
  // 401 from Periskope on a per-x-phone send almost always means the phone
  // is offline (not the API key — we'd see that on every request, not one).
  if (status === 401) return true;
  return false;
}

/** Fire a WhatsApp message via Periskope (initial or follow-up).
 *
 *  Pool-wide fallback: if the sticky-mapped sender is dead (Periskope 401
 *  / "phone server switched off"), iterate through the full SENDER_POOL
 *  until one succeeds. On success, re-stick the phone to the winning
 *  sender. Dead senders are recorded in Mongo with a 1-hour TTL so other
 *  phones routed during this hour also skip them.
 *
 *  Before this fix (bug observed 2026-06-18 for lead 919951382116 / Range):
 *  a dead sticky-sender would permanently block the lead — no greeting,
 *  no follow-up, no callback. Customer goes silent in our funnel.
 */
export async function fireChatbotMessage(phone: string, message: string, project?: string): Promise<{ ok: boolean; error?: string }> {
  // Build send order: sticky first (if alive), then everything else in pool
  // order. Skip senders we already know are dead within the 1h TTL.
  const ops = await import("./ops_collections");
  const stickySender = await ops.getSenderForPhone(phone);
  const deadSet = await ops.getDeadSenders().catch(() => new Set<string>());

  const ordered: string[] = [];
  if (stickySender && !deadSet.has(stickySender)) ordered.push(stickySender);
  for (const s of SENDER_POOL) {
    if (s === stickySender) continue;
    if (deadSet.has(s)) continue;
    ordered.push(s);
  }
  // If everyone known-dead, still try the full pool — TTL might be stale.
  if (!ordered.length) ordered.push(...SENDER_POOL);

  let lastErr = "";
  let tried = 0;
  for (const sender of ordered) {
    tried++;
    try {
      const r = await fetch(PERISKOPE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PERISKOPE_API_KEY}`,
          "x-phone": sender,
        },
        body: JSON.stringify({ chat_id: phone, message }),
      });

      if (r.ok) {
        // Reset this sender's consecutive-failure counter on every
        // successful delivery so a transient blip doesn't drift towards
        // the permanent-dead alert threshold.
        await ops.recordSenderSuccess(sender).catch(() => {});
        // Save to whatsapp_messages so it shows in dashboard + LLM history.
        try {
          const { insertMessage } = await import("./whatsapp_messages");
          await insertMessage({
            phone, direction: "outbound", message, sender,
            project: project || null, intent: null,
            created_at: new Date().toISOString(),
          });
          // Sticky update policy:
          //   - First-ever send for this phone → set sticky to whoever
          //     delivered (could be any pool member via round-robin).
          //   - Sticky alive + we used it → no update needed (same value).
          //   - Sticky dead + we fell back → DO NOT promote the substitute.
          //     Keep original sticky so when ops restarts that phone, the
          //     customer's conversation returns to its original number
          //     instead of being permanently split across 2 senders.
          const isFirstStick = !stickySender;
          const usedSticky = stickySender === sender;
          if (isFirstStick || usedSticky) {
            await ops.setSenderForPhone(phone, sender);
          }
        } catch {}
        if (tried > 1) {
          console.log(`[PRD Orch] WhatsApp sent to ${phone} via ${sender} (after ${tried - 1} dead-sender fallback${tried > 2 ? "s" : ""}; sticky preserved at ${stickySender || sender})`);
        }
        return { ok: true };
      }

      const txt = (await r.text()).slice(0, 200);
      lastErr = `${r.status}:${txt}`;
      if (isDeadSenderResponse(r.status, txt)) {
        console.warn(`[PRD Orch] Sender ${sender} dead (${r.status}) — marking + trying next`);
        await ops.markSenderDead(sender).catch(() => {});
        continue;
      }
      // Non-sender error (4xx for bad payload, customer blocked us, etc.)
      // — won't be fixed by trying another sender. Stop here.
      console.error(`[PRD Orch] WhatsApp send failed via ${sender} (${r.status}): ${txt}`);
      return { ok: false, error: txt };
    } catch (err: any) {
      lastErr = err.message;
      console.warn(`[PRD Orch] Sender ${sender} threw — trying next: ${err.message}`);
      continue;
    }
  }

  // ALL senders failed for this phone. This is rare (whole pool down) but
  // critical when it happens — customer gets no message and nobody knows.
  // Write a stuck_sends Mongo entry so the dashboard can surface a banner
  // and ops can manually run /phone/restart. Logged at error so it stands
  // out in Vercel logs too.
  console.error(`[PRD Orch] WhatsApp send EXHAUSTED — all ${tried} senders failed for ${phone}. Last error: ${lastErr}`);
  try {
    const { getCollection } = await import("./mongo");
    const stuckCol = await getCollection("stuck_sends" as any);
    await stuckCol.insertOne({
      phone, message: message.slice(0, 200),
      tried_senders: tried, last_error: lastErr,
      at: new Date().toISOString(),
    } as any);
  } catch {}
  return { ok: false, error: `all senders exhausted: ${lastErr}` };
}

/** Fire an outbound AI call via our self-deployed relay → in-house voice-bot
 *  (Plivo for +91 India, Telnyx for everything else; voice-bot picks).
 *
 *  No calling-hours gate on our side. T=0 calls fire immediately; follow-up
 *  calls are scheduled by call_scheduling.ts using the customer's timezone
 *  (8 AM-9 PM customer-local for pickup follow-up, 7 AM-9 PM customer-local
 *  for the not-picked aggressive retry tree). */
/** Public alias for the cron — call_scheduling.ts decides WHEN to fire;
 *  this just dispatches. */
export async function fireAiCallDirect(opts: {
  zoho_lead_id: string;
  phone: string;
  customer_name: string;
  project?: string;
  other_projects?: string[];
}): Promise<{ ok: boolean; error?: string; response?: any }> {
  return fireAiCall(opts);
}

async function fireAiCall(opts: {
  zoho_lead_id: string;
  phone: string;
  customer_name: string;
  project?: string;
  other_projects?: string[];
  is_resubmission?: boolean;
  last_page_visited?: string;
  budget?: string;
  size_preference?: string;
  preferred_call_time?: string;
}): Promise<{ ok: boolean; error?: string; response?: any }> {
  const SELF_BASE_URL = process.env.SELF_PUBLIC_URL || "https://growth-relay.asbl.in";

  // ── EXECUTION-TIME SAFETY GUARD (last line of defence) ───────────────────
  // Re-validate from Mongo right before dialing — the cadence's stage stop +
  // primary-caller checks are enforced at SCHEDULING time only, so a stale /
  // re-armed Next_Call_At, a cron pagination race, the self-heal / safety-net
  // reschedule, a retry, or a manual re-fire could otherwise reach this dial.
  // EVERY proactive dial (cron follow-up, self-heal, safety-net, retry, T=0)
  // funnels through fireAiCall, so this one check covers them all:
  //   ISSUE 1 — abort if the lead reached Pre Site Visit / Not Interested /
  //             Spam / any site-visit milestone since it was scheduled.
  //   ISSUE 2 — abort if this record is not the LATEST-born primary caller for
  //             its phone (a sibling project must stay silent).
  // On block we also clear the landmine Next_Call_At (Zoho + Mongo) so no
  // scheduler re-fires this record. Guard failures fail OPEN — the guard must
  // never silence the funnel; the scheduling-time gates remain the first line.
  if (opts.zoho_lead_id) {
    try {
      const { assertProactiveCallAllowed } = await import("./call_guard");
      const guard = await assertProactiveCallAllowed({
        zohoLeadId: opts.zoho_lead_id,
        phone: opts.phone,
      });
      if (!guard.allowed) {
        console.warn(
          `[PRD Orch] AI call ABORTED by dial-time guard (blockedBy=${guard.blockedBy}) — ${guard.reason}`,
        );
        try {
          const [{ updateLead }, { mirrorLeadStateToMongo }] = await Promise.all([
            import("./zoho"),
            import("./supabase"),
          ]);
          await Promise.allSettled([
            updateLead(opts.zoho_lead_id, { Next_Call_At: null }),
            mirrorLeadStateToMongo(opts.zoho_lead_id, { Next_Call_At: null }),
          ]);
        } catch (clearErr: any) {
          console.error(`[PRD Orch] guard Next_Call_At clear failed for ${opts.zoho_lead_id}: ${clearErr.message}`);
        }
        return {
          ok: false,
          error: `dial blocked: ${guard.blockedBy || "guard"}`,
          response: { blocked: true, blocked_by: guard.blockedBy, reason: guard.reason },
        };
      }
    } catch (guardErr: any) {
      // Guard itself threw — fail OPEN so a guard bug never stops all calls.
      console.error(`[PRD Orch] dial-time guard threw (proceeding with call): ${guardErr.message}`);
    }
  }

  const externalScheduleId = `prd-${opts.zoho_lead_id}-${Date.now()}`;
  // Sanitize the name: many leads land with a phone-number-shaped "name"
  // (e.g. "+918xxxxxxxx") and the voice agent otherwise reads the digits out
  // loud as the customer's name. Collapse those to a neutral fallback.
  const safeName = displayName(opts.customer_name, "Sir");
  // Other projects the SAME person enquired about (already masked for LEGACY
  // by the caller). Passed so the voice agent knows this is a multi-project
  // lead and can talk about it.
  const enquiredProjects = (opts.other_projects || []).filter(Boolean);
  const payload: Record<string, any> = {
    _zoho_lead_id: opts.zoho_lead_id,
    phone_number: opts.phone,
    customer_full_name: safeName,
    customer_name: safeName,
    external_schedule_id: externalScheduleId,
    external_customer_id: opts.zoho_lead_id,
    ...(enquiredProjects.length ? { enquired_projects: enquiredProjects } : {}),
    retell_llm_dynamic_variables: {
      customer_name: safeName,
      customer_phone: opts.phone,
      project_name: opts.project || "",
      other_projects: enquiredProjects.join(", "),
      multi_project: enquiredProjects.length ? "true" : "false",
      is_resubmission: opts.is_resubmission ? "true" : "false",
      last_page_visited: opts.last_page_visited || "",
      budget: opts.budget || "",
      size_preference: opts.size_preference || "",
      preferred_call_time: opts.preferred_call_time || "",
    },
  };
  // Timeout the self-HTTP hop to /api/relay/inhouse-call — it re-invokes a
  // serverless fn that then dials the (Render, cold-startable) voice bot. Untimed,
  // it held the ingest request open past the client read timeout. 12s (> the
  // inner voice-bot 8s cap so that fires first). On timeout the abort throws →
  // caught below → ok:false; the cron/retry re-fires the call.
  const relayController = new AbortController();
  const relayTimer = setTimeout(() => relayController.abort(), 12000);
  try {
    const r = await fetch(`${SELF_BASE_URL}/api/relay/inhouse-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: relayController.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`[PRD Orch] AI call relay failed (${r.status}):`, j);
      return { ok: false, error: `relay ${r.status}`, response: j };
    }
    console.log(`[PRD Orch] AI call relay OK (region=${j?.region}, call_id=${j?.call_id || "?"})`);
    return { ok: true, response: j };
  } catch (err: any) {
    console.error(`[PRD Orch] AI call throw: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(relayTimer);
  }
}

// ─── Event entry points ──────────────────────────────────────────────────

export interface OnLeadCreatedInput {
  zoho_lead_id: string;
  phone: string;
  customer_name: string;
  project?: string;
  lead?: any;
  is_resubmission?: boolean;
  last_page_visited?: string;
  budget?: string;
  size_preference?: string;
}

/**
 * T=0 entry — lead just created. Per user override: fire BOTH chatbot
 * message AND AI call simultaneously. Both channels then follow PRD
 * timers independently from here on.
 *
 * Returns Promise that completes once both side effects have been
 * dispatched. The actual responses from Periskope / voice-bot are
 * async — we don't block on them.
 */
export async function handleLeadCreated(input: OnLeadCreatedInput): Promise<{
  state: any;
  chatbot: { ok: boolean; error?: string };
  ai_call: { ok: boolean; error?: string };
}> {
  // MASTER FREEZE — no T=0 fanout (no stage-set, no greeting, no call) during
  // the rebuild. (Ingest handlers also gate earlier; this covers other callers.)
  {
    const { isAutomationFrozen } = await import("./automation_freeze");
    if (await isAutomationFrozen()) {
      return { state: null, chatbot: { ok: false, error: "frozen" }, ai_call: { ok: false, error: "frozen" } };
    }
  }

  // 1. Stage/Status → New Lead / NA
  const state = await onLeadCreated(input.zoho_lead_id, input.lead);

  // ── Per-person de-dup (first-claimer): a phone with N project records must
  //    get only ONE call track. If another record for this phone is already
  //    running an outreach track, THIS new project record is a silent sibling —
  //    skip the T=0 greeting + call. The active record keeps calling; the cron
  //    surfaces this project to the caller as context. Also gather the sibling
  //    projects so — if this DOES fire — the voice agent has the context.
  let siblingProjects: string[] = [];
  try {
    const { fetchLeadRecordsByPhone, isOutreachEligible, hasStartedOutreach, otherProjectsForContext } =
      await import("./primary_lead");
    const records = await fetchLeadRecordsByPhone(input.phone);
    siblingProjects = otherProjectsForContext(records, input.project);
    const siblingActive = records.some((r) =>
      String(r.id) !== String(input.zoho_lead_id) &&
      isOutreachEligible(r) &&
      hasStartedOutreach(r),
    );
    if (siblingActive) {
      console.log(
        `[PRD Orch] T=0 SUPPRESSED — multi-project sibling already active for ` +
        `${input.phone} (lead ${input.zoho_lead_id}); staying silent, primary keeps calling.`,
      );
      return {
        state,
        chatbot: { ok: false, error: "suppressed: multi-project sibling active" },
        ai_call: { ok: false, error: "suppressed: multi-project sibling active" },
      };
    }
  } catch (err: any) {
    console.warn(`[PRD Orch] sibling-check failed (proceeding as primary): ${err.message}`);
  }

  // ── Temporary ops toggles (bot_settings, editable without a deploy) ──
  //   whatsapp_born_paused=true → skip the T=0 WhatsApp greeting entirely
  //                               (proactive stop; reactive replies still run).
  //   calls_delayed_batched=true → don't fire the T=0 call now; instead set
  //                               Next_Call_At = born + delay so the cron fires
  //                               it in throttled batches (see followup.ts).
  let bornPaused = false;
  let delayedBatched = false;
  let firstCallDelayMs = CFG.FIRST_CALL_DELAY_MS;
  try {
    const { getBotSetting } = await import("./bot_settings");
    bornPaused = (await getBotSetting("whatsapp_born_paused"))?.value === "true";
    delayedBatched = (await getBotSetting("calls_delayed_batched"))?.value === "true";
    const delayMin = Number((await getBotSetting("first_call_delay_min"))?.value);
    if (Number.isFinite(delayMin) && delayMin > 0) firstCallDelayMs = delayMin * 60 * 1000;
  } catch (err: any) {
    console.warn(`[PRD Orch] toggle read failed (using defaults): ${err.message}`);
  }

  // 2a. Born WhatsApp greeting — skipped when proactive WhatsApp is paused.
  let chatbot: { ok: boolean; error?: string };
  if (bornPaused) {
    chatbot = { ok: false, error: "skipped: whatsapp_born_paused" };
    console.log(`[PRD Orch] T=0 born WhatsApp SKIPPED (whatsapp_born_paused) for lead ${input.zoho_lead_id}`);
  } else {
    const greeting = buildInitialChatbotGreeting(input);
    chatbot = await fireChatbotMessage(input.phone, greeting, input.project);
    // Bump chatbot counter ONLY if the WhatsApp send actually succeeded (a
    // dead-Periskope failure must not climb the counter toward the cap with
    // zero messages delivered — cron would wrongly think the lead is exhausted).
    if (chatbot.ok) {
      await incrementChatbotAttempt(input.zoho_lead_id, input.lead || {});
    } else {
      console.warn(
        `[PRD Orch] T=0 chatbot send FAILED for lead ${input.zoho_lead_id} ` +
        `(error=${chatbot.error || "unknown"}). Counter NOT bumped — will retry next cron tick.`,
      );
    }
  }

  // 2b. AI call — fire immediately (default) OR defer to born+delay so the
  //     cron picks it up in a throttled batch (calls_delayed_batched mode).
  //     Voice-call scheduling under v3 is owned by the posthook thereafter.
  let ai_call: { ok: boolean; error?: string; response?: any };
  if (delayedBatched) {
    try {
      const dueAt = new Date(Date.now() + firstCallDelayMs);
      const [{ updateLead }, { mirrorLeadStateToMongo }, { zohoIso }] = await Promise.all([
        import("./zoho"),
        import("./supabase"),
        import("./call_scheduling"),
      ]);
      const fields = { Next_Call_At: zohoIso(dueAt) };
      await updateLead(input.zoho_lead_id, fields);
      await mirrorLeadStateToMongo(input.zoho_lead_id, fields);
      ai_call = { ok: true, response: { deferred_until: dueAt.toISOString() } };
      console.log(
        `[PRD Orch] T=0 call DEFERRED to ${dueAt.toISOString()} ` +
        `(calls_delayed_batched) for lead ${input.zoho_lead_id}`,
      );
    } catch (err: any) {
      ai_call = { ok: false, error: `defer-schedule failed: ${err.message}` };
      console.error(`[PRD Orch] T=0 call defer failed for lead ${input.zoho_lead_id}: ${err.message}`);
    }
  } else {
    ai_call = await fireAiCall({
      zoho_lead_id: input.zoho_lead_id,
      phone: input.phone,
      customer_name: input.customer_name,
      project: input.project,
      other_projects: siblingProjects,
      is_resubmission: input.is_resubmission,
      last_page_visited: input.last_page_visited,
      budget: input.budget,
      size_preference: input.size_preference,
    });
  }

  console.log(
    `[PRD Orch] T=0 fanout for lead ${input.zoho_lead_id} — ` +
    `chatbot=${chatbot.ok ? "OK" : (bornPaused ? "SKIP" : "FAIL")} ` +
    `call=${ai_call.ok ? (delayedBatched ? "DEFERRED" : "OK") : "FAIL"}`,
  );
  return { state, chatbot, ai_call };
}

/** Build the initial WhatsApp greeting. Anandita-style, brief. */
function buildInitialChatbotGreeting(input: OnLeadCreatedInput): string {
  const name = (input.customer_name || "").trim() || "Sir/Ma'am";
  const project = displayProject(input.project, "our project");

  const contextBits: string[] = [];
  if (input.budget)          contextBits.push(`budget ${input.budget}`);
  if (input.size_preference) contextBits.push(input.size_preference);
  const enquiry = contextBits.length
    ? `I see you've enquired about ${project} with ${contextBits.join(", ")}.`
    : `I see you've enquired about ${project}.`;

  return (
    `Hi ${name}, this is Anandita from ASBL. ${enquiry}\n\n` +
    `When would be a good time for a quick call to discuss pricing, ` +
    `availability, and offers? Or feel free to reply here with any ` +
    `questions you may have.`
  );
}

/** Customer replied to chatbot → status CF. */
export async function handleChatbotReply(opts: {
  zoho_lead_id: string;
  lead: any;
  customer_message: string;
}): Promise<void> {
  await onChatbotReply(opts.zoho_lead_id, opts.lead, opts.customer_message);
  // Per PRD section 9 global overrides: detect site-visit intent or
  // not-interested intent in the customer's message and override.
  if (detectsSiteVisitIntent(opts.customer_message)) {
    await onSiteVisitBooked(opts.zoho_lead_id, opts.lead);
    return;
  }
  if (detectsNotInterestedIntent(opts.customer_message)) {
    await onNotInterested(opts.zoho_lead_id, opts.lead);
    return;
  }
  // Otherwise: chatbot conversation continues. CF status stays.
  // Bot's LLM (Gemini + Kimi) handles the actual reply via existing
  // periskope-webhook flow — we just track state here.
}

/** Chatbot no-reply window expired → SF, schedule follow-up. */
export async function handleChatbotNoReplyTimer(opts: { zoho_lead_id: string; lead: any }): Promise<void> {
  // If chatbot already exhausted, don't continue
  if (chatbotExhausted(opts.lead)) return;
  await onChatbotNoReply(opts.zoho_lead_id, opts.lead);
  // The follow-up message will be dispatched by the cron processor
  // (Phase 7 wiring) — we just transitioned status here.
}

/** A scheduled chatbot follow-up tick fires → send next message + increment.
 *  COLD-lead path — customer has never replied. Uses the 6-template rotating
 *  bank in buildFollowupMessage. */
export async function handleChatbotFollowupTick(opts: {
  zoho_lead_id: string;
  lead: any;
  phone: string;
  customer_name: string;
  project?: string;
}): Promise<void> {
  if (chatbotExhausted(opts.lead)) return;
  const followupIdx = (opts.lead.Chatbot_Follow_up_Count ?? 0) + 1;
  const msg = buildFollowupMessage(opts.customer_name, opts.project, followupIdx);
  const r = await fireChatbotMessage(opts.phone, msg, opts.project);
  if (r.ok) {
    await incrementChatbotFollowup(opts.zoho_lead_id, opts.lead);
  } else {
    console.warn(
      `[PRD Orch] Cold follow-up send FAILED for lead ${opts.zoho_lead_id} ` +
      `(error=${r.error || "unknown"}). Counter NOT bumped — will retry next cron tick.`,
    );
  }
}

/** GHOST re-engagement tick fires for warm-then-silent leads.
 *  Customer replied at some point but has been silent for >= 25h. Message
 *  references the customer's last reply text (lastInboundText) to feel
 *  contextual rather than generic. Counter shared with the cold follow-up
 *  branch to enforce the same 50-attempt safety cap.
 */
export async function handleChatbotReengagementTick(opts: {
  zoho_lead_id: string;
  lead: any;
  phone: string;
  customer_name: string;
  project?: string;
  hours_since_last_reply: number;
  last_inbound_text?: string;
}): Promise<void> {
  if (chatbotExhausted(opts.lead)) return;
  const followupIdx = (opts.lead.Chatbot_Follow_up_Count ?? 0) + 1;
  const msg = buildReengagementMessage(
    opts.customer_name,
    opts.project,
    opts.hours_since_last_reply,
    followupIdx,
    opts.last_inbound_text || "",
  );
  const r = await fireChatbotMessage(opts.phone, msg, opts.project);
  if (r.ok) {
    await incrementChatbotFollowup(opts.zoho_lead_id, opts.lead);
  }
}

/** Call posthook arrived → route per outcome (PRD sections 8.3 / 8.4). */
export async function handleCallPosthook(opts: {
  zoho_lead_id: string;
  lead: any;
  outcome: CallOutcome;
  details?: { preferredTime?: string; visitDate?: string };
}): Promise<void> {
  await onCallOutcome(opts.zoho_lead_id, opts.lead, opts.outcome, opts.details);
}

// ─── Helper: detect intent from customer message ────────────────────────
// These mirror PRD section 9 global override semantics.

const SITE_VISIT_KEYWORDS = [
  "site visit", "sample flat", "show flat", "visit kar", "visit karna",
  "visit kab", "come and see", "sample dekhna", "model flat", "showroom",
  "office", "experience center", "kab aaye", "aapke paas",
];

const NOT_INTERESTED_KEYWORDS = [
  "not interested", "no interest", "nahi chahiye", "mat bhejo",
  "stop calling", "do not call", "don't call", "remove me", "unsubscribe",
  "stop messaging", "no thank you", "no thanks", "out of budget",
];

export function detectsSiteVisitIntent(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return SITE_VISIT_KEYWORDS.some((k) => m.includes(k));
}

export function detectsNotInterestedIntent(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return NOT_INTERESTED_KEYWORDS.some((k) => m.includes(k));
}

// ─── Templates ──────────────────────────────────────────────────────────

/** COLD follow-up — customer has never replied. Rotating bank of 6
 *  messages covering different angles (brochure, site visit, pricing,
 *  configurations, urgency, soft check-in) so 2-hour cadence doesn't
 *  feel robotic. Index wraps around so attempt #7 = #1 again. */
function buildFollowupMessage(customerName: string, project: string | undefined, idx: number): string {
  const name = (customerName || "").trim() || "Sir/Ma'am";
  const proj = displayProject(project, "ASBL");
  // ENGLISH ONLY — all follow-ups must go in English regardless of customer
  // language (product directive 2026-06-29). Warm, human, no em-dash.
  const messages = [
    // 1: Brochure / pricing offer
    `Hi ${name}, just following up on my earlier message about ${proj}. ` +
    `Would you like me to share the brochure and pricing, or shall I help you schedule a quick site visit?`,
    // 2: Inventory urgency
    `${name}, checking in once more. The popular configurations at ${proj} have limited inventory left. ` +
    `Are you free for a 10-minute call or a site visit this weekend?`,
    // 3: Final-tone gentle
    `Hi ${name}, just one more check-in. We can tailor the ${proj} options to your budget and preferences. ` +
    `Reply here and I'll share the details right away.`,
    // 4: Configuration-focused
    `${name}, are you interested in any particular configuration, size or floor at ${proj}? ` +
    `Let me know and I'll send the matching options with pricing.`,
    // 5: Site visit nudge
    `Hi ${name}, would you consider a quick site visit to ${proj}? Even 30 minutes gives you a full feel of the project. ` +
    `What day works best for you?`,
    // 6: Soft re-engage
    `${name}, a quick update. A few new amenities and payment options at ${proj} have just been confirmed. ` +
    `If you're interested, reply here and I'll share them.`,
  ];
  return messages[(idx - 1) % messages.length];
}

/** GHOST RE-ENGAGEMENT — customer replied earlier but went silent for 24h+.
 *  Context-aware: quotes a short excerpt of the customer's last message so
 *  the re-engagement reads like a continuation, not a cold pitch. Rotating
 *  bank of 4 messages.
 *
 *  lastInboundText is the customer's most recent reply text. If non-empty,
 *  we include a trimmed quote in the message. Empty → fallback to a generic
 *  "our last conversation" phrasing. All output is ENGLISH only. */
export function buildReengagementMessage(
  customerName: string,
  project: string | undefined,
  hoursSinceLastReply: number,
  idx: number,
  lastInboundText: string = "",
): string {
  const name = (customerName || "").trim() || "Sir/Ma'am";
  const proj = displayProject(project, "ASBL");

  // Build a context phrase quoting the customer's last message. Trim to
  // a short readable excerpt + strip media placeholders + escape WhatsApp
  // formatting that would otherwise mess up the rendered quote.
  const cleaned = (lastInboundText || "")
    .replace(/\s+/g, " ")
    .replace(/[*_~`]/g, "")
    .trim();
  const excerpt = cleaned.length > 80 ? cleaned.slice(0, 77) + "..." : cleaned;
  // ENGLISH ONLY — all follow-ups go in English regardless of the customer's
  // language (product directive 2026-06-29).
  const ctxPhrase = excerpt
    ? `you'd written earlier: "${excerpt}".`
    : `our last conversation was about ${proj}.`;

  const messages = [
    // 1: Quote + soft remind
    `Hi ${name}, ${ctxPhrase} I wanted to follow up on that. Is there a specific question that's still unanswered?`,

    // 2: Quote + offer next step
    `${name}, ${ctxPhrase} Would you like to see the updated pricing and availability for ${proj}? ` +
    `I can share it in 5 minutes.`,

    // 3: Quote + soft site-visit nudge
    `Hi ${name}, ${ctxPhrase} Would a quick 30-minute site visit work for you at your convenience? ` +
    `It gives you a complete feel of the project and a lot of clarity.`,

    // 4: Quote + direct ask
    `${name}, ${ctxPhrase} Let me know if anything is holding you back, whether it's pricing, configuration or documentation. ` +
    `I'll get it sorted for you.`,
  ];
  return messages[(idx - 1) % messages.length];
}

// Re-export key state-machine helpers so callers can import everything
// from prd_orchestrator if they prefer a single import.
export {
  onLeadCreated,
  onChatbotReply,
  onSiteVisitBooked,
  onNotInterested,
  onCallOutcome,
  onPreSiteVisitSsExhausted,
};
