# ASBL In-House Voice Bot — Technical Requirements

**Audience:** Voice bot dev team
**Owner:** ASBL CRM team (Mukund)
**Last updated:** 2026-05-12
**Contract version:** v1.0

This document is the **integration contract** between the in-house voice bot ("Anandita") and the ASBL CRM orchestrator. Every endpoint, payload, and event contract listed below is mandatory unless explicitly marked optional.

---

## 0. System architecture

```
┌──────────────────┐       ┌────────────────────┐       ┌──────────────┐
│  ASBL CRM        │──1──▶ │  Voice Bot         │──5──▶ │  Plivo /     │
│  (Zoho + Vercel) │       │  (Your service)    │       │  Telephony   │
│                  │ ◀──4──│                    │       │              │
│  Orchestrator    │       │  - dialer          │       └──────────────┘
└──────────────────┘       │  - LLM agent       │
                           │  - recorder        │
                           │  - transcriber     │
                           └────────────────────┘

1. CRM → BOT:  /api/schedule-call (start a call)
2. BOT internal: validates, queues, places call via Plivo
3. BOT runs the LLM conversation
4. BOT → CRM: posthook events (call_completed, recording_ready, state changes)
5. BOT → Plivo: actual telephony
```

CRM is the **system of record** for everything (lead state, transcripts, recordings URLs, call outcomes). Bot does the work and reports back via webhooks.

---

## 1. Endpoints YOU (the bot) must expose

### 1.1 `POST /api/schedule-call`

**Purpose:** CRM asks bot to place an outbound call to a lead.

**Authentication:**
- Header: `Authorization: Bearer <ASBL_VOICEBOT_API_KEY>`
- Reject with 401 if missing or wrong.

**Request body (JSON):**

```json
{
  "to": "+919876543210",
  "customer_name": "Rajesh Kumar",
  "external_schedule_id": "1419-LOFT-call-1",
  "external_customer_id": "MLID-1419",
  "callback_url": "https://asbl-crm-api.vercel.app/api/relay/inhouse-posthook",
  "agent_persona_id": "asbl_loft_warm_v2",
  "scheduled_at": null,
  "metadata": {
    "project": "ASBL Loft",
    "plid": "1419-LOFT",
    "mlid": "MLID-1419",
    "customer_phone": "+919876543210",
    "customer_name": "Rajesh Kumar",
    "budget": "1_5_to_2cr",
    "size_preference": "3bhk_1695",
    "intent": "End Use",
    "timeline": "1_3_months",
    "is_resubmission": "false",
    "resubmission_count": "0",
    "resubmission_source": "Website Inquiry",
    "last_page_visited": "/loft-3bhk",
    "time_spent_minutes": "12",
    "total_page_views": "8"
  }
}
```

**Required response (200):**

```json
{
  "success": true,
  "call_id": "call_z3a9_internal",
  "external_schedule_id": "1419-LOFT-call-1",
  "status": "queued",
  "provider": "voice-bot"
}
```

**CRITICAL:** `external_schedule_id` MUST be echoed back in the response. The CRM uses this to stamp `Last_Inhouse_Call_ID` in Zoho. If you don't return it, we can't correlate the posthook back to the right lead.

**Failure response:**

```json
{
  "success": false,
  "error": "Plivo trunk unavailable",
  "external_schedule_id": "1419-LOFT-call-1"
}
```

Use appropriate HTTP status (4xx for client errors, 5xx for server errors).

**Fallback endpoint:** if `/api/schedule-call` isn't ready, expose `POST /api/trigger-call` with minimal `{ to: "+91..." }` body. CRM falls back automatically on 404.

---

### 1.2 `GET /api/health`

Standard health check. Return 200 with:

```json
{ "status": "ok", "version": "1.0.0", "queue_depth": 0 }
```

CRM cron monitors this every 5 min for uptime alerts.

---

## 2. Webhooks YOU must fire to the CRM

All posthook events go to:

```
POST https://asbl-crm-api.vercel.app/api/relay/inhouse-posthook
```

**Auth header (mandatory on every webhook):**

```
X-Webhook-Secret: <INHOUSE_POSTHOOK_SECRET>
```

Both sides have this secret in env. Reject without it on your side too if anyone POSTs back.

**Retry policy:** 
- Retry on 5xx response or network timeout
- Max 3 retries with exponential backoff (10s → 60s → 5min)
- After 3 fails: log to dead-letter queue, alert ops

---

### 2.1 Event: `call_completed` (REQUIRED)

Fired once when the call ends — successful, voicemail, no answer, or any final state.

```json
{
  "event": "call_completed",
  "call_sid": "abc123_plivo_sid",
  "call_id": "call_z3a9_internal",
  "external_schedule_id": "1419-LOFT-call-1",
  "phone_number": "+919876543210",
  "started_at": "2026-05-12T10:30:00Z",
  "ended_at": "2026-05-12T10:34:07Z",
  "duration_seconds": 247,
  "call_outcome": "CONNECTED",
  "summary": "Customer interested in 1695 East. Asked about price and rental scheme. Agreed to site visit Saturday 11AM.",
  "full_text": "Bot: Hello Rajesh, this is Anandita...\nCustomer: Yes hi...\n...",
  "transcript": [
    { "speaker": "bot", "text": "Hello Rajesh, this is Anandita from ASBL", "ts": "00:00:01" },
    { "speaker": "customer", "text": "Yes hi", "ts": "00:00:04" }
  ],
  "recording_url": "https://your-storage.example.com/recordings/abc123.mp3",
  "extracted_slots": {
    "intent": "End Use",
    "budget_bucket": "1_5_to_2cr",
    "timeline_bucket": "1_3_months",
    "configuration_interest": "3bhk_1695",
    "preferred_callback_time": "2026-05-13T17:00:00+05:30",
    "site_visit_requested": {
      "date": "2026-05-14",
      "slot": "11:00 AM - 12:00 PM"
    },
    "objection_raised": null
  },
  "user_signals": {
    "is_likely_broker": false,
    "is_qualified": true,
    "language_detected": "hinglish"
  },
  "agent_persona_id": "asbl_loft_warm_v2",
  "event_id": "evt_call_completed_abc123_1715520000",
  "timestamp": "2026-05-12T10:34:08Z"
}
```

**Critical fields (must always be present):**

| Field | Why |
|---|---|
| `external_schedule_id` OR `call_sid` | For lead lookup. WE STAMP this in Zoho; you echo it back. |
| `phone_number` | Phone fallback lookup. E.164 format. |
| `duration_seconds` OR (`started_at` + `ended_at`) | Stored as Call_Duration on lead. |
| `call_outcome` | Maps to Zoho's Call_Status picklist (see section 4). |
| `summary` + `full_text` (or `transcript`) | Stored on Zoho Notes + Call Log records. |

**`event_id`:** Unique per event for idempotency. Format: `evt_<event_type>_<call_id>_<unix_ts>`. CRM dedupes by this.

---

### 2.2 Event: `recording_ready` (REQUIRED — fire async after call_completed)

Plivo's recording often isn't ready when the call ends. Fire this separately once the recording is uploaded to your storage.

```json
{
  "event": "recording_ready",
  "call_sid": "abc123_plivo_sid",
  "call_id": "call_z3a9_internal",
  "phone_number": "+919876543210",
  "recording_url": "https://your-storage.example.com/recordings/abc123.mp3",
  "recording_duration_secs": 247,
  "event_id": "evt_recording_ready_abc123_1715520500",
  "timestamp": "2026-05-12T10:36:08Z"
}
```

CRM creates a separate Zoho Note with the recording link so sales can click → listen.

---

### 2.3 Event: `dial_state_change` (OPTIONAL but recommended)

Fired on every call state transition. Lets the CRM update `Call_State` picklist in real-time (good for ops dashboards).

```json
{
  "event": "dial_state_change",
  "call_sid": "abc123_plivo_sid",
  "external_schedule_id": "1419-LOFT-call-1",
  "phone_number": "+919876543210",
  "from_state": "Dialing",
  "to_state": "Connected",
  "event_id": "evt_state_dialing_to_connected_abc123_1715520010",
  "timestamp": "2026-05-12T10:30:10Z"
}
```

**Allowed state values:** `Dialing` / `Connected` / `In Progress` / `Voicemail` / `No Answer` / `Disconnected` / `Completed` / `DNC`

---

### 2.4 Event: `dnc_requested` (REQUIRED)

Customer asks to be removed from calling list. CRM must immediately suppress all future calls + set `Opt_Out_Calls = true` flag.

```json
{
  "event": "dnc_requested",
  "call_sid": "abc123",
  "phone_number": "+919876543210",
  "trigger": "user_keyword",
  "verbatim": "don't call me again",
  "event_id": "evt_dnc_abc123_1715520200",
  "timestamp": "2026-05-12T10:33:20Z"
}
```

---

## 3. CRM endpoints YOU should call (during conversation)

### 3.1 Inbound call context — `GET /api/chat-history?action=lead-context`

When a customer **calls IN** to one of the ASBL numbers, your bot should fetch their context BEFORE the conversation starts, so it doesn't sound cold.

```
GET https://asbl-crm-api.vercel.app/api/chat-history?action=lead-context
  &phone=+919876543210
  &secret=<INHOUSE_POSTHOOK_SECRET>
```

**Response (200):**

```json
{
  "found": true,
  "lead_id": "1288576000001454008",
  "first_name": "Rajesh",
  "last_name": "Kumar",
  "project": "ASBL Loft",
  "lead_status": "Lead Initiated",
  "stage": "In Conversation",
  "status": "Talking",
  "lead_tier": "Hot",
  "predicted_value_inr": 19400000,
  "slots": {
    "budget_bucket": "1_5_to_2cr",
    "timeline_bucket": "1_3_months",
    "configuration_interest": "3bhk_1695"
  },
  "last_5_whatsapp_turns": [
    { "direction": "outbound", "message": "Sending the 1695 East unit plan now, Sir.", "at": "2026-05-12T09:00:00Z" },
    { "direction": "inbound",  "message": "thanks, what about price?",                  "at": "2026-05-12T09:01:00Z" }
  ],
  "last_call_summary": "Customer asked about pricing. Agreed to site visit Saturday."
}
```

Use this to greet contextually: "Hello Rajesh, calling about ASBL Loft I assume?"

If `found: false`, treat as a cold call.

---

### 3.2 Customer-facing slot update — bot extracts a slot mid-conversation

If during the call your LLM extracts a new slot value (e.g. customer confirms budget changed from `1_5_to_2cr` to `2_to_2_5cr`), push immediately:

```
POST https://asbl-crm-api.vercel.app/api/chat-history?action=webhook-bot-turn
Headers: X-Webhook-Secret: <INHOUSE_POSTHOOK_SECRET>

{
  "lead_id": "1288576000001454008",
  "channel": "voice",
  "slots_extracted": {
    "budget_bucket": "2_to_2_5cr"
  },
  "timestamp": "2026-05-12T10:32:15Z"
}
```

CRM updates the lead immediately and recomputes Lead_Score. The slot will be available to other bots (WhatsApp, follow-up call) within seconds.

---

## 4. Call outcome mapping (Section 7 of CRM spec)

Your `call_outcome` field on `call_completed` maps to Zoho's `Call_Status` picklist:

| Your value | → Zoho Call_Status | → Blueprint transition fired |
|---|---|---|
| `CONNECTED` | Connected | Call Connected |
| `NOT_CONNECTED` / `NO_ANSWER` | Not Connected | (none) |
| `BUSY` | Busy | (none) |
| `SWITCHED_OFF` | Switched Off | (none) |
| `VOICEMAIL` | Not Connected | (none) |
| `PRE_SITE` | Pre Site | Site Visit Confirmed |
| `VIRTUAL_TOUR` | Virtual Tour | Virtual Tour Scheduled |
| `NOT_INTERESTED` | Not Interested | Not Interested |
| `AUTO_CALLBACK` | Connected | Call Connected |
| `DNC_REQUESTED` | DNC | (suppression workflow) |

**`call_outcome` is REQUIRED** on every `call_completed` event. Bot LLM should classify the call's end-state into one of these values during the wrap-up step.

---

## 5. Conversation requirements (LLM agent behavior)

### 5.1 Personalization (CRITICAL)
- **MUST** use `customer_name` from metadata in the opening greeting. Never "Hello sir" if name is provided.
- Reference `project` from metadata: "calling about ASBL Loft"
- If `is_resubmission == "true"`, alter opener: "I noticed you visited our website again — wanted to follow up"
- If `last_page_visited` is set: "I see you were looking at our [page]" 
- If `budget` is set: don't ask budget again — pivot to confirming/refining

### 5.2 Language handling
- Detect language in first customer utterance
- Support: **English, Hindi, Hinglish, Telugu** (in priority order)
- Switch dynamically if customer code-switches
- Speak in DETECTED language for rest of call
- Hindi/Telugu: hybrid acceptable — technical terms (Tower, sft, BHK, Cr) in Roman/English is OK

### 5.3 Persona consistency
- Bot identity: "Anandita Reddy from ASBL"
- Tone: friendly, professional, Hyderabad market sensibility
- Per-project persona via `agent_persona_id` (loft / broadway / spectra / landmark)
- Never claim to be human if asked directly. Disclose: "I'm an AI assistant from ASBL's team, helping with your enquiry."

### 5.4 Goal hierarchy per call
1. Qualify (intent / budget / timeline / config) — fill missing slots
2. Book a site visit (date + slot) — primary goal
3. Schedule callback if customer requests
4. Capture objections if customer pushes back
5. Detect DNC / opt-out keywords ("stop calling", "do not call")

### 5.5 Compliance
- **NEVER** call outside 9 AM–9 PM IST (your scheduler enforces this)
- **NEVER** call more than 3 times/day per phone
- **NEVER** call a phone marked DNC (CRM provides this state via `/lead-context`)
- Detect opt-out keywords; fire `dnc_requested` event immediately and END THE CALL politely

---

## 6. Recording + transcript storage

- **Recordings:** mp3 or wav, stored at signed URL valid **30 days+**
- **Transcripts:** plain text + structured array (see 2.1 above)
- Both linked by `call_id` / `call_sid`
- **Retention:** keep recordings + transcripts at least 90 days (some compliance reasons)
- Provide a way to **re-fetch** by call_sid:
  ```
  GET /api/calls/{call_sid}/recording   → signed mp3 URL
  GET /api/calls/{call_sid}/transcript  → plain text + structured array
  ```
  In case CRM loses the URL or needs to re-sync.

---

## 7. Security

### 7.1 Authentication
- Bot's `/api/schedule-call` requires `Authorization: Bearer <ASBL_VOICEBOT_API_KEY>`
- Bot's webhooks to CRM require `X-Webhook-Secret: <INHOUSE_POSTHOOK_SECRET>`
- CRM's `/lead-context` requires `secret=<INHOUSE_POSTHOOK_SECRET>` query param
- All secrets stored in env vars, NEVER in code/repo

### 7.2 HMAC signing (recommended for future)
Currently we use shared secrets. For richer security:
- Optional: sign payloads with HMAC-SHA256 using shared secret
- Header: `X-Signature: sha256=<hex>`
- Body for HMAC: raw JSON bytes (UTF-8)
- CRM verifies signature before accepting

### 7.3 IP allowlist (optional)
If your bot deploys behind known static IPs, CRM can allowlist them for an extra layer. Not strictly required.

---

## 8. Idempotency + dedup

**EVERY webhook event MUST include `event_id`.** Format suggestion: `evt_<type>_<call_sid>_<unix_ts_seconds>`.

CRM dedupes by `event_id`. Resending the same event multiple times is safe — no double-update.

**Why:** retries on network failures, Plivo callbacks firing twice, etc. If `event_id` collides, CRM treats the second as already-processed.

---

## 9. Error reporting

When something goes wrong on the bot side (Plivo dial failed, LLM crashed, etc.):

### 9.1 Inline failure (from `/api/schedule-call`)
Return 4xx/5xx with structured error:

```json
{
  "success": false,
  "error_code": "PLIVO_TRUNK_UNAVAILABLE",
  "error_message": "Plivo trunk returned 503",
  "external_schedule_id": "1419-LOFT-call-1",
  "retry_after_seconds": 60
}
```

CRM stamps `Call_State = Disconnected` + retries via cadence.

### 9.2 Post-dial failure event
If call started but failed mid-way (LLM timeout, Plivo dropped, etc.):

```json
{
  "event": "call_failed",
  "call_sid": "abc123",
  "external_schedule_id": "1419-LOFT-call-1",
  "phone_number": "+919876543210",
  "error_code": "LLM_TIMEOUT",
  "error_message": "Anandita LLM timed out at turn 4",
  "partial_transcript": "Bot: Hello...\nCustomer: yes hi\nBot: (timeout)",
  "started_at": "2026-05-12T10:30:00Z",
  "ended_at": "2026-05-12T10:30:35Z",
  "event_id": "evt_call_failed_abc123_1715520035",
  "timestamp": "2026-05-12T10:30:36Z"
}
```

CRM stamps `Call_State = Disconnected` + retries via cadence (subject to rate limits).

---

## 10. Concrete next steps for the dev team

### Phase 1 (MVP — week 1)
- [ ] Expose `POST /api/schedule-call` with the contract in §1.1
- [ ] Fire `call_completed` posthook with all required fields per §2.1
- [ ] Fire `recording_ready` posthook async per §2.2
- [ ] Fire `dnc_requested` per §2.4 if customer asks to stop
- [ ] Implement opcoe outcome classification per §4 mapping
- [ ] Implement personalization per §5.1 (use customer_name + project + last_page_visited)

### Phase 2 (week 2)
- [ ] Implement `/lead-context` consumer for inbound calls per §3.1
- [ ] Implement live slot update push per §3.2
- [ ] Per-project persona switching per `agent_persona_id`
- [ ] Multi-language detection + dynamic switching per §5.2

### Phase 3 (week 3)
- [ ] `dial_state_change` events per §2.3
- [ ] `call_failed` error event per §9.2
- [ ] HMAC signing on webhooks per §7.2
- [ ] Re-fetch recording/transcript APIs per §6

### Phase 4 (optional polish)
- [ ] IP allowlist
- [ ] `/api/health` deep status endpoint with queue depth + error rate
- [ ] Daily summary email/Slack to ops

---

## 11. CRM endpoints reference (already shipped, you can use today)

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/relay/inhouse-call` | POST | None | Initiator (CRM → bot) — used by Zoho Deluge |
| `/api/relay/inhouse-posthook` | POST | `X-Webhook-Secret` | **You POST here on call_completed / recording_ready** |
| `/api/chat-history?action=lead-context` | GET | `secret=` | **You GET here for inbound call context** |
| `/api/chat-history?action=webhook-bot-turn` | POST | `X-Webhook-Secret` | **You POST here for live slot updates** |
| `/api/chat-history?action=zoho-lead` | GET | `secret=` | Debug: inspect a Zoho lead |

---

## 12. Shared secrets — environment variables

CRM side has these env vars already. **You must have the same values on the bot side.**

| CRM env var name | Used for | Who needs it |
|---|---|---|
| `ASBL_VOICEBOT_API_KEY` | CRM → bot `Authorization: Bearer` header | Bot validates incoming requests |
| `INHOUSE_POSTHOOK_SECRET` | Bot → CRM `X-Webhook-Secret` header | Bot signs outgoing posthooks |
| `ASBL_VOICEBOT_URL` | Base URL of bot's API (e.g. `https://asbl-voice-bot.onrender.com`) | CRM uses to build full path |

Coordinate with Mukund to share these via secure channel (Slack DM, 1Password, etc.).

---

## 13. Open questions for the dev team

Please reply on these before MVP starts:

1. **Telephony provider locked?** Plivo confirmed, or considering alternates (Twilio, Exotel)?
2. **LLM backend** — using our existing Anandita LLM (Vercel-hosted Gemini + Kimi)? Or your own?
3. **Recording storage** — S3? GCS? Your own service? Signed URL provider?
4. **Multi-project persona timing** — when can `agent_persona_id` switching be ready? (Currently we have only Loft live; Broadway/Spectra/Landmark queued.)
5. **Inbound call routing** — when a customer calls ASBL's number, who routes to bot vs human? IVR config needed?
6. **DNC suppression source of truth** — bot side enforces, or only CRM (`/lead-context` returns DNC flag)?
7. **Call recording legal disclosure** — bot opens every call with "this call is being recorded for quality" or does CRM provide pre-recorded disclosure?

---

## 14. Why this contract matters

The spec we're implementing on the CRM side (ASBL Loft Zoho CRM spec) hinges on every state transition being **auditable and propagated to ad platforms** (Meta CAPI + Google OCI). Without your contract:

- ❌ Calls happen but `Last_Inhouse_Call_ID` doesn't get stamped → CRM can't find the lead when posthook arrives → call outcomes lost in the void
- ❌ Bot doesn't classify outcome → CRM defaults to "Not Connected" → wrong cadence triggered
- ❌ No transcript → sales reps can't review → bot quality can't be improved
- ❌ No slot extraction → Lead_Score doesn't update → ad platform doesn't get accurate qualification signal → campaigns continue training on broken signal

**Every field in this contract feeds into either:**
- Sales team's workflow (transcripts, recordings, callbacks)
- Ad platform optimization (Meta + Google value-based bidding via Lead_Tier + Predicted_Value)
- Customer experience (no duplicate cold calls, personalized greetings)

So when in doubt, **err on the side of sending more data**. Fields can be ignored; missing fields can't be reconstructed.

---

**Questions or pushback:** ping Mukund on Slack. We can iterate fast — this contract is v1.0 but not frozen. If you need a field or pattern we missed, let's add it before MVP.
