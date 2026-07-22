/**
 * Resubmission tracking — fires whenever an existing Zoho lead re-submits a
 * form (Website Inquiry / FIM / Channel Partner). Three side-effects:
 *
 *   1. Zoho fields stamped:
 *        - Resubmission_Count       : integer, incremented
 *        - Resubmission_History     : textarea, new entry prepended
 *        - Last_Resubmission_At     : datetime (now)
 *        - Last_Resubmission_Source : picklist/text (Website / FIM / etc.)
 *
 *      The History textarea holds one human-readable line per resubmission
 *      with timestamp + source + brief context (last page, time on site,
 *      campaign). Sales clicks the field in CRM and sees the full audit
 *      trail of every resubmission (closest we can get to a Zoho-native
 *      "popup" without writing a Deluge custom button).
 *
 *   2. WhatsApp message via Periskope — context-aware (greets by name, calls
 *      out the project they were browsing, the time they spent, the budget /
 *      size they asked about). Fired immediately, fire-and-forget so ingest
 *      never blocks on it.
 *
 *   3. Outbound voice call via in-house ASBL Voice Bot (Anandita) — same
 *      relay our Deluge function uses, with rich metadata so the bot's LLM
 *      session knows it's a resubmission, what number resubmission this is,
 *      and what context the user gave on this submission. Fire-and-forget.
 *
 * Both side-effects are best-effort — failures are logged but don't bubble
 * up to ingest (we never want a WhatsApp/Plivo glitch to break form intake).
 */
import { NormalizedLead } from "./types";
import { updateLead } from "./zoho";
import { displayProject } from "./project_detection";

const PERISKOPE_API_KEY = process.env.PERISKOPE_API_KEY || "";
const PERISKOPE_API_URL = "https://api.periskope.app/v1/messages/send";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

/** Cooldown between outreach attempts. If the same lead resubmits more than
 *  once inside this window we still increment the Count and append the
 *  History line (so the audit trail is complete), but we suppress the
 *  WhatsApp + voice call so sales doesn't spam them on a double-click submit
 *  or rapid form re-fill across pages. */
const OUTREACH_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// Self-deploy URL — used so we can call our own /api/relay/inhouse-call
// from server-side (avoids re-implementing the country-routing here).
// IMPORTANT: must be the PUBLIC alias, NOT VERCEL_URL — the deployment-
// specific URL (asbl-crm-api-<hash>.vercel.app) has Vercel deployment
// protection enabled and returns 401 to unauthenticated internal calls,
// breaking the resubmission outreach. The public alias is stable across
// deploys and isn't gated by deployment protection.
const SELF_BASE_URL = process.env.SELF_PUBLIC_URL || "https://asbl-crm-api.vercel.app";

// Same 10-sender pool as api/relay/periskope.ts — kept in sync so a returning
// lead gets paired with the same RM-pool variety they saw on first contact.
const SENDER_NUMBERS = [
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** IST timestamp for the History line — what sales reads in Zoho. */
function nowIst(): string {
  // Format: "2026-05-05 14:23:12 IST"
  const d = new Date();
  const ist = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
  const yyyy = ist.getUTCFullYear();
  const mm   = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(ist.getUTCDate()).padStart(2, "0");
  const HH   = String(ist.getUTCHours()).padStart(2, "0");
  const MI   = String(ist.getUTCMinutes()).padStart(2, "0");
  const SS   = String(ist.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${HH}:${MI}:${SS} IST`;
}

/** Zoho datetime format (ISO with timezone offset, no millis). */
function nowZohoIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** Phone-sticky sender pick (Phase 8: Mongo whatsapp_sender_map).
 *  Mirrors prd_orchestrator.pickSender — if the phone is already mapped
 *  to a sender (initial greeting or any prior outbound), reuse it. Only
 *  call the round-robin counter for truly new phones. Otherwise the
 *  resubmission path silently rotates senders across multiple form-fills
 *  by the same person and the customer sees messages from 2-3 different
 *  numbers (bug observed 2026-06-18). */
async function pickSender(phone: string): Promise<string> {
  try {
    const { getSenderForPhone, getNextSenderIndex } = await import("./ops_collections");
    const existing = await getSenderForPhone(phone);
    if (existing) return existing;
    const idx = await getNextSenderIndex(SENDER_NUMBERS.length);
    return SENDER_NUMBERS[idx] || SENDER_NUMBERS[0];
  } catch {
    return SENDER_NUMBERS[Math.floor(Math.random() * SENDER_NUMBERS.length)];
  }
}

/** Pick the first non-empty value (handy for falling back across naming). */
function firstName(lead: NormalizedLead): string {
  const fn = (lead.first_name || "").trim();
  if (fn && fn !== ".") return fn;
  return "there";
}

/** Build a brief context line for the History entry — kept on one line so
 *  Zoho's textarea stays readable when sales scrolls through 5–10 lines. */
function buildContextLine(lead: NormalizedLead): string {
  const bits: string[] = [];
  if (lead.project)              bits.push(`project=${lead.project}`);
  if (lead.budget)               bits.push(`budget=${lead.budget}`);
  if (lead.size_preference)      bits.push(`size=${lead.size_preference}`);
  if (lead.campaign_name)        bits.push(`campaign=${lead.campaign_name}`);
  if (typeof lead.total_page_views === "number" && lead.total_page_views > 0)
    bits.push(`pages=${lead.total_page_views}`);
  if (typeof lead.time_spent_minutes === "number" && lead.time_spent_minutes > 0)
    bits.push(`time=${lead.time_spent_minutes}m`);
  if (lead.last_page_visited)    bits.push(`last=${shortPath(lead.last_page_visited)}`);
  return bits.length ? bits.join(", ") : "no extra context";
}

/** Trim a URL down to its path so the History line stays compact. */
function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname || u.toString();
  } catch {
    return url.slice(0, 60);
  }
}

/** Cap the history textarea so we don't blow Zoho's textarea limit
 *  (32000 chars — Zoho textarea tiers are 2000/32000/50000) over years of
 *  resubmissions. Keep the latest ~200 lines. */
function appendHistory(prev: string, line: string): string {
  const next = `${line}\n${prev || ""}`.trim();
  if (next.length <= 30000) return next;
  // Keep newest first, trim oldest
  const lines = next.split("\n");
  return lines.slice(0, 200).join("\n");
}

/** Build the WhatsApp body — short, contextual, doesn't re-introduce
 *  Anandita (we assume the lead has had at least one prior touch). */
function buildWhatsAppMessage(lead: NormalizedLead, count: number): string {
  const name = firstName(lead);
  // Never leak the new-launch codename (LEGACY) — reads as "our new launch project".
  const project = displayProject(lead.project, "our projects");

  const contextBits: string[] = [];
  if (typeof lead.time_spent_minutes === "number" && lead.time_spent_minutes >= 1) {
    contextBits.push(`spent ${lead.time_spent_minutes} minutes on our site`);
  }
  if (typeof lead.total_page_views === "number" && lead.total_page_views >= 2) {
    contextBits.push(`viewed ${lead.total_page_views} pages`);
  }
  if (lead.last_page_visited) {
    contextBits.push(`looking at ${shortPath(lead.last_page_visited)}`);
  }

  const ordinal = count === 1 ? "again" : `${count} times now`;
  const contextSentence = contextBits.length
    ? ` I noticed you ${contextBits.join(", ")}.`
    : "";

  let askLine = "Could I share the latest pricing and availability with you, or would a quick call work better?";
  if (lead.budget && lead.size_preference) {
    askLine = `Want me to share ${lead.size_preference} options in ${project} within ${lead.budget}? Or shall I call you in a few minutes to walk through it?`;
  } else if (lead.size_preference) {
    askLine = `Want me to share ${lead.size_preference} options in ${project}? Or shall I call you in a few minutes to walk through it?`;
  } else if (lead.budget) {
    askLine = `Want me to share ${project} options within ${lead.budget}? Or shall I call you in a few minutes to walk through it?`;
  }

  return (
    `Hi ${name}, this is Anandita from ASBL. I see you've enquired about ${project} ${ordinal}.${contextSentence}\n\n` +
    askLine
  );
}

/** Save outbound WhatsApp message to Mongo chat history (so the LLM can
 *  see this in context when the lead replies). Best-effort — never throws.
 *  (Phase 4: migrated from Supabase to Mongo.) */
async function saveWhatsAppMessage(phone: string, message: string, sender: string): Promise<void> {
  try {
    const { insertMessage } = await import("./whatsapp_messages");
    await insertMessage({
      phone, direction: "outbound", message, sender,
      project: null, intent: null,
      created_at: new Date().toISOString(),
    });
  } catch {}
}

/** Store sender mapping so future inbound replies route to the same RM
 *  number — same pattern as api/relay/periskope.ts. */
async function storeSenderMapping(phone: string, sender: string): Promise<void> {
  try {
    // Phase 8: Mongo
    const { setSenderForPhone } = await import("./ops_collections");
    await setSenderForPhone(phone, sender);
  } catch {}
}

// ─── Side-effect 2: WhatsApp via Periskope ──────────────────────────────────

function isDeadSenderResponse(status: number, body: string): boolean {
  const b = body.toLowerCase();
  if (b.includes("phone server") && b.includes("switched off")) return true;
  if (b.includes("/phone/restart")) return true;
  if (b.includes("unauthorized_error")) return true;
  if (status === 401) return true;
  return false;
}

async function fireWhatsApp(lead: NormalizedLead, count: number): Promise<void> {
  if (!PERISKOPE_API_KEY) {
    console.warn("[Resubmission] PERISKOPE_API_KEY missing — skipping WhatsApp");
    return;
  }
  const phone = lead.mobile.replace(/^\+/, "");
  // Capture prior sticky BEFORE pickSender (which would round-robin if none).
  // This lets us tell "first send for this phone" vs "sticky existed".
  const { markSenderDead, getDeadSenders, getSenderForPhone } = await import("./ops_collections");
  const priorSticky = await getSenderForPhone(phone);
  const startingSender = await pickSender(phone);
  const message = buildWhatsAppMessage(lead, count);

  // Build send order: sticky-picked first, then everything else in the pool,
  // skipping recently-dead senders. Falls through pool-wide on 401 / "phone
  // server switched off" so a single dead sender doesn't block the send.
  const deadSet = await getDeadSenders().catch(() => new Set<string>());
  const ordered: string[] = [];
  if (!deadSet.has(startingSender)) ordered.push(startingSender);
  for (const s of SENDER_NUMBERS) {
    if (s === startingSender) continue;
    if (deadSet.has(s)) continue;
    ordered.push(s);
  }
  if (!ordered.length) ordered.push(...SENDER_NUMBERS);

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
        // Sticky update policy: only promote if no prior sticky OR we used
        // the existing sticky. Don't replace sticky with a temporary
        // substitute when the original is dead — customer should return
        // to the original sender once ops restarts it.
        const isFirstStick = !priorSticky;
        const usedSticky = priorSticky === sender;
        const writes: Promise<any>[] = [saveWhatsAppMessage(phone, message, sender)];
        if (isFirstStick || usedSticky) {
          writes.push(storeSenderMapping(phone, sender));
        }
        await Promise.all(writes);
        console.log(
          `[Resubmission] WhatsApp sent to ${phone} via ${sender} (count=${count})` +
          (tried > 1 ? ` after ${tried - 1} dead-sender fallback${tried > 2 ? "s" : ""}` : "") +
          ` sticky=${priorSticky || sender}`,
        );
        return;
      }
      const txt = (await r.text()).slice(0, 200);
      lastErr = `${r.status}:${txt}`;
      if (isDeadSenderResponse(r.status, txt)) {
        console.warn(`[Resubmission] Sender ${sender} dead (${r.status}) — marking + trying next`);
        await markSenderDead(sender).catch(() => {});
        continue;
      }
      // Non-sender 4xx (bad recipient / blocked etc.) — won't be fixed by another sender.
      console.error(`[Resubmission] WhatsApp send failed via ${sender} (${r.status}): ${txt}`);
      return;
    } catch (err: any) {
      lastErr = err.message;
      console.warn(`[Resubmission] Sender ${sender} threw — trying next: ${err.message}`);
      continue;
    }
  }
  console.error(`[Resubmission] WhatsApp EXHAUSTED — all ${tried} senders failed for ${phone}. Last: ${lastErr}`);
}

// ─── Side-effect 3: Outbound voice call via in-house bot ────────────────────

async function fireVoiceCall(
  lead: NormalizedLead,
  zohoLeadId: string,
  mlid: string,
  plid: string,
  count: number,
): Promise<void> {
  // Only India numbers go to the in-house bot today (US still on Arrowhead).
  // The relay handles country routing itself, but we short-circuit non-IN
  // here too so we don't fire Arrowhead campaigns on every resubmission.
  const phone = lead.mobile.startsWith("+") ? lead.mobile : `+${lead.mobile.replace(/\D/g, "")}`;
  if (!phone.startsWith("+91")) {
    console.log(`[Resubmission] Skipping voice call — non-IN number ${phone}`);
    return;
  }

  const customerName = [lead.first_name, lead.last_name]
    .filter((s) => s && s !== ".")
    .join(" ")
    .trim() || "";

  // External_schedule_id used by /api/relay/inhouse-posthook to correlate
  // the call back to this lead. Suffix with timestamp so a re-resubmission
  // a few minutes later doesn't collide.
  const externalScheduleId = `resub-${zohoLeadId}-${Date.now()}`;

  const payload: Record<string, any> = {
    _zoho_lead_id: zohoLeadId,
    phone_number: phone,
    customer_full_name: customerName,
    customer_name: customerName,
    external_schedule_id: externalScheduleId,
    external_customer_id: mlid,
    retell_llm_dynamic_variables: {
      customer_name: customerName,
      customer_phone: phone,
      project_name: lead.project || "",
      plid,
      mlid,
      // Resubmission-specific context so the bot's LLM session can open
      // with "I see you visited again …" instead of a cold greeting.
      is_resubmission: "true",
      resubmission_count: String(count),
      resubmission_source: lead.lead_source,
      last_page_visited: lead.last_page_visited || "",
      time_spent_minutes: String(lead.time_spent_minutes ?? ""),
      total_page_views: String(lead.total_page_views ?? ""),
      budget: lead.budget || "",
      size_preference: lead.size_preference || "",
    },
  };

  try {
    const r = await fetch(`${SELF_BASE_URL}/api/relay/inhouse-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 300);
      console.error(`[Resubmission] inhouse-call relay failed (${r.status}): ${txt}`);
      return;
    }
    const j = await r.json().catch(() => ({}));
    console.log(`[Resubmission] Voice call triggered for ${phone} → call_id=${j?.call_id || "(none)"} count=${count}`);
  } catch (err: any) {
    console.error(`[Resubmission] inhouse-call throw: ${err.message}`);
  }
}

// ─── Main entry — called from ingest.ts on every resubmission ───────────────

export interface RecordResubmissionInput {
  lead: NormalizedLead;
  zohoLeadId: string;
  mlid: string;
  plid: string;
  /** Existing lead record from Zoho (already-fetched via findLeadByPhone*).
   *  Should contain prior Resubmission_Count + Resubmission_History so we
   *  increment + prepend correctly. Missing = treat as 0. */
  existingLead: any;
}

export interface RecordResubmissionResult {
  count: number;
  source: string;
  history_line: string;
  /** True when WhatsApp + call were skipped because we're inside the
   *  per-lead outreach cooldown. Audit fields were still updated. */
  outreach_suppressed: boolean;
  /** Minutes until cooldown expires (0 if outreach actually fired). */
  cooldown_remaining_minutes: number;
}

/**
 * Records a resubmission on the Zoho lead and fires WhatsApp + voice call
 * outreach. Called once per ingest where existingLead was found.
 *
 * Returns the new count + the history line we wrote (for ingest's response
 * payload — useful when debugging why the dashboard shows N resubmissions).
 *
 * The Zoho update + outreach are interleaved:
 *   - Zoho update is awaited (fast, and we want the fields stamped before
 *     anyone looks at the lead).
 *   - WhatsApp + voice call are fired-and-forgotten via setImmediate so
 *     ingest's HTTP response goes back to the form fast.
 *
 * Note: in Vercel serverless, fire-and-forget can be killed when the
 * handler returns. Ingest's caller (api/ingest/website.ts etc.) should
 * `await` the returned promise of `triggerOutreachAsync` if they want to
 * guarantee both went out — but for typical website forms, the user has
 * already navigated away by the time we'd return, so the risk is moot.
 */
export async function recordResubmission(
  input: RecordResubmissionInput,
): Promise<RecordResubmissionResult> {
  const { lead, zohoLeadId, existingLead } = input;

  const prevCount = Number(existingLead?.Resubmission_Count ?? 0) || 0;
  const newCount = prevCount + 1;
  const source = lead.lead_source;

  // ── Cooldown check ──
  // We suppress WhatsApp + call when the lead resubmitted within the last
  // OUTREACH_COOLDOWN_MS. Common case: user double-clicks "Submit" or fills
  // a different form on the same site within minutes — sales shouldn't get
  // 3 calls in 5 minutes for what's essentially one buying intent.
  let outreachSuppressed = false;
  let cooldownRemainingMinutes = 0;
  const prevAtRaw = existingLead?.Last_Resubmission_At;
  if (prevAtRaw) {
    const prevMs = new Date(prevAtRaw).getTime();
    if (Number.isFinite(prevMs)) {
      const elapsed = Date.now() - prevMs;
      if (elapsed >= 0 && elapsed < OUTREACH_COOLDOWN_MS) {
        outreachSuppressed = true;
        cooldownRemainingMinutes = Math.ceil((OUTREACH_COOLDOWN_MS - elapsed) / 60000);
      }
    }
  }

  // History line — always written, with a (suppressed) tag when outreach
  // was skipped so sales reading the History textarea sees exactly when
  // we sat one out.
  const tag = outreachSuppressed ? " (outreach suppressed — within cooldown)" : "";
  const historyLine = `[${nowIst()}] ${source} — ${buildContextLine(lead)}${tag}`;
  const prevHistory: string = String(existingLead?.Resubmission_History ?? "");
  const newHistory = appendHistory(prevHistory, historyLine);

  // ── Zoho stamping (awaited) ──
  // We always update Last_Resubmission_At even on suppressed events so the
  // cooldown window slides — that way 3 rapid resubmits in a row still
  // result in just one outreach (instead of one per cooldown-window
  // boundary if we kept Last_Resubmission_At anchored to the first event).
  try {
    await updateLead(zohoLeadId, {
      Resubmission_Count: newCount,
      Resubmission_History: newHistory,
      Last_Resubmission_At: nowZohoIso(),
      Last_Resubmission_Source: source,
    });
    console.log(
      `[Resubmission] Lead ${zohoLeadId} stamped — count=${newCount} source=${source}` +
      (outreachSuppressed
        ? ` (outreach SUPPRESSED — cooldown ${cooldownRemainingMinutes}m left)`
        : ` (outreach firing)`),
    );
  } catch (err: any) {
    // Field-may-not-exist-yet (404 INVALID_DATA) is expected the first time
    // before zoho-create-resubmission-fields is hit. Warn but don't throw —
    // the WhatsApp + call should still fire so sales gets the touchpoint
    // even if the audit trail is missing for this submission.
    console.error(`[Resubmission] Zoho stamping failed: ${err.message}`);
  }

  // ── Side-effects (fire-and-forget; ingest doesn't wait) ──
  if (outreachSuppressed) {
    console.log(
      `[Resubmission] Skipping WhatsApp + call for lead ${zohoLeadId} ` +
      `(last resubmit ${cooldownRemainingMinutes}m ago, cooldown=${OUTREACH_COOLDOWN_MS / 60000}m)`,
    );
  } else {
    Promise.allSettled([
      fireWhatsApp(lead, newCount),
      fireVoiceCall(lead, zohoLeadId, input.mlid, input.plid, newCount),
    ]).then((results) => {
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length) {
        console.error(`[Resubmission] ${failed.length} side-effect(s) failed`);
      }
    });
  }

  return {
    count: newCount,
    source,
    history_line: historyLine,
    outreach_suppressed: outreachSuppressed,
    cooldown_remaining_minutes: cooldownRemainingMinutes,
  };
}
