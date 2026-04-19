# ASBL CRM — Full System Context
**Last Updated:** 19 April 2026

---

## Architecture Overview

```
Lead Sources (Meta/Website/FIM)
        ↓
Vercel API (asbl-crm-api.vercel.app)
        ↓
Supabase (MLID/PLID generation)
        ↓
Zoho CRM (single source of truth)
        ↓
Arrowhead AI Call → LazyBot WhatsApp
```

---

## 1. Lead Ingestion (Vercel API)

**Repo:** `https://github.com/1Mukund/asbl-crm-api`
**Live URL:** `https://asbl-crm-api.vercel.app`

### Endpoints
- `POST /api/ingest/website` — Website form leads
- `POST /api/ingest/meta` — Meta Ads leads (webhook)
- `POST /api/relay/arrowhead` — Relay to Arrowhead API (bypasses Zoho domain block)
- `POST /api/relay/arrowhead-posthook` — Receives Arrowhead call results → updates Zoho

### Key Files
- `api/_utils/ingest.ts` — Core ingestion logic (MLID/PLID → Zoho create/update)
- `api/_utils/zoho.ts` — Zoho API helper (search, create, update, findByArrowheadCallId)
- `api/_utils/supabase.ts` — MLID/PLID via Supabase RPC
- `api/relay/arrowhead.ts` — Arrowhead relay
- `api/relay/arrowhead-posthook.ts` — Posthook handler

### Env Vars (Vercel)
- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY`

---

## 2. Supabase

**DB:** `postgresql://postgres.nodpzowdaqqexfbmcpsx:...@aws-1-ap-southeast-1.pooler.supabase.com`

### Key RPC Functions
- `get_or_create_mlid(p_phone)` → MLID (sequential: 1001, 1002...)
- `get_or_create_plid(p_phone, p_mlid, p_project)` → PLID (e.g. `1002-BROADWAY`)

---

## 3. Zoho CRM

**URL:** `https://crmplus.zoho.in/asbl9777`
**API Base:** `https://www.zohoapis.in/crm/v3`

### Phone Number Format in Zoho
Stored as digits only, NO `+` sign. Example: `918700432466`

### Custom Fields (API Names for Deluge)
| Field | API Name |
|-------|----------|
| Master Lead ID | `Master_Lead_ID` |
| Project Lead ID | `Project_Lead_ID` |
| Source Lead ID | `Source_Lead_ID` |
| ASBL Project | `ASBL_Project` |
| Call Status | `Call_Status` |
| Call Attempt Count | `Call_Attempt_Count` |
| Last Call At | `Last_Call_At` |
| Last Arrowhead Call ID | `Last_Arrowhead_Call_ID` |
| Call Duration | `Call_Duration` |
| Call Summary | `Call_Summary` |
| WhatsApp Sent | `Whatsapp_Sent` |
| WhatsApp Replied | `Whatsapp_Replied` |
| Last WhatsApp At | `Last_Whatsapp_At` |
| Last Intent | `Last_Intent` |
| SFCF Active | `SFCF_Active` |
| SFCF Step | `SFCF_Step` |
| Next Followup At | `Next_Followup_At` |
| Country Code | `Country_Code` |
| Call Eligible | `Call_Eligible` |
| Brochure Sent | `Brochure_Sent` |
| Price Sheet Sent | `Price_Sheet_Sent` |
| Site Visit Slots Sent | `Site_Visit_Slots_Sent` |
| High Intent | `High_Intent` |
| High Intent Reason | `High_Intent_Reason` |
| UTM Source | `UTM_Source` |
| UTM Medium | `UTM_Medium` |
| UTM Campaign | `UTM_Campaign` |
| Lead Budget | `Lead_Budget` |
| Size Preference | `Size_Preference` |
| Floor Preference | `Floor_Preference` |
| Lead Comments | `Lead_Comments` |
| First Page Visited | `First_Page_Visited` |
| Last Page Visited | `Last_Page_Visited` |
| Total Page Views | `Total_Page_Views` |
| Time Spent Minutes | `Time_Spent_Minutes` |
| Referrer URL | `Referrer_URL` |
| Ad Set Name | `Ad_Set_Name` |
| Ad Name | `Ad_Name` |

### Call_Status Picklist Values
`Not Called`, `Connected`, `Not Connected`, `Busy`, `Switched Off`, `Pre Site`, `Virtual Tour`, `Not Interested`

### Last_Intent Picklist Values
`general`, `brochure`, `price`, `call_me`, `site_visit`, `not_interested`

### ASBL_Project Picklist Values
`LOFT`, `SPECTRA`, `BROADWAY`, `LANDMARK`, `LEGACY`

### Dedup Logic
- Same phone + same project → UPDATE existing lead
- Same phone + new project → CREATE new lead
- MLID same across projects, PLID different per project

---

## 4. Arrowhead (AI Calling)

**API URL:** `https://api.agent.arrowhead.team/api/v2/public/domain/932f86fc-ed03-42d5-a127-7dfc63216a8a/campaign/a0a15c01-2aa2-40b3-9e46-94109131b17b/schedule`
**Bearer Token:** `1928b882dbd4e043fcc61be27aa6eec00b925c1b5cdc4af592a623399571119a`

### Payload Format
```json
{
  "customer_full_name": "Name",
  "mobile_number": "919876543210",
  "external_customer_id": "1002",
  "external_schedule_id": "1002-BROADWAY-call-1",
  "input_variables": {
    "customer_name": "Name",
    "project": "BROADWAY",
    "budget": "1Cr - 2Cr",
    "size_preference": "",
    "intent": "", "country": "", "comments": "",
    "web_time_spent": "", "call_enrichment_data": "",
    "floor_level_preference": "", "handover_timeline_preference": ""
  }
}
```

### external_schedule_id Format: `PLID-call-N` (e.g. `1002-BROADWAY-call-3`)

### Posthook URL (sent to Arrowhead team — pending their config)
`https://asbl-crm-api.vercel.app/api/relay/arrowhead-posthook`

### Call Status Mapping (Arrowhead → Zoho)
- `CONNECTED`/`AUTO_CALLBACK` → `Connected`
- `NOT_CONNECTED`/`NO_ANSWER` → `Not Connected`
- `BUSY` → `Busy`
- `SWITCHED_OFF` → `Switched Off`
- `PRE_SITE` → `Pre Site`
- `VIRTUAL_TOUR` → `Virtual Tour`
- `NOT_INTERESTED` → `Not Interested`

---

## 5. Zoho Deluge Functions

### `automation.triggerArrowheadCall(string lead_id)` ✅ WORKING
- Fetches lead, normalizes phone, increments attempt count
- Calls `https://asbl-crm-api.vercel.app/api/relay/arrowhead`
- Updates: `Call_Attempt_Count`, `Last_Call_At`, `Last_Arrowhead_Call_ID`, `Call_Status`
- DateTime format: `yyyy-MM-dd'T'HH:mm:ss+05:30`

### `button.triggerCallButton(string lead_id)` ✅ WORKING
- Manual button wrapper for detail view

### Zoho Connection
- `arrowhead_connection` — created but Vercel relay used instead (more reliable)

### Important Notes for Deluge
- `zoho.crm.updateRecord` needs `lead_id.toLong()` — NOT string
- `request` and `input` variables do NOT work in CRM functions
- Phone in Zoho: digits only, no + sign
- Datetime format must be `yyyy-MM-dd'T'HH:mm:ss+05:30`

---

## 6. Zoho Automation ✅

### Workflow Rule: `Auto Trigger Arrowhead Call` — ACTIVE
- Trigger: Lead Created
- Condition: Phone Number starts with `91` OR starts with `1`
- Action: `automation.triggerArrowheadCall(lead_id)`

### Button: `Trigger Arrowhead Call` — Detail View
- Function: `button.triggerCallButton(lead_id)`

### Blueprint
- Stages: New Lead → First Touch → Contacted → Pre Site → Virtual Tour → Not Interested

---

## 7. LazyBot (WhatsApp CRM)

**Repo:** `https://github.com/1Mukund/lazybot-whatsapp-crm`
**Backend:** Render — `https://lazybot-whatsapp-crm.onrender.com`
**Frontend:** Vercel — `https://lazybot-whatsapp-crm.vercel.app`
**Local folder:** `Own A Periskope/whatsapp-crm/`

### Tech Stack
- Backend: Node.js + Express + Baileys (WhatsApp Web API)
- Frontend: React + Vite
- DB: Supabase (same DB as CRM)
- AI: Anandita LLM

### Active Session (19 Apr 2026)
- Session ID: `3945463e-9f14-4597-9471-005cd8ee14ad`
- Phone: `+919599896700` (Bala SK number)

### Backend .env (Render)
```
DATABASE_URL=...connection_limit=2  ← updated to fix pool exhaustion
AGENT_URL=http://35.154.144.37:8080/api/chat/
AGENT_API_KEY=asbl_9b9b6b7ff1f758be40aca7ceb03d7d0d9c57d788b4457d5ca5819620b25d146a
```

### Anandita LLM API Format
```json
Request:  { "phone": "+919876543210", "message": "user message" }
Response: { "flag": "success", "message": "AI reply text" }
```

### Public API (for Zoho to send WhatsApp)
```
POST /api/v1/messages/send
Header: X-API-Key: <lazybot_api_key>
Body: { "sessionId": "3945463e-9f14-4597-9471-005cd8ee14ad", "phone": "919876543210", "message": "..." }
```

### How It Works
1. Customer sends WhatsApp → LazyBot receives via Baileys
2. Calls Anandita LLM `{phone, message}` → gets reply
3. Sends reply back on WhatsApp (@lid JID handled natively)
4. Fires webhooks to configured URLs

### Fixes Applied (19 Apr 2026)
- LID JID fix: sends to @lid directly (Baileys internal routing)
- Session retry: waits 15s for reconnect before dropping reply
- Stale sessions deleted (4c24a8dc, 0234681c)
- DB connection_limit=2 to prevent pool exhaustion
- Duplicate webhooks cleaned up

---

## 8. Anandita LLM

**URL:** `http://35.154.144.37:8080/api/chat/`
**API Key:** `asbl_9b9b6b7ff1f758be40aca7ceb03d7d0d9c57d788b4457d5ca5819620b25d146a`

Handles ALL customer interaction — no Gemini, no separate intent detection.

---

## 9. Key Architectural Decisions

1. No Zoho auto-dedup — MLID/PLID generated before pushing to Zoho
2. Vercel as Arrowhead relay — Zoho blocks direct external API calls
3. Arrowhead posthook via Vercel — Zoho functions don't support raw body access
4. LazyBot over Periskope — owned, free, Anandita LLM already integrated
5. Phone stored as digits in Zoho (no + prefix)
6. Only +91 and +1 numbers get Arrowhead calls

---

## 10. Pending Tasks

- [x] LazyBot: Deployed on Render, AI reply working ✅
- [ ] LazyBot API Key: Get from dashboard → needed for Zoho integration
- [ ] Zoho → LazyBot: Call Not Connected → auto-send WhatsApp (via Vercel relay)
- [ ] LazyBot → Zoho webhook: Customer WhatsApp reply → update Zoho fields
- [ ] SFCF Scheduler: Follow-up sequence
- [ ] Arrowhead posthook: Confirm team has configured URL
- [ ] UptimeRobot: Setup to keep Render alive (prevent spin-down)
