# ASBL CRM System — Complete Architecture & Flow Documentation

**Last updated:** 2026-06-05
**Owner:** Mukund (1Mukund)
**Repo:** https://github.com/1Mukund/asbl-crm-api
**Production:** https://asbl-crm-api.vercel.app (Vercel Pro, auto-deploy from `main`)

---

## Table of Contents

1. [Big-Picture Architecture](#1-big-picture-architecture)
2. [External Systems We Integrate With](#2-external-systems-we-integrate-with)
3. [Internal Storage Layers](#3-internal-storage-layers)
4. [Lead Sources & Ingestion Endpoints](#4-lead-sources--ingestion-endpoints)
5. [PRD State Machine](#5-prd-state-machine)
6. [PRD T=0 Fanout — What Happens When a New Lead Arrives](#6-prd-t0-fanout--what-happens-when-a-new-lead-arrives)
7. [Voice Bot Integration (angad-bot.onrender.com)](#7-voice-bot-integration-angad-botonrendercom)
8. [WhatsApp Flow (Periskope)](#8-whatsapp-flow-periskope)
9. [Cron-Based Follow-up Loop](#9-cron-based-follow-up-loop)
10. [Posthook — Call Completion Handling](#10-posthook--call-completion-handling)
11. [Mongo Schema — Every Collection](#11-mongo-schema--every-collection)
12. [Zoho Custom Fields (Leads Module)](#12-zoho-custom-fields-leads-module)
13. [Zoho Deluge Functions & Workflows](#13-zoho-deluge-functions--workflows)
14. [Resubmission, Cooldowns, Kill-Switches](#14-resubmission-cooldowns-kill-switches)
15. [Admin / Diagnostic Endpoints](#15-admin--diagnostic-endpoints)
16. [Common Failure Modes & Recovery](#16-common-failure-modes--recovery)
17. [Operational Constraints & Gotchas](#17-operational-constraints--gotchas)
18. [Environment Variables (Vercel)](#18-environment-variables-vercel)

---

## 1. Big-Picture Architecture

```
              ┌─────────────────────────────────────────────────────┐
              │                                                       │
   ┌──────────┴──────────┐                              ┌────────────┴───────────┐
   │   LEAD SOURCES      │                              │  REAL-TIME CHANNELS    │
   ├─────────────────────┤                              ├────────────────────────┤
   │ • Meta Lead Ads     │ ─┐                          │ • Periskope WhatsApp   │
   │ • Website forms     │  │                          │ • angad-bot voice bot  │
   │ • FIM landing pages │  │                          │ • Zoho CRM Deluge      │
   │ • Inncircles M1     │  │                          └────────────┬───────────┘
   │ • LeadChain (Zoho)  │  │                                       │
   └─────────────────────┘  │                                       │
                            ▼                                       │
                  ┌─────────────────────────────────────────────────┴────────┐
                  │                  Vercel Pro Functions                     │
                  │             (asbl-crm-api, 12 endpoints)                  │
                  │                                                           │
                  │  ┌─────────────────┐    ┌─────────────────┐               │
                  │  │ /api/ingest/*   │ →  │ PRD orchestrator │               │
                  │  └─────────────────┘    └────────┬─────────┘               │
                  │                                  │                         │
                  │           ┌──────────────────────┼─────────────────┐       │
                  │           ▼                      ▼                 ▼       │
                  │  ┌──────────────┐   ┌──────────────────┐  ┌────────────┐  │
                  │  │ Zoho updates │   │ Voice-bot relay  │  │ Periskope  │  │
                  │  │ (PATCH /Leads)│   │ /inhouse-call    │  │ /send      │  │
                  │  └──────┬───────┘   └────────┬─────────┘  └─────┬──────┘  │
                  │         │                    │                  │          │
                  │         │   ┌────────────────┼──────────────────┘          │
                  │         │   │                │                              │
                  │  ┌──────▼───▼─┐    ┌────────▼──────────┐                   │
                  │  │ Mongo write│    │ /api/cron/followup│                   │
                  │  │ (mirror)   │    │ (every 15 min)    │                   │
                  │  └────────────┘    └──────────────────┘                    │
                  │                                                            │
                  │  Posthook  ◄───────────  /api/relay/inhouse-posthook       │
                  │                                                            │
                  └────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌────────────────────────────────────────────────────────────┐
              │                STORAGE LAYERS                              │
              ├────────────────────────────────────────────────────────────┤
              │ • Zoho CRM (source-of-truth for lead lifecycle)            │
              │ • Mongo (self-hosted EC2): leads, whatsapp_messages, etc.  │
              │ • Supabase Storage (project PDF docs only)                 │
              │ • Google Sheets (live inventory + pricing)                 │
              └────────────────────────────────────────────────────────────┘
```

**Key insight:** Vercel functions are **stateless glue**. All state lives in Zoho (source-of-truth) + Mongo (read-side mirror + identity).

---

## 2. External Systems We Integrate With

| System | Purpose | Auth | Key endpoints |
|--------|---------|------|---------------|
| **Zoho CRM (India region)** | Lead + Call records, lifecycle state, sales workflow | OAuth refresh token | `https://zohoapis.in/crm/v3/Leads`, `/Calls`, `/Notes` |
| **angad-bot.onrender.com** | Outbound AI voice calls (Plivo for +91, Telnyx for international) | Bearer `ASBL_VOICEBOT_API_KEY` (or open `/api/calls/initiate`) | `POST /api/schedule-call` (auth) or `POST /api/calls/initiate` (legacy open) |
| **Periskope** | Inbound + outbound WhatsApp | `PERISKOPE_API_KEY` | `POST /v1/messages/send`, webhook `message.created` |
| **Google Gemini 3 Pro** | Inbound WhatsApp intent + reply generation | `GEMINI_API_KEY` | structured-output single call |
| **Meta Graph API** | Lead-ads webhook + leadgen backfill | `META_PAGE_ACCESS_TOKEN` (System User permanent) | `/leadgen` webhook, `/leads` polling |
| **Inncircles M1** | Third-party form platform, posts leads to our webhook | `INNCIRCLES_WEBHOOK_SECRET` (optional) | `POST /api/ingest/inncircles` |
| **Google Sheets** | Live inventory + pricing | Service account | Sheet ID hardcoded |

---

## 3. Internal Storage Layers

### Zoho CRM (Source of Truth)
- **Leads module** — every lead lives here with PRD lifecycle fields
- **Calls module** — every completed call gets a Call log entry (visible in standard Zoho call view)
- **Notes module** — every call also creates a Note on the lead with transcript + recording link
- **Custom Blueprint** — "ASBL Lead Journey" enforces Lead_Status transitions

### Mongo (self-hosted, EC2 `13.127.144.117`, DB: `Zoho_Database`)
1. **`leads`** — 1 doc per PLID. Identity, attribution, PRD state mirror (since 2026-06-03).
2. **`whatsapp_messages`** — 1 doc per phone, IST-date-bucketed inbound/outbound array.
3. **`user_profiles`** — per-phone profile (name, current_project, funnel_stage, **bot_enabled** kill-switch).
4. **`project_documents`** — PDF metadata (URL + filename + size_label).
5. **`project_facts`** — KB text + offer text per project (live editable from dashboard).
6. **`bot_settings`** — runtime config (live system prompt, cached Zoho access token).
7. **`mlid_registry`** — atomic counter for Master_Lead_ID minting.
8. **`plid_registry`** — atomic counter for Project_Lead_ID minting.
9. **`whatsapp_sender_map`** — phone → Periskope sender pool assignment (sticky).
10. **`follow_up_log`** — legacy daily 10-msg follow-up cron audit.
11. **`cron_log`** — audit of every cron run (task, duration, result, error).
12. **`doc_send_log`** — every PDF send via WhatsApp (validation audit).
13. **`audit_logs`** — every admin action (login, mark-spam, doc upload).

### Supabase Storage
- Only PDF blob storage (brochures, price sheets, floor plans, etc.)
- Browser uploads directly via signed PUT URL (bypasses Vercel's 4.5 MB body limit)
- Metadata stored in Mongo `project_documents` collection

### Google Sheets
- Master inventory sheet — read-through cache (5-min TTL)
- Updated by sales/ops directly on the sheet

---

## 4. Lead Sources & Ingestion Endpoints

All 4 ingest endpoints follow the same pattern:

```
External webhook POSTs lead payload
   ↓
buildLead() / buildNormalizedLead() — normalize raw payload → NormalizedLead type
   ↓
ingestLead() — get-or-create MLID, get-or-create PLID, atomic claim,
              Zoho create/update, Mongo upsert
   ↓
If action === "created":  await handleLeadCreated(...)  ← PRD T=0 fanout (CRITICAL await)
   ↓
Return 200 { success, action: "created"|"updated", zoho_lead_id, mlid, plid, resubmission? }
```

### 4.1 `/api/ingest/meta`
- Triggered by Meta Lead Ads webhook (subscribed via Facebook Page → Webhooks → leadgen).
- Verifies signature against `META_VERIFY_TOKEN`.
- Allowlist check via `META_FORM_IDS_ALLOWLIST`.
- Extracts standard fields (name, phone, email) + Meta ad metadata (campaign_name, ad_set_name, ad_name).
- Also has GET subscription verification handshake.

### 4.2 `/api/ingest/website`
- POST from main asbl.in website form submissions.
- Accepts flexible keys: `phone | mobile`, `name | first_name + last_name`, plus full UTM set + page tracking.
- Detects project from `utm_campaign` / `page_url` / explicit `project` field.

### 4.3 `/api/ingest/fim`
- POST from FIM landing pages (lead source = "FIM Forms").
- Batch-capable: accepts `{ leads: [...] }` or single object.
- Same shape as website ingest.

### 4.4 `/api/ingest/inncircles`
- POST from Inncircles M1 platform.
- Optional shared-secret gate via `INNCIRCLES_WEBHOOK_SECRET`.
- Batch-capable like FIM.
- **Caller-side timeout ~44 seconds** — known constraint, our handler must respond within this.

### 4.5 `/api/normalize-zoho-lead` (LeadChain / Zoho-direct leads)
- Called by Zoho Deluge automation when a lead is created via LeadChain.
- Generates MLID + PLID, patches Zoho lead with normalized fields, upserts to Mongo.
- **PRD T=0 DISABLED here** (was causing spam — Deluge fires this on Zoho UPDATE events too, not just creations).
- LeadChain leads are sales-handled manually via the Zoho bulk button.

### 4.6 Common ingestion logic (`api/_utils/ingest.ts`)

```
1. getOrCreateMLID(phone)            → atomic counter on Mongo mlid_registry
2. getOrCreatePLID(phone, mlid, project)  → atomic counter on plid_registry
3. claimLeadCreation(plid, ...)      → atomic claim — only ONE concurrent request wins,
                                       others reuse the first request's zoho_lead_id
4. existing lead? → Zoho updateLead + recordResubmission (counter + history + cooldown)
   new lead?      → Zoho createLead + Born_Date patch
5. upsertLead → Mongo `leads` collection (identity + attribution + zoho_lead_id)
6. Return { action: "created" | "updated", zoho_lead_id, mlid, plid, resubmission? }
```

**Race protection** (`claimLeadCreation`): When 2 concurrent submissions for the same phone hit at once (e.g., bot retries, double-click on form), Mongo's `findOneAndUpdate` with `returnDocument: 'before'` serializes them. Exactly one gets `status:"first"` (proceeds to Zoho create), all others get `status:"duplicate"` (wait briefly for first's zoho_lead_id, then reuse it). Result: at most ONE Zoho lead per PLID even under heavy concurrent submission.

---

## 5. PRD State Machine

Every lead has a 2-axis state: **Stage × Status**.

### Stage values (high-level lifecycle phase)
| Stage | Meaning |
|-------|---------|
| `New Lead` | Just ingested, no outreach yet completed |
| `Lead Initiated` | T=0 fired, lead in active SS retry tree |
| `Pre Site Visit` | Customer agreed to a site visit |
| `Not Interested` | Either explicit rejection OR both channels (chatbot + AI call) exhausted |
| `Spam` | Sales-marked spam — never follow up again |

### Status values (sub-state within stage)
| Status | Meaning |
|--------|---------|
| `NA` | No action yet completed |
| `CF` | Customer Followed — replied/answered, engaged |
| `SF` | Suggested Follow-up — chatbot sent but no reply within 24h |
| `CS` | Customer Slot — customer gave a preferred callback time |
| `SS` | Suggested Sequence — in the active 3-attempt AI-call retry tree |

### Cadence config (`api/_utils/prd_cadence.ts`)
```ts
CHATBOT_NO_REPLY_WINDOW_MS:    24h  (NA → SF after this if no reply)
CHATBOT_FOLLOWUP_MAX_ATTEMPTS: 3
CHATBOT_FOLLOWUP_INTERVAL_MS:  24h between follow-ups
SS_CALL_MAX_ATTEMPTS:          3
SS_CALL_INTERVAL_MS:           4h between retries
```

### Channel exhaustion → terminal state
When **both** chatbot follow-up attempts AND SS call attempts hit max (3 each, no engagement), lead transitions to `Not Interested` via `onSsTreeExhausted`.

---

## 6. PRD T=0 Fanout — What Happens When a New Lead Arrives

```
Lead created (action === "created" from ingest)
        │
        ▼
handleLeadCreated() in api/_utils/prd_orchestrator.ts
        │
        ├──→ onLeadCreated() — sets PRD_Stage="New Lead", PRD_Status="NA"
        │
        ├──→ Promise.all([
        │      fireChatbotMessage()  → Periskope sender pool → WhatsApp greeting,
        │      fireAiCall()           → /api/relay/inhouse-call → angad-bot dial
        │    ])
        │
        ├──→ incrementChatbotAttempt() → Chatbot_Attempt_Count++ in Zoho + Mongo
        │
        └──→ if (ai_call.ok) incrementSsCallAttempt() → SS_Call_Attempt_Count++
```

### What the customer experiences at T=0
1. **WhatsApp (~1-2 sec after lead create):**
   ```
   Hi {name}, this is Anandita from ASBL. I see you've enquired about {project}.
   When would be a good time for a quick call to discuss pricing, availability, and offers?
   ```
2. **Voice call (~3-7 sec after lead create):**
   - angad-bot dials customer via Plivo (+91) or Telnyx (international)
   - LLM-driven conversation by "Anandita" persona
   - Call lasts 30s-3min typically
   - On completion, posthook fires back to our `/api/relay/inhouse-posthook`

### CRITICAL — `await handleLeadCreated`
Until 2026-06-05, `handleLeadCreated(...)` was called with **fire-and-forget** `.catch(...)` pattern. Vercel kills the worker on handler return, so the promise died mid-flight and **PRD T=0 silently skipped for most leads** (lead 1288576000002161053 / mahee is the documented case). Now awaited explicitly in all 4 ingest endpoints. Adds 3-7s to webhook response but stays well under Inncircles' 44s caller-side timeout.

---

## 7. Voice Bot Integration (angad-bot.onrender.com)

### History
- **2026-05-21:** Original Render `asbl-voice-bot.onrender.com` was suspended → migrated to self-hosted nginx behind `voice.asbl.in`.
- **2026-06-03:** Migrated to new Render-hosted bot at `angad-bot.onrender.com`. Codebase rewrite with Fastify + Gemini.

### Trigger flow
```
PRD orchestrator OR Zoho Deluge bulk button OR WhatsApp "call me" intent
        │
        ▼
POST https://asbl-crm-api.vercel.app/api/relay/inhouse-call
        │
        ├──→ Normalize phone to E.164 (+91XXX...)
        ├──→ POST angad-bot.onrender.com/api/calls/initiate
        │       { to, customer_name, external_schedule_id, external_customer_id, metadata }
        │
        ├──→ Bot picks provider: +91 → Plivo, else → Telnyx (internal routing)
        │
        ├──→ Bot returns { ok: true, requestUuid, engine: "gemini" }
        │
        └──→ Vercel relay:
              • Zoho updateLead({ Last_Inhouse_Call_ID: requestUuid })  ← stamp call_id
              • Mongo mirrorLeadStateToMongo()                           ← mirror to leads doc
              • triggerBlueprintTransition("Lead Initiated")             ← Zoho state move
```

### Endpoints on the bot
| Endpoint | Purpose | Auth |
|----------|---------|------|
| `POST /api/schedule-call` | Auth-protected, returns `{success, call_id, status, provider}`. **Currently 401-ing on Bearer key mismatch — pending Render env fix** | Bearer `ASBL_VOICEBOT_API_KEY` |
| `POST /api/calls/initiate` | Legacy open endpoint, returns `{ok, requestUuid, engine}`. **Currently used by our relay** | None |
| `GET /api/health` | Liveness check | None |

### Response normalization (`api/relay/inhouse-call.ts`)
Our relay handles both response shapes:
```ts
const okFlag = r.ok && (data.success === true || data.ok === true);
const callId = String(data.call_id || data.requestUuid || data.external_schedule_id || "");
```

So flipping back to `/api/schedule-call` later (once auth is sorted) requires no relay code change.

### Country routing (decided by bot)
- `+91...` → Plivo (India)
- Anything else → Telnyx (US, UK, UAE, AUS, etc.)
- No region detection on our side anymore — single payload shape, bot picks provider.

---

## 8. WhatsApp Flow (Periskope)

### Inbound — `/api/relay/periskope-webhook`
Customer sends a WhatsApp message → Periskope POSTs `message.created` event to us.

```
1. Filter — accept only inbound text messages
2. Look up Zoho lead by phone (cached via 2-tier zoho token cache)
3. Check user_profiles.bot_enabled — if false, log inbound but skip Gemini reply
4. Resolve project: regex on msg > Zoho ASBL_Project field > last asked
5. Build PROJECT_CONTEXT:
     • KB text (project_facts.kb_text)
     • Offers (project_facts.facts_text)
     • Live inventory from Google Sheets (5-min cached)
6. Fetch last 30-day conversation history from Mongo whatsapp_messages
7. Build structured message with <CUSTOMER>, <PROJECT_CONTEXT>, <CONVERSATION_HISTORY>, <USER_MESSAGE>
8. Single Gemini 3 Pro call → structured JSON output:
     { intent, flags, project, doc_to_send, reply, extractedFacts }
9. Save outbound row to Mongo BEFORE Periskope send (so next msg sees consistent history)
10. 1.5s "typing" delay → Periskope POST /v1/messages/send (with 1 retry on 5xx)
11. If doc_to_send is set → look up project_documents → send PDF via Periskope
12. Update Zoho: Last_Intent (mapped to picklist) + Whatsapp_Replied=true
13. If intent === "call_me": auto-trigger /api/relay/inhouse-call (with 30-min cooldown)
```

### Outbound channels
1. **PRD T=0 greeting** (handleLeadCreated → fireChatbotMessage)
2. **PRD chatbot follow-ups** (handleChatbotFollowupTick, every 24h, max 3)
3. **Gemini reply** to inbound (periskope-webhook)
4. **Document send** (PDF) when intent === "brochure"|"price"|...
5. **Resubmission outreach** (api/_utils/resubmission.ts on repeat form fill)
6. **Daily 10-day follow-up cron** (legacy, hardcoded ASBL Loft copy)

### Periskope sender pool (round-robin, sticky per phone)
10 sender numbers:
```
919063141693, 917794028484, 917396077334, 919059555164, 918977537630,
917207048181, 917396130606, 917386023002, 919247524774, 917995284040
```
Sender→phone mapping stored in Mongo `whatsapp_sender_map` so the same phone always gets messages from the same sender (continuity).

### Gemini quirks
- Model: `gemini-3-pro-preview` (override via `GEMINI_MODEL` env).
- **Thinking burns 1500-3000 tokens before any visible output.** Default `maxOutputTokens: 8000` to leave ~5000 for the JSON.
- Timeout: 35s. Real prod replies usually 6-10s end-to-end.
- System prompt is **runtime-overridable** via `bot_settings.system_prompt` in Mongo (live editable via `/api/chat-history?view=edit-prompt`).
- **3-tier parser** for malformed JSON:
  1. Full `JSON.parse` (happy path)
  2. Regex-extract `"reply":"..."` from truncated JSON
  3. Friendly fallback ("Hmm, give me a sec — let me pull that up...")
- Customer NEVER sees raw JSON even on parser failure.

---

## 9. Cron-Based Follow-up Loop

Two crons configured in `vercel.json`:

| Schedule | Task | Purpose |
|----------|------|---------|
| `*/15 * * * *` (every 15 min) | `?task=prd-cadence` | Drive PRD state machine — chatbot follow-ups + SS retry calls |
| `*/15 * * * *` (every 15 min) | `?task=meta-backfill` | Safety net — poll Meta Graph API directly for last 2h leads that webhook may have missed |
| `30 4 * * *` (daily 10:00 IST) | (default) | Legacy 10-day follow-up sequence for non-responders |

### PRD cadence cron flow (`/api/cron/followup?task=prd-cadence`)

```
1. Pull recent Zoho leads (paginated, up to 10 pages × 200 = 2000 max)
2. For each lead:
   ├── if PRD_Stage in (Not Interested | Spam | Pre Site Visit) → skip
   ├── if created >7 days ago AND zero engagement → skip (auto-silence)
   ├── 1. CHATBOT FOLLOW-UP branch:
   │     • Check if customer engaged (PRD_Status in [CF, CS]) — if yes skip
   │     • Look up last OUTBOUND WhatsApp time from Mongo whatsapp_messages
   │     • Gate: now - last_outbound >= 24h AND followup_count < 3
   │     • If yes → handleChatbotFollowupTick() — sends next msg + bumps counter
   └── 2. SS CALL RETRY branch:
         • PRD_Status === "SS" AND SS_Call_Attempt_Count < 3
         • Gate: now - PRD_Last_Action_Time >= 4h
         • If yes → handleSsCallTick() — places call via relay + bumps counter
3. Both channels exhausted? → onSsTreeExhausted() → PRD_Stage = "Not Interested"
4. Log audit to Mongo cron_log
```

### Why chatbot gate uses LAST OUTBOUND time (not creation_time + count×24h)
The old logic (`now - Created_Time >= (count+1)*24h`) was a **disaster for backlogged leads**: a 5-day-old lead with NULL count would fire 3 messages back-to-back across consecutive cron ticks (each 15 min apart) because the creation-anchored threshold stayed TRUE between increments. 141 phones got spammed 2-6 msgs on 2026-05-28 before this fix (commit `352f174`).

New logic: gate only on `now - lastOutboundMs >= 24h`. Self-throttling regardless of counter state.

---

## 10. Posthook — Call Completion Handling

When voice-bot finishes a call, it POSTs to:
```
POST https://asbl-crm-api.vercel.app/api/relay/inhouse-posthook
Header: X-Webhook-Secret: <INHOUSE_POSTHOOK_SECRET>
Content-Type: application/json
```

### Events the bot sends (per dev's spec)
| event | When | What we do |
|-------|------|------------|
| `call_completed` | Every call ends — fires once with full data | Update Zoho lead fields + create Note + create Call log + blueprint transition |
| `recording_ready` | 1-2 min after hangup, when Plivo finishes uploading | Add a "— recording" suffix Note with the playable .mp3 link |
| `call_failed` | Call crashed before transcript was produced | Same as call_completed but call_status defaults to "Not Connected" |
| `dnc_requested` | Customer used a DNC keyword mid-call | Mark lead as Not Interested + (todo) flip bot_enabled=false |
| `dial_state_change` | Real-time dial transitions (optional) | Currently no-op |

### Posthook handler flow (`api/relay/inhouse-posthook.ts`)

```
1. Auth check: X-Webhook-Secret == INHOUSE_POSTHOOK_SECRET (env var)
   (Logs a byte-level diag dump on mismatch so we can pin whether bot
    is sending wrong value or no header.)
2. Parse event field — special-case "recording_ready", else fall through
   to call_completed default path
3. Extract: call_id, phone, duration_seconds, summary, transcript[],
   recording_url, call_outcome (CONNECTED/NOT_CONNECTED/BUSY/PRE_SITE/etc.)
4. Locate the lead — 3-tier fallback:
   a. findLeadByInhouseCallId(call_id)     → matches Last_Inhouse_Call_ID
   b. findLeadByArrowheadCallId(call_id)   → matches Last_Arrowhead_Call_ID (legacy)
   c. findLeadByPhone(phone)                → phone fallback (ambiguous if customer has multiple project leads)
5. Update lead-level fields:
   • Call_Status = mapped status
   • Call_Duration = this call's secs
   • Total_Call_Duration_Secs += this call
   • Mirror to Mongo
6. Best-effort Zoho blueprint transition based on outcome:
   Connected      → "Call Connected"
   Pre Site       → "Site Visit Confirmed"
   Virtual Tour   → "Virtual Tour Scheduled"
   Not Interested → "Not Interested"
7. Create Note on lead — "Arrowhead Call — <call_id>" with full transcript + summary + duration + recording link
8. Create Call log entry — appears in standard Zoho Calls module view
9. Route through PRD state machine (handleCallPosthook) to advance Status (CF/CS/etc.)
```

### CRITICAL — Lead_Status NOT in same PATCH
Zoho's "ASBL Lead Journey" blueprint **enforces transitions** on `Lead_Status`. A direct PATCH with `Lead_Status` set to a non-allowed value (e.g., "Lead Initiated" when current is "Virtual Tour") is rejected by Zoho's validation AND **drops every OTHER field in the same PATCH with it**. So `Last_Inhouse_Call_ID` would disappear silently along with it.

Fix (commit `b547953`): split into two operations:
1. `updateLead(zohoLeadId, { Last_Inhouse_Call_ID: callId })` — direct PATCH, no Lead_Status
2. `triggerBlueprintTransition(zohoLeadId, "Lead Initiated")` — separate API call that respects the blueprint

---

## 11. Mongo Schema — Every Collection

Database: `Zoho_Database` (MongoDB self-hosted, EC2 `13.127.144.117`, TLS with self-signed cert).

### `leads`
```js
{
  _id: "1714-BROADWAY",                    // PLID = primary key
  plid: "1714-BROADWAY",
  mlid: "1714",
  phone: "919843221236",                   // E.164 minus +
  zoho_lead_id: "1288576000002161053",     // for posthook lookup
  zoho_synced: true,
  zoho_synced_at: "2026-06-05T09:57:25Z",
  // Identity
  first_name, last_name, email,
  // Source
  lead_source, source_lead_id, campaign_name,
  ad_set_name, ad_name,
  utm_source, utm_medium, utm_campaign, utm_content, utm_term,
  // Project
  project, lead_budget, size_preference, floor_preference,
  possession_timeline, purchase_purpose, lead_comments,
  // Web tracking
  first_page_visited, last_page_visited, total_page_views,
  time_spent_minutes, referrer_url,
  // PRD STATE MIRROR (added 2026-06-03, write-through from Zoho)
  prd_stage, prd_status, prd_last_action, prd_last_action_time,
  chatbot_attempt_count, chatbot_follow_up_count, ss_call_attempt_count,
  call_status, call_duration, total_call_duration_secs,
  last_inhouse_call_id, last_arrowhead_call_id,
  lead_status, site_visit_date, last_recording_url,
  call_attempt_count, last_call_at,
  // Timestamps
  lead_received_at, created_at, updated_at,
}
```

### `whatsapp_messages`
```js
{
  _id: "919843221236",                     // phone = primary key
  phone: "919843221236",
  last_message_at: "2026-06-05T18:44:04Z",
  inbound_count: 3,
  outbound_count: 5,
  total_count: 8,
  by_date: {
    "2026-06-05": {
      inbound:  [{ time, message, sender, intent, project }, ...],
      outbound: [{ time, message, sender, intent, project }, ...]
    },
    "2026-06-04": { ... },
    ...
  }
}
```

### `user_profiles`
```js
{
  _id: "919843221236",                     // phone = primary key
  phone: "919843221236",
  name: "mahee",
  current_project: "BROADWAY",
  last_project: "BROADWAY",
  funnel_stage: "T2_PRICE_KNOWN" | "T1_INFO" | ...,
  bot_enabled: true,                       // KILL-SWITCH — false silences WhatsApp bot
  extracted_facts: { budget, size, ... },  // accumulated from Gemini extraction
  docs_sent: ["brochure", "price_sheet"],
  funnel_history: [...],
  llm_cost_cents: 423,
  created_at, last_interaction_at,
}
```

### `mlid_registry` & `plid_registry`
Atomic counter docs — `findOneAndUpdate { $inc: { value: 1 } }` for ID minting.

### `project_documents`
```js
{
  project: "LOFT",
  doc_type: "brochure" | "price_sheet" | "master_plan" | "payment_structure" | "specifications" | "amenities" | "floor_plan" | "unit_plan",
  size_label: "1695sqft west" | null,      // for multi-slot doc_types
  url: "https://supabase-storage-url.../brochure.pdf",
  filename: "ASBL_Loft_Brochure.pdf",
  uploaded_at,
}
```

### Other collections
- `project_facts` — KB text + offer text per project
- `bot_settings` — `zoho_access_token_v1` cached, `system_prompt` live-editable
- `whatsapp_sender_map` — phone → sticky Periskope sender
- `follow_up_log` — legacy 10-day cron audit
- `cron_log` — every cron run's duration + result + error
- `doc_send_log` — every PDF send validation event
- `audit_logs` — admin actions (login, mark-spam, doc-upload, etc.)

---

## 12. Zoho Custom Fields (Leads Module)

### Identity / Attribution (set on ingest)
- `Master_Lead_ID` — global counter, same MLID for all leads of one phone across projects
- `Project_Lead_ID` — per-project counter, format `<MLID>-<PROJECT>`
- `Source_Lead_ID` — original ID from Meta/FIM/Inncircles
- `ASBL_Project` — picklist (LOFT/BROADWAY/SPECTRA/LANDMARK/LEGACY)
- `Campaign_Name`, `Ad_Set_Name`, `Ad_Name`, `UTM_*`
- `Born_Date` — original creation date (immutable across resubmissions)
- `Lead_Received_At`

### Project Interest
- `Lead_Budget`, `Size_Preference`, `Floor_Preference`, `Possession_Timeline`, `Purchase_Purpose`, `Lead_Comments`

### Web Tracking
- `First_Page_Visited`, `Last_Page_Visited`, `Total_Page_Views`, `Time_Spent_Minutes`, `Referrer_URL`

### PRD State Machine
- `PRD_Stage` — New Lead / Lead Initiated / Pre Site Visit / Not Interested / Spam
- `PRD_Status` — NA / CF / SF / CS / SS
- `PRD_Last_Action` — "Chatbot" / "AI Call"
- `PRD_Last_Action_Time` — ISO datetime
- `Chatbot_Attempt_Count`, `Chatbot_Follow_up_Count`, `SS_Call_Attempt_Count`

### Call Tracking
- `Call_Status` — picklist (Not Called / Connected / Not Connected / Busy / Switched Off / Pre Site / Virtual Tour / Not Interested)
- `Call_Duration` — seconds, current call
- `Total_Call_Duration_Secs` — running sum across all calls
- `Last_Inhouse_Call_ID` — call_id from voice-bot (used by posthook lookup)
- `Last_Arrowhead_Call_ID` — set by Deluge function, format `<PLID>-call-<N>` (legacy naming, kept for compat)
- `Last_Recording_URL` — most recent Plivo recording link
- `Call_Attempt_Count`, `Last_Call_At` — set by Deluge function

### WhatsApp
- `Whatsapp_Sent`, `Whatsapp_Replied`, `Last_Whatsapp_At`, `Last_Intent`

### Site Visit
- `Site_Visit_Date`

### Resubmission
- `Resubmission_Count`, `Last_Resubmission_At`, `Last_Resubmission_Source`, `Resubmission_History` (text log)

---

## 13. Zoho Deluge Functions & Workflows

### Function: `automation.triggerArrowheadCall` (current name, hits in-house bot now)
Located: Zoho CRM → Setup → Developer Space → Functions.

Behaviour (after 2026-06-03 update):
1. Fetch lead by ID
2. Validate phone has digits (no country restriction — accepts ALL countries now)
3. Increment `Call_Attempt_Count`
4. Build payload with `_zoho_lead_id`, `phone_number`, `customer_full_name`, `retell_llm_dynamic_variables`, `external_schedule_id`
5. POST to `https://asbl-crm-api.vercel.app/api/relay/inhouse-call`
6. Stamp Zoho: `Last_Arrowhead_Call_ID` = `<PLID>-call-<N>`, `Call_Status` = "Not Called"

### Function: `automation.bulkTriggerArrowheadCalls`
Sales clicks "Trigger Arrowhead Calls" button in Zoho list view → this function loops over selected leads, calling `triggerArrowheadCall` for each.

### Function: `automation.callAnandita` (LEGACY DEAD CODE)
Was meant to handle WhatsApp inbound when bot was hosted on Zoho. Now dead — production WhatsApp goes through our Periskope webhook directly.

### Workflow: "Auto Trigger Arrowhead Call" — **DEACTIVATED 2026-06-03**
Used to fire on every lead creation in Zoho (T+2min delay) → triggerArrowheadCall. **Disabled because it duplicated PRD T=0 from our ingest webhooks.** Every lead was getting 2 calls. Now off.

### Custom Button: "Mark as Spam"
Sales multi-selects gali contacts → Deluge function calls `/api/chat-history?action=mark-spam` with lead IDs → for each:
1. Zoho: Lead_Status="Spam", PRD_Stage="Spam", PRD_Status=null
2. Mongo `user_profiles.bot_enabled = false` — WhatsApp goes silent permanently
3. Audit log entry

---

## 14. Resubmission, Cooldowns, Kill-Switches

### Resubmission (`api/_utils/resubmission.ts`)
When an existing lead resubmits a form (same phone + project):
1. Increment `Resubmission_Count`
2. Append a line to `Resubmission_History` text field with timestamp + source + campaign
3. Stamp `Last_Resubmission_At`, `Last_Resubmission_Source`
4. **30-minute cooldown** — if a previous outreach (WhatsApp greeting OR call) was sent within last 30 min, **suppress new outreach**. Otherwise fire fresh greeting + AI call.

This prevents customer spam — if someone fills 3 forms in 5 minutes, only one outreach goes.

### Bot kill-switch (per-phone)
Mongo `user_profiles.bot_enabled = false` → WhatsApp webhook still logs inbound messages but **skips Gemini reply + Periskope send**. Voice calls (via PRD T=0 / SS cron / bulk button) still go.

Toggle from dashboard: `https://asbl-crm-api.vercel.app/api/chat-history?view=dashboard` → "Bot Override" section → search phone → click toggle.

### Spam (`/api/chat-history?action=mark-spam`)
- Zoho: Lead_Status="Spam", PRD_Stage="Spam"
- Mongo `user_profiles.bot_enabled = false`
- PRD cron skips PRD_Stage="Spam" (no follow-ups, no SS retries, ever)
- Audit log entry per lead

### 7-day auto-silence
PRD cron skips leads that are 7+ days old AND have zero engagement (no inbound, no connected call ever). Avoids harassing genuinely-uninterested customers indefinitely.

### Calling hours
Currently **NO calling-hours gate** on our side. Earlier (commit `0a55d39`) gated at 9 AM-10 PM IST to match voice.asbl.in's behaviour; removed in `e915b4f` after migrating to angad-bot which dials anytime. Lead created at midnight → T=0 call goes immediately.

### Future re-enable (if desired)
The `isWithinCallingHours()` helper still exists in `prd_cadence.ts` — just re-import + add gate in `fireAiCall()` to bring back the restriction.

---

## 15. Admin / Diagnostic Endpoints

All admin endpoints are gated by `?secret=<INHOUSE_POSTHOOK_SECRET>` (or an admin browser session).

| Endpoint | Purpose |
|----------|---------|
| `GET /api/chat-history?view=dashboard` | Main UI — recent chats, leads inspector, bot kill-switch toggles |
| `GET /api/chat-history?view=edit-prompt` | Live system-prompt editor for Gemini |
| `GET /api/chat-history?view=edit-facts&project=LOFT` | Per-project offer text editor (`facts_text`) |
| `POST /api/chat-history?action=test-gemini` | Sandbox call to Gemini with a project's PROJECT_CONTEXT (no Periskope/Zoho side effects) |
| `GET /api/chat-history?action=meta-token-check` | Validates `META_PAGE_ACCESS_TOKEN` (System User permanent? expires?) |
| `GET /api/chat-history?action=zoho-lead&id=<lead_id>` | Full PRD state + last 5 Notes + Calls for one lead |
| `GET /api/chat-history?action=lead-context&phone=<phone>` | Find lead by phone, return summary |
| `GET /api/chat-history?action=zoho-leads-report&since=YYYY-MM-DD` | Per-day breakdown of leads by status + source |
| `POST /api/chat-history?action=upload-sign` | Signed Supabase Storage PUT URL for direct browser upload |
| `POST /api/chat-history?action=save-prompt` | Live update of bot system prompt |
| `POST /api/chat-history?action=refresh-inventory` | Manual flush of inventory cache |
| `POST /api/chat-history?action=mark-spam` | Bulk mark leads as Spam (Zoho + Mongo + audit) |
| `POST /api/chat-history?action=toggle-bot&phone=...&enabled=0\|1` | Flip per-phone bot kill-switch |
| `GET /api/chat-history?action=backfill-inhouse-call-id&dry=1\|0` | Retroactively stamp `Last_Inhouse_Call_ID` from old Note titles (used during 2026-06-03 PATCH-bug recovery) |
| `GET /api/chat-history?action=backfill-prd-state&dry=1\|0&days=60` | Seed Mongo `leads.prd_*` fields from Zoho (one-time after schema add) |
| `GET /api/chat-history?action=zoho-audit` | Full field-level audit of Leads module |
| `GET /api/chat-history?action=arrowhead-cleanup-audit` | Lists every Zoho workflow/function/button mentioning "Arrowhead" |

---

## 16. Common Failure Modes & Recovery

### A. "Lead created but no call/WhatsApp went"
**Root cause (fixed 2026-06-05):** PRD T=0 was called fire-and-forget with `.catch(...)` — Vercel killed the worker on handler return, promise died.

**Fix:** Now awaited in all 4 ingest endpoints (commit `12a842a`).

**Recovery for stuck leads:** Click Zoho bulk "Trigger Arrowhead Calls" button — Deluge re-fires and now-fixed relay pipeline correctly stamps + dials.

### B. "Call placed but Zoho not updated"
**Root cause (fixed 2026-06-03):** Relay PATCHed `{ Lead_Status, Last_Inhouse_Call_ID }` together. Zoho blueprint rejected `Lead_Status` direct update, AND dropped `Last_Inhouse_Call_ID` with it.

**Fix:** Separate PATCH for the field stamp; blueprint transition via separate API (commit `b547953`).

**Recovery:** `/api/chat-history?action=backfill-inhouse-call-id&dry=0` — walks recent leads, finds latest "Arrowhead Call — UUID" note, stamps the UUID into `Last_Inhouse_Call_ID`.

### C. "Posthook returns 401"
**Root cause:** Bot's webhook delivery uses a different `X-Webhook-Secret` value than our `INHOUSE_POSTHOOK_SECRET` env. Bot's dashboard auto-generates a `whk_...` signing secret per webhook, which overrides the env-var-driven value.

**Fix:** On bot dashboard (`goodcalls.in/admin/webhooks`), edit the webhook → manually replace signing secret with our env value.

**Diagnostic:** Posthook handler logs byte-level prefix/suffix/length comparison on every reject — check Vercel logs.

### D. "Voice-bot 404"
**Root cause:** Vercel env `ASBL_VOICEBOT_URL` still set to old `voice.asbl.in` host — endpoints don't match.

**Fix:** Update env to `https://angad-bot.onrender.com` OR delete the env var (default kicks in).

### E. "Same lead getting 5+ WhatsApp follow-ups in 1 hour"
**Root cause (fixed 2026-05-28):** Cron chatbot gate was `now - Created_Time >= (count+1)*24h` — for backlogged leads with NULL count, threshold stayed TRUE between cron ticks, firing multiple msgs per hour. 141 phones spammed.

**Fix:** Gate on `last_outbound_at` from Mongo `whatsapp_messages` (commit `352f174`).

### F. "Mongo doc count > Zoho lead count"
**Root cause:** Old orphan docs from test ingests + leads deleted in Zoho UI but not in Mongo.

**Fix:** Manual cleanup. See `mongo-backfill` admin endpoint family for sync utilities.

### G. "Inncircles webhook timeout (status 0, 'This operation was aborted')"
**Root cause:** Our ingest handler took >44s to respond (their timeout). Usually Vercel cold start + slow Zoho API combine to exceed.

**Fix:** Inncircles must implement retry-on-failure (`crmFailedAt` field flag indicates lead lost). Lead can be manually re-fired by calling our ingest endpoint again with same payload.

---

## 17. Operational Constraints & Gotchas

1. **Vercel Pro function cap:** 12 functions max (counts files at `api/*.ts` top-level + nested). Currently at 12. Helpers go in `api/_utils/`. **Don't add new top-level files without removing one first.**

2. **Vercel commit author gate:** Vercel resolves commit email → GitHub user → Vercel account → team membership. Only `balmukund21xxx074@akgec.ac.in`-mapped commits auto-deploy. `mukundasbl@gmail.com` works if `mukundasbl-5482` Vercel account is in team. Otherwise auto-blocked, requires manual Redeploy. See `CLAUDE.md` for full saga.

3. **Vercel env-var changes need a redeploy.** Saving in UI doesn't hot-swap into runtime. Push empty commit OR click Redeploy.

4. **Vercel request body limit ~4.5 MB.** PDF uploads go via signed Supabase PUT URL — browser uploads directly, only metadata transits Vercel.

5. **Serverless `await` matters.** Fire-and-forget `.catch()` patterns die when the handler returns 200. Use `await` or `Promise.allSettled` to ensure all side-effect writes complete.

6. **Mongo TLS self-signed.** Connection bootstrap can be slow on cold start (1-2s). Plan for it in latency budgets.

7. **Zoho rate limits.** Burst Zoho API calls (especially OAuth /token refresh) can throttle. We use 2-tier cache (module-level + Mongo `bot_settings.zoho_access_token_v1`) to minimize refreshes.

8. **Periskope sender pool sticky assignment.** Don't hardcode a single sender — always go through `pickSender(phone)` so the same customer always gets messages from the same sender.

9. **Bot persona ("Anandita") is shared across WhatsApp + voice.** Keep prompts consistent if changing one.

10. **`Last_Arrowhead_Call_ID` is legacy field name** — still used because Deluge stamps it. Our posthook handles both Last_Inhouse_Call_ID + Last_Arrowhead_Call_ID for lookup. Don't rename without data migration.

---

## 18. Environment Variables (Vercel)

All set on **Production** scope (most also on Preview).

| Group | Vars |
|-------|------|
| **Mongo** | `MONGO_URI` (TLS connection string), `MONGO_DB_NAME=Zoho_Database` |
| **Supabase** | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (Storage only) |
| **Gemini** | `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3-pro-preview`) |
| **Zoho** | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` |
| **Periskope (WhatsApp)** | `PERISKOPE_API_KEY` |
| **Meta Lead Ads** | `META_PAGE_ACCESS_TOKEN` (System User permanent), `META_VERIFY_TOKEN`, `META_FORM_IDS_ALLOWLIST`, `META_BACKFILL_FORM_IDS` |
| **Voice bot (angad-bot)** | `ASBL_VOICEBOT_URL=https://angad-bot.onrender.com`, `ASBL_VOICEBOT_API_KEY` (Bearer for /api/schedule-call) |
| **Posthook auth** | `INHOUSE_POSTHOOK_SECRET=cd98...aa41` (must match bot's outgoing X-Webhook-Secret) |
| **Inncircles ingest auth** | `INNCIRCLES_WEBHOOK_SECRET` (optional) |
| **Cron auth** | `CRON_SECRET` (Vercel cron Bearer auth) |
| **Dashboard auth** | `ADMIN_PASSWORD_HASH` (scrypt salt:hash, NEVER plaintext), `SESSION_SIGNING_SECRET` |

---

## Recent Fixes Timeline (2026-06-03 → 2026-06-05)

| Commit | What it fixed |
|--------|---------------|
| `b547953` | Lead_Status + Last_Inhouse_Call_ID PATCH split (blueprint reject bug) |
| `3b3ab9f` | Backfill endpoint for stuck Last_Inhouse_Call_ID — 89 leads recovered |
| `ca2bc38` | Backfill: handle Zoho's 204 empty notes response |
| `df057a8` | Voice-bot rotation — voice.asbl.in → angad-bot.onrender.com via /api/calls/initiate |
| `0a55d39` | Calling-hours gate added (9-22 IST) — later removed |
| `8751d10` | Mongo PRD state mirror — 682 leads backfilled |
| `e915b4f` | Calling-hours gate REMOVED — new bot dials anytime |
| `12a842a` | **CRITICAL** — await handleLeadCreated in all 4 ingest endpoints (THE root cause of "lead aa rahi but call/msg nahi") |

---

## Quick Reference: When X happens, what gets touched?

**Customer fills website form:**
1. asbl.in form POST → `/api/ingest/website`
2. `ingestLead()` — MLID/PLID minted in Mongo, Zoho `createLead`, Mongo `leads` upsert
3. `await handleLeadCreated()` — Periskope greeting + voice-bot call fired in parallel
4. Counters bumped in Zoho + Mongo
5. Response: 200 OK

**Customer answers a voice call:**
1. Voice-bot finishes call → POST `/api/relay/inhouse-posthook`
2. Auth check passes (X-Webhook-Secret matches)
3. Lookup lead by `Last_Inhouse_Call_ID`
4. Zoho updateLead: Call_Status="Connected", Call_Duration, Total updated
5. Mongo mirror
6. Blueprint transition: "Call Connected" → Stage moves to "Contacted"
7. Note + Call log created in Zoho with transcript + recording link
8. PRD state machine routes outcome → Status update (CF if engaged, etc.)

**Customer writes "call me" on WhatsApp:**
1. Periskope webhook → `/api/relay/periskope-webhook`
2. Gemini classifies intent → CALLBACK → maps to "call_me"
3. Gemini reply sent via Periskope ("Sure, calling you...")
4. 30-min cooldown check (Zoho `Last_Call_At` / `PRD_Last_Action_Time`)
5. If cooldown passed → POST `/api/relay/inhouse-call` → voice-bot dials immediately

**Cron tick fires (every 15 min):**
1. `/api/cron/followup?task=prd-cadence`
2. Pull recent Zoho leads (paginated)
3. For each: skip terminal stages, check 7-day silence
4. Chatbot follow-up branch: if 24h since last outbound + count<3 → fire WhatsApp
5. SS call branch: if PRD_Status=SS + 4h since last action + count<3 → fire AI call
6. Exhaustion check: both maxed → transition to Not Interested
7. Audit to Mongo `cron_log`

---

## Glossary

| Term | Meaning |
|------|---------|
| **MLID** | Master Lead ID — global counter, one per phone (across all projects) |
| **PLID** | Project Lead ID — per-project counter, format `<MLID>-<PROJECT>` |
| **PRD** | Product Requirements Document v1.0 — the document defining this lifecycle state machine |
| **T=0** | "Time zero" — the immediate fanout (chatbot + AI call) that happens when a lead is created |
| **SS** | "Suggested Sequence" — the 3-attempt 4-hour-interval voice call retry tree |
| **CF** | "Customer Followed" — customer responded/engaged |
| **CS** | "Customer Slot" — customer provided a preferred callback time |
| **SF** | "Suggested Follow-up" — initial chatbot msg sent but no reply within 24h |
| **NA** | "No Action" — initial state before any outreach completes |
| **Anandita** | The bot's persona — used across WhatsApp + voice |
| **Bulk Button** | Sales-facing button in Zoho list view that fires `triggerArrowheadCall` for multi-selected leads |
| **LeadChain** | Zoho-internal automation that creates leads from other Zoho-side flows (bypasses our ingest webhooks) |

---

**End of document.** Questions? Read `CLAUDE.md` (developer onboarding) or `INGESTION_LOGIC.md` (deeper ingest spec) alongside this.
