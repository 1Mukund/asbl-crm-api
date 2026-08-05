# CODE_KNOWLEDGE.md

Module-by-module knowledge map of the `asbl-crm-api` automation (Vercel serverless TypeScript under `api/`). Written from the actual code, not the marketing docs. For each area: what it does, the step-by-step flow, and the invariants/gotchas that bite.

> **Ground truth counts (2026-07):** There are **15** function files under `api/` (not the 12 CLAUDE.md claims — the extra ones are legacy `arrowhead.ts`, `arrowhead-posthook.ts`, `lazybot-webhook.ts`, `inncircles.ts`). Anything in `api/_utils/` is a shared helper and does **not** count as a Vercel function.
>
> **Active Vercel crons (`vercel.json`)** — all five point at `api/cron/followup.ts` with a `?task=` query param:
> | task | schedule (UTC) |
> |------|----------------|
> | `meta-backfill` | `*/15 * * * *` |
> | `prd-cadence` | `*/15 * * * *` |
> | `mark-unique-leads` | `7 22 * * *` |
> | `pre-site-visit-reminders` | `23 * * * *` |
> | `mongo-sync` | `*/15 * * * *` |
>
> Three more tasks exist in `followup.ts` but are **not scheduled** — they're one-shot/manual: `dedup-call-primaries`, `backfill-presite-stage`, `reconcile-stage-from-status`.

---

## 0. The two source-of-truth systems

- **Zoho CRM** (`zohoapis.in`, Indian region) is the **automation brain + source of truth** for lead lifecycle state. Every stage/counter/call field lives on the Zoho Lead record.
- **MongoDB** ("Zoho_Database" db on a self-hosted EC2 host, `api/_utils/mongo.ts`) is a **read-side mirror + ops store**. It holds a copy of every lead (`leads` collection) for the in-house CRM, plus all operational collections (bot settings, WhatsApp history, sender maps, dedupe keys, cron logs, site-visit bookings, etc).
- The bridge between them is **`mirrorLeadStateToMongo()`** in `api/_utils/supabase.ts` (the file is named `supabase.ts` for import-compat but is 100% Mongo now). Every Zoho `updateLead()` in the lifecycle is followed by a mirror call so Mongo stays current. See §12.

---

## 1. Lead ingest flow

**Files:** `api/_utils/ingest.ts` (`ingestLead`), `api/ingest/{website,meta,fim,inncircles}.ts`, `api/normalize-zoho-lead.ts`, `api/_utils/supabase.ts` (MLID/PLID + claim), `api/_utils/normalize.ts`, `api/_utils/zoho.ts`.

### What it does
Turns an inbound lead (Meta Lead Ads, website form, FIM landing page, Inncircles, or Zoho-Deluge/LeadChain) into a deduped Zoho Lead + a mirrored Mongo `leads` doc, then fires the T=0 outreach fan-out.

### Flow (`ingestLead(lead: NormalizedLead)`)
1. **MLID** = `getOrCreateMLID(phone)` — one Master Lead ID per phone (atomic Mongo counter, `_counters.mlid`).
2. **PLID** = `getOrCreatePLID(phone, mlid, project)` — one Project Lead ID per (phone, project); `plid = "${mlid}-${project}"`.
3. Build the full Zoho payload (`First_Name`, `Mobile`, attribution UTMs, `Master_Lead_ID`, `Project_Lead_ID`, `ASBL_Project`, `Born_Date`, and — only when the caller supplied one — `Inncircles_Born_Date`).
4. **Atomic dedupe claim** = `claimLeadCreation(plid, phone, mlid)`:
   - Does a Mongo `findOneAndUpdate` upsert on `leads._id = plid` with `returnDocument: "before"`. `before === null` ⟹ **we inserted first** ⟹ `status:"first"` ⟹ we call Zoho `createLead`. `before` non-null with a `zoho_lead_id` ⟹ `status:"duplicate"` ⟹ reuse that ID (no second Zoho create). `before` non-null but no ID yet ⟹ poll up to 6s, then `duplicate_pending`.
   - This is the fix for the historical race where two concurrent submissions for the same (phone, project) created **two** Zoho leads (Zoho's search API lags 3–7s).
5. If an existing lead is found → `updateLead` (stripping `Born_Date`/`Inncircles_Born_Date` so resubmits never overwrite the original born date) → `action:"updated"` → `recordResubmission()` (bumps `Resubmission_Count`, fires WhatsApp+call subject to a 30-min cooldown). Else `createLead` → `action:"created"` (and re-PATCH `Born_Date` separately because Zoho sometimes drops custom fields on POST).
6. `upsertLead()` writes the full lead snapshot into Mongo `leads` (keyed by plid).

### T=0 fan-out trigger
The ingest endpoints — **not** `ingestLead` itself — call `handleLeadCreated()` **only when `result.action === "created"`**:
- `api/ingest/website.ts:92`, `api/ingest/meta.ts:176`, `api/ingest/fim.ts:110`, `api/ingest/inncircles.ts:239`.
- **MUST be `await`ed** (all of them are) — a fire-and-forget here gets killed on Vercel's 200 return.

### Gotchas
- **`api/normalize-zoho-lead.ts` does NOT fire T=0** anymore (disabled 2026-05-28). Zoho Deluge calls this endpoint on lead **updates** too, so firing T=0 here caused 4–5× WhatsApp spam per lead. It now only normalises + syncs Mongo. If you ever re-enable, gate on a strict `findLeadByPLID == null` first-time check.
- Website/FIM leads were historically skipped for T=0 (only meta was wired) → silent "no greeting / no call / cron skips them (PRD_Stage null)". Fixed by wiring all four ingest endpoints.
- Meta has a **backfill safety-net cron** (`?task=meta-backfill`, every 15 min) that polls the Graph API directly per form (`META_BACKFILL_FORM_IDS`) over a 2-hour lookback and re-runs `ingestLead` — idempotent because dedupe only bumps the resubmission counter.

---

## 2. PRD orchestrator — T=0 fan-out + outbound helpers

**File:** `api/_utils/prd_orchestrator.ts`.

### `handleLeadCreated(input)` — the T=0 entry point
Per product override: at lead-create, fire **both** the chatbot WhatsApp greeting **and** the AI call **simultaneously**; the two channels then run independent timers.

Steps:
1. `onLeadCreated()` → sets `PRD_Stage="New Lead" / PRD_Status="NA"` (via the state machine, §3).
2. **Per-person de-dup (first-claimer):** `fetchLeadRecordsByPhone()` (Mongo-first, Zoho fallback). If any **sibling** record for the same phone is already `isOutreachEligible && hasStartedOutreach`, this new project record is a **silent sibling** — return early, skip greeting + call. The active record keeps calling; this project is surfaced to the voice agent as context.
3. Read temporary ops toggles from `bot_settings`: `whatsapp_born_paused`, `calls_delayed_batched`, `first_call_delay_min`.
4. **2a. Born WhatsApp greeting** (`buildInitialChatbotGreeting`) via `fireChatbotMessage`. Increments `Chatbot_Attempt_Count` **only if the send succeeded** (a dead-Periskope failure must not climb the cap with zero delivered messages).
5. **2b. AI call:** default = fire immediately via `fireAiCall` → `POST /api/relay/inhouse-call`. If `calls_delayed_batched="true"`, do **not** call now — instead set `Next_Call_At = born + first_call_delay` so the cron fires it in throttled batches.

### `fireChatbotMessage(phone, message, project)` — the sender-pool sender
- Builds a send order: sticky sender first (if alive), then the rest of the 10-number `SENDER_POOL`, skipping any in the 1-hour dead-sender TTL set.
- On success: `recordSenderSuccess`, save to `whatsapp_messages`, and set/keep sticky (**never** promote a fallback substitute over the original sticky — so a customer returns to their original number after ops restarts it).
- On a **dead-sender** response (401 / "phone server switched off" / "/phone/restart") → `markSenderDead`, try next. On a non-sender 4xx (bad payload / customer blocked) → stop, return `{ok:false}`.
- If **all** senders fail → write a `stuck_sends` Mongo doc for the dashboard banner. Returns `{ok:false}`.

### `fireAiCall / fireAiCallDirect`
Builds the voice-bot payload (`_zoho_lead_id`, sanitized `customer_full_name` via `displayName`, `external_schedule_id = "prd-<leadId>-<ts>"`, `enquired_projects` for multi-project, `retell_llm_dynamic_variables`) and POSTs to `/api/relay/inhouse-call`. `fireAiCallDirect` is the public alias the cron uses. **Returns `{ok:false}` on relay failure — it does NOT throw** (important for the cron's batch-quota accounting).

### Follow-up ticks (called by the cron)
- `handleChatbotFollowupTick` — **COLD** branch (never replied). Uses `buildFollowupMessage` (6 rotating English templates). Increments `Chatbot_Follow_up_Count` only on successful send.
- `handleChatbotReengagementTick` — **GHOST** branch (replied, then went silent). `buildReengagementMessage` quotes an excerpt of the customer's last inbound so it reads contextual. Shares the same follow-up counter/cap.

### `handleCallPosthook` / `handleChatbotReply`
- `handleChatbotReply` → `onChatbotReply` (status CF) **plus** keyword-based global overrides: `detectsSiteVisitIntent` → `onSiteVisitBooked`; `detectsNotInterestedIntent` → `onNotInterested`.
- `handleCallPosthook` → `onCallOutcome` (routes call outcome to the right stage/status; call answers **never** set CF).

### Gotchas
- All follow-up templates are **English only** (product directive 2026-06-29), regardless of customer language. Reactive replies (§10) still language-match.
- `SENDER_POOL` is 10 hardcoded numbers here **and** duplicated in `api/cron/followup.ts`'s legacy path — keep in sync if you rotate numbers.

---

## 3. PRD state machine — Lead_Status ↔ PRD_Stage

**File:** `api/_utils/prd_state_machine.ts`.

### Vocabulary
- **Stages** (clean 4-value): `New Lead`, `Lead Initiated`, `Pre Site Visit`, `Not Interested`. (`Spam` is used as an extra terminal value from the mapper.)
- **Statuses:** `NA`, `CF`, `SF`, `CS`, `SS`. **Hard rule:** `CF` is set **only** by a chatbot reply — a call answer never sets CF.

### `transitionStage(input)` — the single entry point for every stage change
1. **Milestone protection:** if the lead's current `PRD_Stage` is a site-visit milestone (`isSiteVisitMilestone`) and the target isn't, the move is **blocked** — the milestone value is preserved (audit still recorded). So a later "busy"/"not interested" follow-up call cannot erase a booked site visit.
2. Status validity check per `VALID_STATUS_PER_STAGE` (skipped for `Not Interested`, which is terminal). `Pre Site Visit` allows only `NA/SF/SS`.
3. Writes `PRD_Stage`, `PRD_Status`, `PRD_Last_Action_Time` + any `extraFields` via **`updateLead` then `mirrorLeadStateToMongo`** (both awaited).

### `mapLeadStatusToStage(leadStatus)` — the reconcile mapping
Zoho's `Lead_Status` (sales-editable, blueprint-driven, messy vocabulary: `Fresh`/`First Touch`/`Pre Site`/`Virtual Tour`/`Post Site Visit`/…) is authoritative for **where** a lead is. This maps it onto the clean PRD vocab (regex, terminal buckets checked first):
- `pre site | post site | site visit | virtual tour` → `Pre Site Visit`
- `not interested | not qualif | disqualif | lost | junk | dead` → `Not Interested`
- `spam` → `Spam`
- `contacted | lead initiated | attempt | pre-qualif | in future` → `Lead Initiated`
- `fresh | first touch | ^new | not contacted` → `New Lead`
- else → `null` (leave `PRD_Stage` untouched)

The cron applies this **stickily** — `isSiteVisitMilestone`/`Not Interested` never downgrade.

### Convenience transitions
`onLeadCreated` (New Lead/NA), `onChatbotReply` (→CF), `onChatbotNoReply` (→SF), `onPreferredTimeGiven` (Lead Initiated/CS), `onIntentNoTime` (Lead Initiated/SS + Intent_Captured), `onSiteVisitBooked` (Pre Site Visit/NA + Site_Visit_Date), `onNotInterested` (terminal + Not_Interested_Reason), `onCallOutcome` (switch over the 5 `CallOutcome` values), `onSsTreeExhausted` / `onPreSiteVisitSsExhausted` (terminal with specific reasons).

### Gotchas
- **`PRD_Stage` is the ONE field the whole cadence gates on.** It's kept accurate from two sides: the posthook writes it on every call outcome, and the cron reconciles it from `Lead_Status` each tick. This single-source-of-truth design is what prevents extra-call/extra-follow-up leakage.
- `isTerminalLeadStatus` is a looser matcher (adds `won|booked|customer|closed`) used for "should the cadence stop" checks — different from `mapLeadStatusToStage`.

---

## 4. PRD cadence config + chatbot counters

**File:** `api/_utils/prd_cadence.ts`.

Holds the `CFG` constants and the counter-increment helpers. Voice-call cadence is **not** here anymore (moved to `call_scheduling.ts`, 2026-06-18) — this file now owns only chatbot state.

Key `CFG` values:
- `CHATBOT_FOLLOWUP_MAX_ATTEMPTS = 80` (hard safety cap; `chatbotExhausted()` checks `Chatbot_Follow_up_Count >= 80`).
- **COLD:** `COLD_FOLLOWUP_INTERVAL_MS = 7h`, `COLD_FOLLOWUP_WINDOW_MS = 30 days` (bumped 15→30 on 2026-06-29 — the silence-stop in the cron keys off this same constant, so both move together), hours `[7, 21)` customer-local.
- **GHOST:** `GHOST_INITIAL_DELAY_MS = 25h`, `GHOST_INTERVAL_MS = 24h`, `GHOST_WINDOW_MS = 7 days`.
- **Batched first-call:** `FIRST_CALL_DELAY_MS = 30min`, `FIRST_CALL_BATCH_SIZE = 15` (both overridable via `bot_settings`).

Counter helpers `incrementChatbotAttempt` / `incrementChatbotFollowup` both write Zoho **and** mirror to Mongo, and stamp `PRD_Last_Action="Chatbot"` + `PRD_Last_Action_Time`.

---

## 5. Call scheduling (slot logic + timezone)

**File:** `api/_utils/call_scheduling.ts` (v3, slot-based, 2026-06-18).

### What it does
Computes `Next_Call_At` — the single field the cron fires on. The **posthook** owns the state machine (it calls these functions on every call outcome); the cron is just "is `Next_Call_At` due?".

### Rules
- **T=0:** call immediately, no time gate (done by the orchestrator, not here).
- **PICKED** (`nextCallAfterPickup`): if the customer gave a callback time → call at exactly that time (**overrides the 7-day cap** — strongest signal). Else next slot from `PICKED_NO_TIME_HOURS = [10,11,13,14,16,17,19,20]` in the customer's TZ, capped at 7 days from born.
- **NOT PICKED** (`nextCallAfterMiss`): next slot from `NOT_PICKED_HOURS = [9,10,11,13,14,16,17,19,20]`, loops until pickup or 7-day cap.
- **STOP:** `Not Interested` → `Next_Call_At = null` forever. Past 7-day lifetime → null forever.

### Mechanics
- `lookupTimezone(phone)` maps the country-code prefix (3/2/1 digits) → IANA TZ via `COUNTRY_TZ`; default `Asia/Kolkata`.
- `nextSlot()` walks today's remaining slots (strict `>` so a call that just fired at hour H doesn't reschedule to the same H), else tomorrow's first slot, adding **0–10 min random jitter** so 100 leads scheduled at "10am" don't all fire in one tick.
- `LEAD_CALL_LIFETIME_MS = 7 days` from `Created_Time`. `isPastLifetime` returns false if `createdAt` is missing (no cap can be applied → let it through).
- `zohoIso(date)` formats to Zoho's `...+00:00` string.
- `isWithinCustomerHours(phone, start, end)` — used by the WhatsApp cron to avoid night messaging.

### Gotcha
A customer-supplied callback time bypasses the 7-day cap; everything else is bounded by it. Legacy v2 fields (`Consecutive_Missed_Count`, `Aggressive_Tree_Start_At`) still exist in Zoho but are **not** read or written anymore.

---

## 6. The prd-cadence cron (main processor)

**File:** `api/cron/followup.ts`, function `runPrdCadenceProcessor()` (`?task=prd-cadence`, every 15 min). This is the highest-value, most-defended piece of logic in the repo.

### Flow
1. **Fetch all non-terminal leads** from Zoho, paginating up to **10 pages × 200 = 2000 leads** (`sort_by=Modified_Time desc`). This pagination is a fix — earlier `per_page=100` single-page meant only the 100 most-recently-modified leads were seen and 51% of leads got T=0 only.
2. Pre-fetch the **bot kill-switch set**: phones with `user_profiles.bot_enabled=false` (the inbound webhook already respected this; the cron historically didn't → sales toggled bot off but cron follow-ups kept firing).
3. Read global ops flags from `bot_settings`: `whatsapp_followups_paused`, `calls_delayed_batched`, `calls_paused`, `first_call_batch_size`.
4. **Per-person de-dup grouping:** group leads by `leadPhoneKey`; pick one `pickPrimaryLeadId` per phone (§11).
5. For each lead:
   - **Reconcile `PRD_Stage ← mapLeadStatusToStage(Lead_Status)`**, but never downgrade out of a milestone (sticky). Writes Zoho + mirror.
   - **Gate on `PRD_Stage` only**: skip if empty / `Not Interested` / `Spam` / `Pre Site Visit` (reminder cron owns the last one). Skip if phone in the kill-switch set.
   - **Silence auto-stop:** if `now - Created_Time >= COLD_FOLLOWUP_WINDOW_MS` (30d) **and** the lead never engaged (`PRD_Status` not CF/CS) **and** `Total_Call_Duration_Secs <= 10` → skip silently. (This uses `COLD_FOLLOWUP_WINDOW_MS`, not a hardcoded 7 days — the hardcoded-7 bug killed cold follow-ups at day 7.)
   - **Sibling silencing:** if this lead isn't the primary caller for its phone, clear any stale `Next_Call_At` and `continue`.
   - **Chatbot branch** (skipped when `whatsapp_followups_paused`): read `whatsapp_messages` Mongo doc to find last outbound/inbound times + last inbound text. COLD (never replied) vs GHOST (replied then silent). Gate on window + interval + `isWithinCustomerHours(7,21)`. On window-expiry → `onSsTreeExhausted` (close).
   - **Call branch** (skipped when `calls_paused`): if `Next_Call_At <= now`, fire the call. In batched mode, a first-call (no `Last_Inhouse_Call_ID`) beyond `firstCallBatchSize` this tick is **deferred** (leave `Next_Call_At` untouched so the next tick fires it — that's how "15 now, next 15 in ~15 min" works). Batch quota is consumed **only when the call actually dispatched** (`fireAiCallDirect` returns `{ok:false}` without throwing on relay failure).

### Two self-healing behaviours (fix 2026-07-07)
- **SELF-HEAL on fire:** before firing, set `Next_Call_At = next MISS-grid slot` (not null). Previously it was cleared to null and only the posthook re-set it — a single dropped posthook stalled the lead forever. Now the cadence recovers even if the posthook never lands; the posthook just overwrites with the outcome-accurate slot when it does.
- **SAFETY-NET reschedule:** if `Next_Call_At` is null but the lead already had a call (`Last_Inhouse_Call_ID` set) and is still inside the 7-day window → reschedule the next slot. Guarded by `Last_Inhouse_Call_ID` (never step on a brand-new lead's T=0) and by a non-null next slot (past-cap leads stay closed).

### Other cron tasks in the same file
- `meta-backfill` (scheduled) — Meta Graph API poll safety-net (§1).
- `mark-unique-leads` (scheduled) — `syncUniqueLeadFlags()`; sets `Is_Unique_Lead` on the most-recently-modified record per phone.
- `pre-site-visit-reminders` (scheduled, hourly) — searches `PRD_Stage=Pre Site Visit` with a future `Site_Visit_Date`; fires a 24h-before and a 3h-before WhatsApp via `fireChatbotMessage`, deduped by a `psv_reminders` Mongo key `phone-visitMs-24h`/`-3h`.
- `mongo-sync` (scheduled) — `runZohoLeadSync()` incremental Zoho→Mongo (§12). Tracks `mongo_sync_last_run` with a 30-min overlap buffer.
- `dedup-call-primaries` / `backfill-presite-stage` / `reconcile-stage-from-status` (one-shot) — corpus backfills (§11, §3).
- **Default/unknown task** → returns `{task:"legacy-followup", disabled:true}` (the old 10-day daily sequence, disabled 2026-06-09; the message bank + processing code below it is dead/unreachable).

### Gotcha
Auth: the handler only enforces `Authorization: Bearer $CRON_SECRET` for non-GET requests. Vercel cron hits are GET, so they pass; manual GETs also pass.

---

## 7. Voice-call trigger

**File:** `api/relay/inhouse-call.ts` (`POST /api/relay/inhouse-call`).

### What it does
Single dispatch path for **all** countries to the in-house ASBL voice bot (Anandita). The bot picks Plivo (+91) vs Telnyx (rest) internally.

### Flow
1. `toE164()` — strip non-digits, drop leading zeros, bare-10-digit → `+91…`, else `+<digits>`.
2. POST `${VOICEBOT_URL}/api/schedule-call` with `Bearer ASBL_VOICEBOT_API_KEY` and `{to, customer_name, external_schedule_id, external_customer_id, metadata:{project, enquired_projects, plid, mlid, ...}}`. Response is normalised across both shapes (`/api/schedule-call` → `{success, call_id, provider}`; legacy `/api/calls/initiate` → `{ok, requestUuid, engine}`).
3. On success, **stamp Zoho** (`Promise.allSettled`): `updateLead(leadId, {Last_Inhouse_Call_ID: callId, Last_Arrowhead_Call_ID: external_schedule_id})` **and** `triggerBlueprintTransition(leadId, "Lead Initiated")`. On successful stamp → `mirrorLeadStateToMongo`.

### Critical gotchas
- **Zoho stamping MUST be `await`ed** (it is, via `Promise.allSettled`) — a fire-and-forget dies on the 200 return, `Last_Inhouse_Call_ID` never persists, the posthook can't correlate the completion, and the lead sits stuck.
- **`Lead_Status` must NOT be in the direct-field PATCH.** Zoho's blueprint enforces `Lead_Status` transitions; a direct PATCH from a non-allowed state is rejected **and silently drops every other field in the same PATCH** (so `Last_Inhouse_Call_ID` would vanish). `Lead_Status` moves **only** via `triggerBlueprintTransition`; field stamps are their own standalone PATCH.
- Both `Last_Inhouse_Call_ID` (the bot's `call_id`) and `Last_Arrowhead_Call_ID` (the stable `external_schedule_id` we sent) are stamped, because on Plivo connected calls the bot promotes `requestUuid → CallUUID` and the original `requestUuid` stops being a valid lookup key — the `external_schedule_id` is the reliable backfill key.
- `VOICEBOT_URL` defaults to `https://angad-bot.onrender.com` (env `ASBL_VOICEBOT_URL` wins).

---

## 8. Voice-call posthook

**File:** `api/relay/inhouse-posthook.ts` (`POST /api/relay/inhouse-posthook`).

### What it does
Receives the voice-bot's `call_completed` (and `recording_ready`) webhook, updates Zoho, computes the next call slot, drives the blueprint + PRD stage, and logs site-visit bookings.

### Flow (`call_completed` path)
1. **Auth (non-blocking):** if `INHOUSE_POSTHOOK_SECRET` is set, compare `X-Webhook-Secret`; **log mismatches loudly but process anyway.** (History: a strict 401 here once blocked the entire calling state machine because the bot dashboard auto-generated a different signing secret — zero follow-up calls fired for weeks.)
2. **Locate lead** (`locateLead`): `Last_Inhouse_Call_ID` → `Last_Arrowhead_Call_ID` → phone fallback (ambiguous for multi-project phones — so call-id first).
3. **Lenient field extraction** — handles both `call_completed` (`call_sid`, `started_at`/`ended_at`, `call_outcome`) and internal `posthook_received` (`external_schedule_id`, `zoho_status`, `call_result_slug`) shapes. Duration: prefer explicit fields, else compute from `ended_at - started_at` (the normal path — the payload has no `duration_seconds`).
4. `deriveCallStatus()` maps the raw slug → Zoho picklist (`Connected`, `Not Connected`, `Busy`, `Switched Off`, `Pre Site`, `Virtual Tour`, `Not Interested`), with a `duration >= 10s ⟹ Connected` last-resort heuristic.
5. **Compute schedule** via `call_scheduling`: STOP (`Not Interested`) → null; PICKUP (`Connected`/`Pre Site`/`Virtual Tour`) → `nextCallAfterPickup`; MISS → `nextCallAfterMiss`. `preferredCallbackTime` comes from `body.extracted_slots.preferred_callback_time`.
6. **Update lead fields** (awaited): `Call_Status`, `Call_Duration`, `Total_Call_Duration_Secs += duration`, `Next_Call_At`. Then `mirrorLeadStateToMongo`.
7. **Blueprint transition** (`transitionMap`): Connected→"Call Connected", Pre Site→"Site Visit Confirmed", Virtual Tour→"Virtual Tour Scheduled", Not Interested→"Not Interested". **MUST await** (a fire-and-forget dropped the blueprint move → site-visit leads had `Call_Status` set but `Lead_Status`/`PRD_Stage` empty).
8. **PRD state machine** via `handleCallPosthook` — maps `Call_Status`→PRD outcome (call answers → `answered_intent_no_time`, never CF). Overridden to `answered_gave_time`/`answered_wants_site_visit` when `extracted_slots` say so. **MUST await** — this is what writes `PRD_Stage="Pre Site Visit"`.
9. **Site-visit booking log** → upsert into `site_visit_bookings` Mongo collection (`_id = leadId`) with project + date + time + type when the call books a site visit / virtual tour.
10. **Call log + Note** via `Promise.allSettled([createCallLog, createCallNote])` — **awaited** (a `.catch()` fire-and-forget silently lost half the writes).

### `recording_ready` path
Second async event; stamps `Last_Recording_URL` on the lead + a lightweight recording-link note.

### Gotcha (the recurring theme)
**Vercel kills un-awaited promises when the handler returns.** Every side-effecting write in this file is deliberately awaited. Any new write you add must be awaited too, or it'll be silently dropped in production while passing in local tests.

---

## 9. WhatsApp inbound bot + Gemini context

**File:** `api/relay/periskope-webhook.ts` (`POST /api/relay/periskope-webhook`) — 2058 lines, the highest-traffic and riskiest codepath. Uses `api/_utils/gemini_chat.ts`, `conversation_context.ts`, `project_detection.ts`, `project_facts.ts`, `inventory_sheet.ts`, `user_profile.ts`, `document_dispatcher.ts`, `doc_send_tool.ts`, `doc_validator.ts`, `sanitizer.ts`, `factual_grounder.ts`, `offer_time.ts`.

### Flow
1. Only handle `message.created`/`message.received`, inbound only (`from_me !== true`). Parse phone/sender/message.
2. **Idempotency guard:** atomically claim the inbound message in Mongo `processed_inbound` (keyed on Periskope message id, else `phone:text:2-min-bucket`), 24h TTL. A duplicate key (E11000) → ack + skip. This exists because our reply takes 6–10s and Periskope **retries** on webhook timeout — customers were getting 4–5 duplicate replies.
3. **Parallel fetch:** Zoho token+lead lookup (`findLeadDetailsByPhone` tries every phone format across `Mobile` AND `Phone`), conversation history (`getConversationContext`), and user profile (`getOrCreateProfile`) — all independent.
4. **Per-phone kill-switch:** if `userProfile.bot_enabled === false` → log the inbound message only, skip Gemini + reply, return.
5. **PRD reply hook:** fire-and-forget `handleChatbotReply` (this one **is** intentionally fire-and-forget — it must never block the reply pipeline).
6. **Resolve project** (`resolveProject`): explicit keyword > last-tagged project in history > Zoho `ASBL_Project` field > null.
7. **Pending-doc fast-path:** if the last bot turn was a size-clarification question and the customer replied with a short size label, bypass Gemini and run `dispatchUnitPlan` directly (delivers the PDF in one shot). Explicitly excluded for `LEGACY`.
8. **Build `PROJECT_CONTEXT`** (`getProjectContextText` or `getMultiProjectContextText`): always leads with the authoritative portfolio status, then KB (`kb_text`) + curated offer (`facts_text`) + **live inventory Google Sheet** + PDF extracts + cross-project size index. Appends offer-time urgency and, for factual questions, a Kimi-grounded `GROUND_TRUTH` block.
9. **Single Gemini call** (`callGemini`, grounding off) → structured JSON `{intent, flags, project, docToSend, docMeta, extractedFacts, reply}`. On failure, fall back to local Anandita LLM + regex classifier (and regex-extract `docToSend` so document requests still fire).
10. Merge `extractedFacts` into the user profile; advance the marketing funnel stage.
11. **Doc send — preflight tool first** (`sendDocumentTool`): run the doc tool BEFORE sending Gemini's "sending now" text. SEND → keep Gemini's ack; AMBIGUOUS/NOT_FOUND/ERROR → **replace** the reply with the right follow-up (in the customer's language) so they see one coherent message.
12. `sanitizeReply` + `stripReintroduction`, save outbound to Mongo, send via `sendReply` (typing indicator + 500ms + 1 retry on 5xx; flags dead senders on 401).
13. Downstream strict doc dispatch (`getDocumentStrict` on `(project, doc_type, unit_size_sft, facing, tower)`) + validator (`validateDocSend` blocks if the reply's mentioned size doesn't match the file) + SEND-ALL-variants handling + legacy fuzzy fallback for single-slot types. Every attempt is `logDocSend`'d.
14. Update Zoho `Last_Intent` + `Whatsapp_Replied`.
15. **Callback trigger:** if intent maps to `call_me` and a Zoho lead matched → `triggerCallbackCall` (30-min cooldown per lead) → `POST /api/relay/inhouse-call`. Every attempt logged to `callback_log`.

### Gemini parser (`gemini_chat.ts`)
Three-tier `parseStructuredOutput`: (1) full `JSON.parse`; (2) regex-extract the `"reply"` field from truncated/malformed JSON (recovers from `MAX_TOKENS`); (3) humanlike deflection fallback. **The customer never sees raw JSON.** `finishReason` is logged whenever it's not `STOP`. System prompt resolves DB (`bot_settings.system_prompt`) → hardcoded `ANANDITA_SYSTEM_PROMPT`, with **`PROMPT_VERSION`-gated auto-sync** (if the DB version != code `PROMPT_VERSION`, the code prompt is written back to the DB).

### Gotchas
- **`LEGACY`** (the unannounced RTC X Roads new launch) is special-cased everywhere: never send any document, never state its name (always "our new launch project by ASBL"), price/plans/possession are site-visit-only. There are multiple guards (`project === "LEGACY"` checks) in the doc paths.
- Outbound is saved to Mongo **before** the Periskope send fires, so a fast follow-up from the customer sees the bot's reply in history.
- This webhook has its **own** Zoho token cache (`getZohoToken`, two-tier: module-level + `bot_settings.zoho_access_token_v1`) — distinct from `zoho.ts`'s cache — to survive burst-load OAuth rate-limits across cold starts.

---

## 10. (see §9) — reactive vs proactive

Reactive replies (customer texts in) always answer and language-match. Proactive/templated messages (T=0 greeting, cold/ghost follow-ups, PSV reminders, resubmission) are **English only** and go through the primary-caller de-dup gate. This split is why `primary_lead` and the ops flags matter — they only govern the proactive side.

---

## 11. Per-person de-dup / primary-lead

**File:** `api/_utils/primary_lead.ts`.

### Problem
One human often has N Zoho lead records (one per project enquired). Without gating, the cron + T=0 flow would call/message the person **once per project**.

### Solution
Pick exactly **one primary caller record per phone**; gate all proactive calls + follow-ups on it. Siblings stay silent, but the primary's call carries the sibling projects as context.

### Key functions
- `leadPhoneKey(lead)` — normalised phone key (`Phone` ⟶ `Mobile`).
- `isOutreachEligible(lead)` — gates on `PRD_Stage` only; false for `Not Interested`/`Spam`/`Pre Site Visit`/empty.
- `hasStartedOutreach(lead)` — true if any of `Last_Inhouse_Call_ID`, `Next_Call_At`, `Chatbot_Attempt_Count>0`, `Chatbot_Follow_up_Count>0`, `Total_Call_Duration_Secs>0`.
- **`pickPrimaryLeadId(records)`** — filter eligible; **the LATEST-born project wins** (born = `Inncircles_Born_Date` ⟶ `Born_Date` ⟶ `Created_Time`), stable id tiebreak. Deterministic so the same record is chosen every tick (a wobbling pick would call a different project each tick). Per directive "jisme latest born hai usi project ke lie call karo."
- `otherProjectsForContext(records, exclude)` — distinct other project names, masked through `displayProject` so the LEGACY codename never leaks.
- `fetchLeadRecordsByPhone(phone)` — **Mongo-first** (avoids a Zoho search per new lead during bursts), Zoho search fallback. The sibling-check signals are all mirrored to Mongo so an active sibling is still detected.
- `dedupCallPrimariesSweep()` — the one-shot backfill (cron `dedup-call-primaries`): across all leads, clear `Next_Call_At` on non-primary siblings.

### Gotcha
T=0 uses a **first-claimer** rule (`handleLeadCreated`: if a sibling already `hasStartedOutreach`, the new record stays silent). The cron uses the **latest-born** rule (`pickPrimaryLeadId`). Both keep exactly one active caller per phone, but via slightly different selection logic.

---

## 12. Mongo / Zoho data layer + the mirror

**Files:** `api/_utils/supabase.ts` (Mongo lead layer, despite the name), `api/_utils/mongo.ts` (connection + `COL.*`), `api/_utils/zoho.ts` (Zoho REST).

### `mongo.ts`
- One cached `MongoClient` on `globalThis` (reused across warm Vercel invocations; never `.close()` from a handler). DB = `Zoho_Database`. Self-signed TLS, tight 8s timeouts.
- **`COL`** is the single registry of collection names — always route through it.
- `getNextSequence(key, startAt)` — atomic `$inc` counter (replaces Postgres serials; used for MLID and the round-robin `sender_idx`).

### `supabase.ts` (Mongo)
- Identity + dedupe: `getOrCreateMLID`, `getOrCreatePLID`, `findLeadByPLID`, `claimLeadCreation`, `upsertLead` (see §1).
- **`mirrorLeadStateToMongo(zohoLeadId, zohoFields)`** — the cross-cutting bridge. Whitelist-driven via `ZOHO_TO_MONGO_PRD_FIELD_MAP` (only mapped keys are mirrored; anything else silently skipped, so callers can pass their whole Zoho payload). Matches on `zoho_lead_id`, `upsert:false` (never creates orphan docs). **Never throws** — the Zoho write already succeeded; this is best-effort read-side consistency.
- `runZohoLeadSync({since, maxPages})` — the `mongo-sync` cron's worker. Pages Zoho (`Modified_Time` search when `since` given, else full), **bulk-upserts per page** keyed on `zoho_lead_id` (the fix for the 300s timeout from ~12k sequential ops). Time-budget stop at ~120s. `upsert:true` so direct-Zoho/LeadChain leads land in Mongo too; stores a full raw `zoho` snapshot plus flat snake_case fields.

### The `ZOHO_TO_MONGO_PRD_FIELD_MAP` (memorise this)
```
PRD_Stage→prd_stage, PRD_Status→prd_status, PRD_Last_Action→prd_last_action,
PRD_Last_Action_Time→prd_last_action_time, Chatbot_Attempt_Count→chatbot_attempt_count,
Chatbot_Follow_up_Count→chatbot_follow_up_count, SS_Call_Attempt_Count→ss_call_attempt_count,
Call_Status→call_status, Call_Duration→call_duration,
Total_Call_Duration_Secs→total_call_duration_secs, Next_Call_At→next_call_at,
Last_Inhouse_Call_ID→last_inhouse_call_id, Last_Arrowhead_Call_ID→last_arrowhead_call_id,
Lead_Status→lead_status, Site_Visit_Date→site_visit_date,
Last_Recording_URL→last_recording_url, Call_Attempt_Count→call_attempt_count,
Last_Call_At→last_call_at
```
**If you add a lifecycle field to Zoho and the in-house CRM/Mongo-based reads must see it, you MUST add it here** — otherwise `mirrorLeadStateToMongo` silently drops it and Mongo goes stale until the next `mongo-sync` full snapshot.

### `zoho.ts`
- `getAccessToken()` — module-level token cache with 3× retry on transient network errors.
- Lookups: `findLeadByInhouseCallId`, `findLeadByArrowheadCallId`, `findLeadByPhone`, `findLeadByPhoneAndProject`, `getLeadById` — all share `LEAD_LOOKUP_FIELDS`.
- `createLead`, `updateLead` (retries without URL fields on `INVALID_DATA`), `triggerBlueprintTransition` (fetches available transitions, matches by name, PUTs; treats `RECORD_NOT_IN_PROCESS` as a quiet expected no-op), `createCallLog` (Calls module), `createCallNote` (Notes on the lead).

### Gotchas
- **Zoho's `page=` param caps at 2000 records.** The `reconcile-stage-from-status` task pages via `info.next_page_token` instead (the corpus is larger than 2000). The prd-cadence cron deliberately caps at 2000 (10×200) because that's above current volume.
- `updateLead` on any payload containing `Lead_Status` from a blueprint-disallowed state silently drops the whole PATCH (see §7). Keep `Lead_Status` out of direct PATCHes.

---

## 13. Ops flags + sender pool

**Files:** `api/_utils/bot_settings.ts`, `api/_utils/ops_collections.ts`.

### `bot_settings` (Mongo key-value, `_id`=key)
Editable live from the dashboard, no deploy needed. Flags that gate automation:
| key | effect |
|-----|--------|
| `whatsapp_born_paused` | skip the T=0 WhatsApp greeting (proactive off; reactive still runs) |
| `whatsapp_followups_paused` | cron skips all cold/ghost chatbot sends this tick (calls unaffected) |
| `calls_paused` | cron fires NO calls this tick (first or follow-up); `Next_Call_At` left as-is so leads resume cleanly |
| `calls_delayed_batched` | T=0 call deferred to born+delay; cron fires never-called leads in FIFO batches of `first_call_batch_size` |
| `first_call_delay_min` / `first_call_batch_size` | override the batched-mode delay / batch size |
| `use_pdf_extracts` | include PDF text extracts in `PROJECT_CONTEXT` (default on) |
| `system_prompt` / `system_prompt_version` | live bot prompt + `PROMPT_VERSION` gate |
| `zoho_access_token_v1` | cross-cold-start Zoho token cache for the webhook |
| `mongo_sync_last_run` | incremental `mongo-sync` watermark |

### Sender pool (`ops_collections.ts`)
- `whatsapp_sender_map` — sticky phone→sender mapping so returning customers reach the same RM number.
- **Dead senders:** `markSenderDead` (1h TTL, increments `consecutive_failures`, alerts at 6), `getDeadSenders` (set within TTL), `recordSenderSuccess` (delete on good delivery), `clearDeadSender`.
- `getNextSenderIndex(n)` — round-robin via the atomic `sender_idx` counter.
- `follow_up_log`, `cron_log` audit helpers.

### Temp ops mode (per user memory, ~Jul 2026)
Proactive WhatsApp OFF + calls delayed 30 min / batched 15 per tick via the `bot_settings` flags above — meant to be reverted ~Jul 13–14.
