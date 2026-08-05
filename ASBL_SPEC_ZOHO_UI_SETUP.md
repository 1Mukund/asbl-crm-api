# ASBL Loft Spec — Zoho UI Setup Guide

Code side fully implemented. This doc covers the Zoho UI work that has to be done in the CRM admin console — Blueprint, Layout Rules, Validation Rules, Saved Views, Workflow Rules (optional — Vercel handles most logic).

All custom fields are already created in the Leads module (85 fields, prefixed "ASBL Loft Spec —" so they don't clash with existing field labels).

---

## 1. Blueprint redesign (Section 7 — state machine)

**Path:** Setup → Process Management → Blueprint → Leads → New Blueprint (or Edit existing)

Create a Blueprint named **"ASBL Loft Lead Journey"** on the **Stage** field with 6 states + transitions.

### States
| State | Settings |
|---|---|
| New Lead | Default — entry state |
| In Conversation | Mark mandatory fields if any |
| Site Visit Scheduled | Mandatory: Site_Visit_Date, Site_Visit_Slot |
| Site Visit Done | Mandatory: Site_Visit_Attended = true |
| Booked | Mandatory: Booking_Amount, Booking_Date — TERMINAL |
| Closed | Mandatory: Closure_Reason — TERMINAL |

### Transitions (per spec section 7)

Set up these transitions between states (use exact names — Vercel state machine fires them):

**From New Lead:**
- `First Inbound` → In Conversation
- `Outreach Exhausted` → Closed (set Closure_Reason = Unreachable)
- `Site Visit Confirmed` → Site Visit Scheduled (override — fires from any state)
- `Customer Not Interested` → Closed (set Closure_Reason = Not Interested)

**From In Conversation:**
- `Site Visit Confirmed` → Site Visit Scheduled
- `Customer Not Interested` → Closed (Not Interested)
- `Recovery Exhausted` → Closed (Unreachable)

**From Site Visit Scheduled:**
- `Visit Attended` → Site Visit Done
- `Visit No-Show` → Closed (Visit No-Show)
- `Visit Cancelled` → In Conversation

**From Site Visit Done:**
- `Token Paid` → Booked
- `Customer Not Interested` → Closed (Not Interested)
- `Decision Followup Exhausted` → Closed (Unreachable)

**Universal overrides (available from any active state):**
- `Opt Out` → Closed (Opted Out)
- `Marked Broker` → Closed (Broker)

---

## 2. Layout Rules (Section 9 conditional visibility)

**Path:** Setup → Customization → Modules → Leads → Layouts → Standard → Layout Rules

Create these rules:

### Rule 1: Show Callback_Source only when Status = Callback Pending
- Trigger field: **Status**
- Condition: Status = "Callback Pending"
- Action: Show field **Callback_Source**

### Rule 2: Show Closure_Reason only when Stage = Closed
- Trigger field: **Stage**
- Condition: Stage = "Closed"
- Action: Show field **Closure_Reason**

### Rule 3: Show site-visit fields only when Stage ≥ Site Visit Scheduled
- Trigger field: **Stage**
- Condition: Stage IN ("Site Visit Scheduled", "Site Visit Done", "Booked")
- Action: Show fields: Site_Visit_Date, Site_Visit_Slot, Site_Visit_Confirmation_Source, Site_Visit_Attended, Site_Visit_Attended_At

### Rule 4: Show booking fields only when Stage = Booked
- Trigger field: **Stage**
- Condition: Stage = "Booked"
- Action: Show fields: Booking_Token_Paid, Booking_Amount, Booking_Date

---

## 3. Validation Rules (Section 4.1 — Stage × Status matrix)

**Path:** Setup → Customization → Modules → Leads → Validation Rules

| Stage | Allowed Status values |
|---|---|
| New Lead | Outreach Pending, Talking, Awaiting Reply, No Response, Callback Pending |
| In Conversation | Outreach Pending, Talking, Awaiting Reply, No Response, Callback Pending |
| Site Visit Scheduled | Outreach Pending, Talking, Awaiting Reply, No Response (no Callback Pending) |
| Site Visit Done | Outreach Pending, Talking, Awaiting Reply, No Response, Callback Pending |
| Booked | (Status must be empty) |
| Closed | (Status must be empty) |

For each Stage, create a Validation Rule that blocks invalid Status values. The Vercel state machine respects this matrix but the Validation Rule ensures manual edits in CRM UI also stay clean.

---

## 4. Saved Views (Section 17)

**Path:** Leads module → top right "▼ All Open Leads" dropdown → "Create View"

Create these 13 views (filter only — no scripted logic):

### Operations dashboard
1. **🔥 Hot — not booked yet**
   - Filter: `Lead_Tier = Hot AND F_Site_Visit_Confirmed = false`
   - Columns: Name, Phone, Lead_Tier, Stage, Status, Predicted_Value_INR
   - Audience: Founders, ops

2. **📅 Visiting today**
   - Filter: `Site_Visit_Date = today AND Stage = "Site Visit Scheduled"`
   - Sort: Site_Visit_Slot asc

3. **⚠️ Visit risk (no 3h reminder)**
   - Filter: `Site_Visit_Date = today AND F_Site_Visit_Reminder_3h_Sent = false AND Stage = "Site Visit Scheduled"`

4. **📞 Call failed, WA worked**
   - Filter: `F_Call_Connected = false AND F_WA_Replied = true AND F_Call_Attempted = true`

5. **📵 WA failed, Call worked**
   - Filter: `F_WA_Replied = false AND F_Call_Connected = true AND F_WA_Template_Sent = true`

6. **❄️ Cooled — In Conversation**
   - Filter: `Stage = "In Conversation" AND Status = "No Response"`

7. **🆘 Awaiting recovery**
   - Filter: `Status = "No Response" AND Active_Cadence = "recovery"`

8. **💸 Booked this week**
   - Filter: `Stage = "Booked" AND Booking_Date >= start_of_week`

9. **🚫 Brokers (suppression list)**
   - Filter: `F_Marked_Broker = true`

10. **🏚️ Closed — re-engagement candidates**
    - Filter: `Stage = "Closed" AND Closure_Reason = "Unreachable" AND Closed_At >= today - 14 days AND F_Opt_Out_All = false`

### Bot performance
11. **Top LLM cost leads**
    - Sort: LLM_Cost_Total_Micros desc — top 50

12. **High-classifier-cost cohort**
    - Filter: `Bot_Last_Cost_Path = "llm" AND Bot_Turn_Count > 8`

13. **Stalled in Awaiting Reply**
    - Filter: `Status = "Awaiting Reply" AND Status_Updated_At < now() - 60 minutes`

---

## 5. Workflow Rules — OPTIONAL (Vercel handles most)

Per the hybrid approach decision, **most workflow logic lives in Vercel** (state machine, cadences, lead scoring, ad events). You don't need to recreate WR-01 to WR-10 in Zoho — they're implemented in code.

**Two exceptions where you MIGHT want Zoho-side rules** (only for redundancy / UI feedback):

### Optional WR-A: Lead Created → Confirm in Zoho UI
- Trigger: Record create on Leads
- Condition: Stage = "New Lead"
- Action: Send internal email notification to ops "New lead: {Name} for {ASBL_Project}"

### Optional WR-B: Booking Confirmed → Confirm in Zoho UI  
- Trigger: Field update on Stage
- Condition: Stage changes to "Booked"
- Action: Send internal email to sales team "🎉 Lead booked: {Name} — ₹{Booking_Amount}"

Both are pure notifications — the actual state machine + cadence logic runs in Vercel.

---

## 6. Verify everything is set up

After completing the above, verify:

```bash
# Check Blueprint exists
curl "https://www.zohoapis.in/crm/v3/settings/automation/blueprint?module=Leads" \
  -H "Authorization: Zoho-oauthtoken $ACCESS_TOKEN"

# Run our audit endpoint
curl "https://growth-relay.asbl.in/api/chat-history?action=zoho-audit&secret=$INHOUSE_POSTHOOK_SECRET" \
  | python3 -m json.tool
```

Expect:
- ✅ 85+ ASBL spec fields
- ✅ Blueprint named "ASBL Loft Lead Journey" with 6 states
- ✅ Layout rules visible on lead detail page

---

## 7. Environment variables — for ad platform feedback to actually fire

Without these env vars, `fireAdEvent()` will log "would have fired" but won't POST to Meta/Google. Add via Vercel → Settings → Environment Variables:

### Meta CAPI
```
META_PIXEL_ID=                         # Pixel/Dataset ID from Events Manager
META_CAPI_ACCESS_TOKEN=                # Conversions API access token
META_CAPI_TEST_EVENT_CODE=             # Optional, "TEST123" for Test Events tab
```

How to get them:
1. Meta Business Manager → Events Manager → ASBL Pixel
2. Settings → Conversions API → Generate Access Token
3. Copy Pixel ID + Access Token

### Google Ads OCI
```
GOOGLE_ADS_CUSTOMER_ID=                 # 10-digit, no dashes (e.g. 1234567890)
GOOGLE_ADS_DEVELOPER_TOKEN=             # From Google Ads → Tools → API Center
GOOGLE_ADS_OAUTH_CLIENT_ID=             # Google Cloud OAuth 2.0 client ID
GOOGLE_ADS_OAUTH_CLIENT_SECRET=         # Google Cloud OAuth 2.0 client secret
GOOGLE_ADS_OAUTH_REFRESH_TOKEN=         # Offline refresh token (one-time generation)

GOOGLE_OCI_CONVERSION_ACTION_LEAD_QUALIFIED=         # e.g. "123456789" (just the ID, not full path)
GOOGLE_OCI_CONVERSION_ACTION_SITE_VISIT_SCHEDULED=
GOOGLE_OCI_CONVERSION_ACTION_SITE_VISIT_COMPLETED=
GOOGLE_OCI_CONVERSION_ACTION_BOOKING_TOKEN_PAID=
GOOGLE_OCI_CONVERSION_ACTION_LOST=
```

How to get them:
1. Google Ads → Tools → Conversions → "+ New conversion action" for each event type (use "Offline conversion")
2. Note the Conversion Action ID from URL or details page
3. For OAuth: Google Cloud Console → APIs & Services → Credentials → Create OAuth 2.0 Client → Generate refresh token via [Google's OAuth Playground](https://developers.google.com/oauthplayground/)
4. Google Ads Developer Token: Tools → API Center → Apply if not already approved

Once env vars are set, **push an empty commit to redeploy** (env vars don't hot-swap):
```
git commit --allow-empty -m "chore: redeploy with Meta CAPI + Google OCI credentials"
git push
```

---

## 8. Run the legacy lead migration

Once Phase 1 fields are in (already done) and Blueprint is set up:

```bash
# Migrate 200 leads at a time, paginate through all
curl -X POST "https://growth-relay.asbl.in/api/chat-history?action=asbl-spec-migrate-legacy&secret=$INHOUSE_POSTHOOK_SECRET&max=200&page=1" \
  | python3 -m json.tool
```

Output:
```
{
  "scanned": 200,
  "migrated": 150,
  "skipped_already_migrated": 30,
  "skipped_no_mapping": 20,
  "failed": 0
}
```

Re-run with `&page=2`, `&page=3` etc. until `migrated + skipped_already_migrated = scanned` (no new ones to process).

Mapping reference (spec section 4.2):

| Legacy Lead_Status | → Stage | → Status | + extras |
|---|---|---|---|
| Fresh / NA / Not Called | New Lead | Outreach Pending | |
| Lead Initiated | New Lead | Awaiting Reply | |
| CF / Connected / Contacted | In Conversation | Talking | |
| SF / No Response / No Answer | In Conversation | No Response | |
| CB1 | In Conversation | Callback Pending | Callback_Source=Customer Requested |
| CB2 | In Conversation | Callback Pending | Callback_Source=System Scheduled |
| Pre Site | Site Visit Scheduled | Awaiting Reply | |
| Virtual Tour | Site Visit Done | Awaiting Reply | |
| Not Interested | Closed | (terminal) | Closure_Reason=Not Interested |
| Booked | Booked | (terminal) | |
| Closed / Unreachable | Closed | (terminal) | Closure_Reason=Unreachable |

---

## 9. Add a Vercel cron for cadence step processor

**Vercel project Settings → Cron Jobs → Add:**

| Path | Schedule | Comment |
|---|---|---|
| `/api/cron/followup` | `0 * * * *` (hourly) | Already configured; we extend it |

The cadence processor needs to be added to the existing `/api/cron/followup` handler — it should:
1. Query Zoho for leads where `Next_Action_At <= now AND Active_Cadence != "none"`
2. For each lead, run the current cadence step's action (WA template, voice dial, reminder)
3. Call `advanceCadence(leadId, lead)` to move to the next step

This is the only piece of Phase 5 that's not auto-deployable — needs to be wired into the existing cron.

---

## Summary — what you (the human) need to do

| Task | Time | Owner |
|---|---|---|
| 1. Blueprint redesign with 6 states + transitions | 20 min | You |
| 2. Layout rules (4 rules) | 5 min | You |
| 3. Validation rules (1 per stage) | 10 min | You |
| 4. Saved views (13 views) | 15 min | You |
| 5. Optional Workflow rules (notifications) | 5 min | You — optional |
| 6. Meta CAPI credentials | 30 min | Marketing/Ops |
| 7. Google Ads OCI credentials | 1 hour | Marketing/Ops |
| 8. Run migration script | 5 min | You |
| 9. Vercel cron extension for cadence processor | 30 min | Me — needs your go-ahead |

Total non-coding work: ~3 hours spread across Marketing/Ops + you.

After this, the full ASBL Loft automated lead journey is live end-to-end.
