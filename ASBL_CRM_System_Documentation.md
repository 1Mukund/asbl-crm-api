# ASBL Zoho CRM System Documentation

## Overview

This document describes the complete CRM setup built for ASBL on Zoho CRM, including lead management, Meta integration, AI calling via Arrowhead, and the callback data flow.

---

## 1. CRM Structure

### Module: Leads

All incoming leads are stored in the **Leads** module with the following custom fields:

| Field | Type | Purpose |
|---|---|---|
| MLID | Text | Unique user identifier (e.g. 1001, 1002). Same across projects if phone matches |
| Lead-Id | Text | Meta's Social Lead ID — unique per form submission |
| Project | Picklist | LOFT, SPECTRA, BROADWAY, LANDMARK, LEGACY |
| Born Date | Date | Date the lead entered the CRM |
| Questionnaire | Multi-line Text | Comments/answers from Meta form |
| Campaign Name | Text | Meta campaign name — used for auto project assignment |
| Call Status | Picklist | Connected / Not Connected / Pending |
| Call Outcome | Picklist | Connected, Not Connected, Pre Site, Virtual Walkthrough, Share Brochure, Call For Other Project |
| Call Duration | Text | Duration of call in seconds |
| Call Date Time | DateTime | When the call was completed |
| Call Notes | Multi-line Text | AI call summary, budget, size preference, intent |
| Call History | Multi-line Text | Full log of all calls on this lead |
| WhatsApp Status | Picklist | Sent / Replied / No Reply |
| Last Message Date | DateTime | Last WhatsApp interaction date |
| Chat History | Multi-line Text | Full WhatsApp conversation log |

---

## 2. Lead ID Logic

### MLID (Meta Lead ID)
- Assigned automatically when a lead is created
- Starts from **1001** and increments
- **Phone number based matching** — if the same phone number exists in CRM, the new lead gets the same MLID
- This means one person across multiple projects will have the same MLID

### Lead-Id
- Stores Meta's Social Lead ID
- Unique per form submission
- Used as `external_journey_id` when communicating with Arrowhead

---

## 3. Meta Integration (LeadChain)

### Tool: LeadChain (Zoho Marketplace)

**Flow:**
```
Meta Lead Ad Form → LeadChain → Zoho CRM Leads Module
```

**Field Mapping:**

| Meta Field | Zoho CRM Field |
|---|---|
| Full Name | First Name |
| Email | Email |
| Phone Number | Phone Number |
| Campaign Name | Campaign Name |
| Social Lead ID | Lead-Id |
| Lead Source | FIM Forms (static) |

**Project Auto-Assignment:**
- Campaign Name field is mapped from Meta
- A Zoho Workflow reads Campaign Name and sets the Project field
- Logic: if campaign name contains "LOFT" → Project = LOFT, and so on for all 5 projects

---

## 4. MLID Auto-Assignment Workflow

**Trigger:** Lead Created

**Action:** Deluge Function (`assign_mlid_leadid`)

**Logic:**
1. Read phone number of new lead
2. Search all existing leads for same phone number
3. If match found → assign same MLID
4. If no match → generate new MLID (max existing + 1, starting from 1001)
5. Also sets Born Date = today's date

---

## 5. Arrowhead AI Calling Integration

### Auto Call on Lead Create

**Trigger:** Lead Created  
**Condition:** Phone Number starts with `91` (India) OR starts with `1` (US)  
**Action:** Webhook to Arrowhead API

**Arrowhead API:**
```
POST https://api.agent.arrowhead.team/api/v2/public/domain/{domain_id}/campaign/{campaign_id}/schedule
```

**Payload sent to Arrowhead:**
```json
{
  "customer_full_name": "Lead Name",
  "mobile_number": "919XXXXXXXXX",
  "external_customer_id": "MLID",
  "external_schedule_id": "Meta Lead ID",
  "external_journey_id": "Meta Lead ID",
  "input_variables": {
    "project": "LOFT",
    "budget": "5 Crore",
    "comments": "Questionnaire answers",
    "size_preference": "10000 Sqft",
    "customer_name": "Lead Name"
  }
}
```

**Name Handling:** If name is blank or contains phone number format (+91xxx), "Unknown" is sent to Arrowhead

**Non-Indian/Non-US numbers:** No auto call — Lazybot WhatsApp message will be triggered instead (integration pending)

---

### Manual Call Button

A **"Call with Arrowhead"** button is available on every lead record (Detail View).

- Click the button → Arrowhead immediately schedules a call
- Works for any lead regardless of phone number prefix
- Same payload as auto trigger

---

### Bulk Call Trigger

A **"Bulk Call with Arrowhead"** button is available in the Leads list view (Mass Action Menu).

- Select multiple leads → click button → all selected leads get calls triggered
- Skips leads with no phone number

---

## 6. Arrowhead Callback Flow

After each call, Arrowhead sends a POST callback to:

```
https://script.google.com/macros/s/AKfycbzNnWGs_.../exec
```

This is a Google Apps Script relay that:
1. Receives Arrowhead's callback payload
2. Gets a fresh Zoho OAuth token
3. Finds the lead using `external_journey_id` (Meta Lead ID) or MLID
4. Updates the lead in Zoho CRM

**Fields updated per callback:**

| Arrowhead Field | Zoho Field |
|---|---|
| call_result_slug | Call Status + Call Outcome |
| call_duration_in_secs | Call Duration |
| current_datetime_ist | Call Date Time |
| question_answers.call_summary | Call Notes |
| question_answers.budget | Call Notes |
| question_answers.size_preference | Call Notes |
| question_answers.intent | Call Notes |

**Call Outcome Mapping:**

| Arrowhead Slug | Zoho Call Outcome |
|---|---|
| no_answer | Not Connected |
| connected / auto_callback / not_interested | Connected |
| pre_site | Pre Site |
| virtual_walkthrough | Virtual Walkthrough |
| share_brochure | Share Brochure |
| call_for_other_project | Call For Other Project |

**Multiple Calls:** Every callback appends a new entry to the `Call History` field — full log of all calls is preserved.

---

## 7. Project Auto-Assignment Workflow

**Trigger:** Lead Created or Edited  
**Action:** Deluge Function (`auto_assign_project`)

**Logic:**
- Reads `Campaign Name` field
- If contains "loft" → Project = LOFT
- If contains "spectra" → Project = SPECTRA
- If contains "broadway" → Project = BROADWAY
- If contains "landmark" → Project = LANDMARK
- If contains "legacy" → Project = LEGACY

---

## 8. Pending Integrations

### Lazybot (WhatsApp AI)
- Trigger: After Arrowhead call completes
  - If **Connected** → Lazybot sends relationship management message
  - If **Not Connected** → Lazybot sends follow-up message
- For non-Indian/non-US numbers → Lazybot triggers directly on lead create
- Chat data (WhatsApp Status, Last Message Date, Chat History) to be stored in Zoho lead record

---

## 9. Technical References

| Component | Value |
|---|---|
| Zoho Org ID | org60069991778 |
| Arrowhead Domain ID | 932f86fc-ed03-42d5-a127-7dfc63216a8a |
| Arrowhead Campaign ID | a0a15c01-2aa2-40b3-9e46-94109131b17b |
| Callback Relay URL | https://script.google.com/macros/s/AKfycbzNnWGs_09WPjys2dVkktxjKx96v6GZbpojBUzeYcoNnUT6t5l-s7hR5r3qkOS8rvf2dA/exec |
| Zoho API Region | zoho.in |
