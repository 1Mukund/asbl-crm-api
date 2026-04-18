# ASBL CRM System — Context File

## Last Updated: 18 Apr 2026

---

## 1. Business Overview

Real estate company ASBL with multiple projects:
- LOFT
- SPECTRA
- BROADWAY
- LANDMARK
- LEGACY

---

## 2. Tech Stack

| Component | Tool |
|---|---|
| CRM | Zoho CRM (zoho.in region) |
| AI Calling | Arrowhead |
| WhatsApp AI | Lazybot (self-built) |
| Meta Integration | LeadChain (Zoho Marketplace) |
| Website Integration | Custom API (server-based) |
| Callback Relay | Google Apps Script |

---

## 3. Lead Sources

### Meta Ads (via LeadChain)
- Flow: Meta Lead Ad Form → LeadChain → Zoho CRM
- Phone stored in: `Mobile` field
- Layout used: Custom `Leads` layout (ID: `1288576000000594067`)
- `Lead_Id1` populated with Meta Social Lead ID
- `Lead_Source`: FIM Forms

### Website (via Custom API)
- Flow: Website Form → Custom API → Zoho CRM
- Phone stored in: `Phone` field (NOT Mobile — bug to fix)
- Layout used: Standard layout (ID: `1288576000000000167`) — WRONG, must use custom
- `Lead_Id1`: empty
- `Lead_Source`: Website Inquiry

---

## 4. Zoho CRM — Key Fields

| Field Label | API Name | Type | Notes |
|---|---|---|---|
| MLID | `MLID` | Text | Master Lead ID, phone-based, starts 1001 |
| Lead-Id | `Lead_Id1` | Text | Meta Social Lead ID (website leaves empty) |
| Project | `Project` | Picklist | LOFT/SPECTRA/BROADWAY/LANDMARK/LEGACY |
| Born Date | `Born_Date` | Date | Lead creation date |
| Questionnaire | `Questionnaire` | Textarea | Form comments |
| Campaign Name | `Campaign_Name` | Text | Meta campaign name |
| Phone Number (Mobile) | `Mobile` | Phone | Primary phone field |
| Phone | `Phone` | Phone | Secondary — website uses this wrongly |
| Call Status | `Call_Status` | Picklist | Connected/Not Connected |
| Call Outcome | `Call_Outcome` | Picklist | Connected/Not Connected/Pre Site/Virtual Walkthrough/Share Brochure/Call For Other Project |
| Call Duration | `Call_Duration` | Integer | Seconds |
| Call Date Time | `Call_Date_Time` | DateTime | |
| Call Notes | `Call_Notes` | Textarea | AI summary, budget, size, intent |
| Call History | `Call_History` | Textarea | Full log of all calls |
| Call Trigger Count | `Call_Trigger_Count` | Number | How many times call was triggered |
| Call Answer Count | `Call_Answer_Count` | Number | Connected calls |
| Call No Answer Count | `Call_No_Answer_Count` | Number | Not connected calls |
| Call Pickup Time | `Call_Pickup_Time` | Text | First connected call time |
| WhatsApp Status | `WhatsApp_Status` | Picklist | Sent/Replied/No Reply |
| Last Message Date | `Last_Message_Date` | DateTime | |
| Chat History | `Chat_History` | Textarea | Full WhatsApp conversation log |
| Budget | `Budget` | Text | |
| Sq.Ft Preferred | `Sq_Ft_Preffered` | Text | |

---

## 5. Zoho Org Details

| Key | Value |
|---|---|
| Org ID | org60069991778 |
| API Region | zoho.in |
| Custom Layout ID | 1288576000000594067 |
| Standard Layout ID | 1288576000000000167 (DO NOT USE) |

---

## 6. Zoho OAuth (Self Client)

| Key | Value |
|---|---|
| Client ID | 1000.B0AKGFC866W6ID59IQALF8D0UGIP1I |
| Client Secret | eef6a60091fb98ec3234ff1a91305aa92f3ff614e1 |
| Refresh Token | 1000.4a4fa18699d091348d63c6d811b7a651.44295cf8e60e2f6fd3f272ae93fb701b |
| Token URL | https://accounts.zoho.in/oauth/v2/token |
| API Base | https://www.zohoapis.in/crm/v3 |

---

## 7. Arrowhead AI Calling

| Key | Value |
|---|---|
| Domain ID | 932f86fc-ed03-42d5-a127-7dfc63216a8a |
| Campaign ID | a0a15c01-2aa2-40b3-9e46-94109131b17b |
| API Base | https://api.agent.arrowhead.team/api/v2/public |
| Bearer Token | 1928b882dbd4e043fcc61be27aa6eec00b925c1b5cdc4af592a623399571119a |
| Schedule Endpoint | /domain/{domain_id}/campaign/{campaign_id}/schedule |
| Callback URL | https://script.google.com/macros/s/AKfycbzNnWGs_09WPjys2dVkktxjKx96v6GZbpojBUzeYcoNnUT6t5l-s7hR5r3qkOS8rvf2dA/exec |

### Arrowhead Callback Payload Fields
- `external_journey_id` — our external_schedule_id
- `external_customer_id` — our MLID
- `call_result_slug` — no_answer/connected/auto_callback/not_interested/pre_site/virtual_walkthrough/share_brochure/call_for_other_project
- `call_duration_in_secs`
- `current_datetime_ist`
- `question_answers` — call_summary, budget, size_preference, intent
- NOTE: `mobile_number` NOT included in callback

### Call Result Mapping
| Arrowhead Slug | Zoho Call Status | Zoho Call Outcome |
|---|---|---|
| no_answer | Not Connected | Not Connected |
| connected | Connected | Connected |
| auto_callback | Connected | Connected |
| not_interested | Connected | Connected |
| pre_site | Connected | Pre Site |
| virtual_walkthrough | Connected | Virtual Walkthrough |
| share_brochure | Connected | Share Brochure |
| call_for_other_project | Connected | Call For Other Project |

---

## 8. Lazybot WhatsApp

| Key | Value |
|---|---|
| API Base | https://showplace-underhand-endurable.ngrok-free.dev/api/v1 |
| API Key | lzb_b296d613541755478c587ed952bb79fd41b569c8dfb89b67 |
| Active Session | 13a646d3-476c-4c6d-bb7b-e2ccca48a3ba |
| Send Endpoint | /messages/send |
| Webhook Events | message.received (inbound), message.created (outbound) |
| Webhook URL | Same as Arrowhead callback URL (Apps Script) |

---

## 9. Google Apps Script (Relay)

URL: `https://script.google.com/macros/s/AKfycbzNnWGs_09WPjys2dVkktxjKx96v6GZbpojBUzeYcoNnUT6t5l-s7hR5r3qkOS8rvf2dA/exec`

Handles two types of POST:
1. Arrowhead callback → updates Zoho lead call fields + triggers Lazybot message
2. Lazybot webhook → updates Chat_History in Zoho

Lead lookup order: MLID (external_customer_id) → Lead_Id1 → fallback

---

## 10. Zoho Workflows (Active)

| Workflow | Trigger | Action |
|---|---|---|
| Auto Assign MLID and Lead ID | Lead Created | Deluge: assign_mlid_leadid |
| Arrowhead Call Trigger | Lead Created (phone starts +91 or +1) | Deluge: auto_trigger_arrowhead_call |
| Auto Assign Project | Lead Created | Deluge: auto_assign_project |
| Lazybot First Touch | Lead Created | Deluge: lazybot_first_touch (skips Indian numbers) |

---

## 11. Zoho Deluge Functions

| Function | Category | Purpose |
|---|---|---|
| assign_mlid_leadid | Automation | Assigns MLID based on phone, Born Date |
| auto_trigger_arrowhead_call | Automation | Triggers Arrowhead call on lead create |
| auto_assign_project | Automation | Sets Project from Campaign Name |
| lazybot_first_touch | Automation | WhatsApp message for non-Indian numbers |
| trigger_arrowhead_call | Button | Manual call trigger from lead record |
| bulk_trigger_arrowhead_call | Button | Bulk call trigger from list view |
| lazybot_manual_trigger | Button | Manual WhatsApp send |
| lazybot_bulk_trigger | Button | Bulk WhatsApp send |
| arrowhead_callback | Standalone | Legacy — not in use |

---

## 12. Known Issues / To Fix

1. Website leads use `Phone` field instead of `Mobile` — dev needs to fix API payload
2. Website leads use Standard layout — dev needs to pass custom layout ID
3. Website leads have no `Lead_Id1` — need source lead ID from website
4. Multiple Arrowhead schedules appearing — Arrowhead groups by phone number in dashboard UI (not our bug)
5. `external_schedule_id` is required by Arrowhead API — cannot be omitted

---

## 13. Architecture Decision: Fresh Start

Decision taken on 18 Apr 2026:
- Deleted all test leads
- Deleted custom `Leads` layout — using `Standard` layout only (ID: `1288576000000000167`)
- All sources must use Standard layout
- Phone always in `Mobile` field
- MLID logic: same phone = same MLID across projects
- PLID logic: same phone + same project = same PLID, new project = new PLID

---

## 14. Zoho Custom Fields (Standard Layout)

### Identity
| API Name | Label | Type |
|---|---|---|
| `Master_Lead_ID` | Master Lead ID | Text |
| `Project_Lead_ID` | Project Lead ID | Text |

### Source & Attribution
| API Name | Label | Type |
|---|---|---|
| `Source_Lead_ID` | Source Lead ID | Text |
| `Campaign_Name` | Campaign Name | Text |
| `Ad_Set_Name` | Ad Set Name | Text |
| `Ad_Name` | Ad Name | Text |
| `UTM_Source` | UTM Source | Text |
| `UTM_Medium` | UTM Medium | Text |
| `UTM_Campaign` | UTM Campaign | Text |
| `UTM_Content` | UTM Content | Text |
| `UTM_Term` | UTM Term | Text |
| `Lead_Received_At` | Lead Received At | DateTime |

### Project & Interest
| API Name | Label | Type |
|---|---|---|
| `ASBL_Project` | ASBL Project | Picklist (LOFT/SPECTRA/BROADWAY/LANDMARK/LEGACY) |
| `Lead_Budget` | Lead Budget | Text |
| `Size_Preference` | Size Preference | Text |
| `Floor_Preference` | Floor Preference | Text |
| `Possession_Timeline` | Possession Timeline | Text |
| `Purchase_Purpose` | Purchase Purpose | Picklist (Self Use/Investment) |
| `Lead_Comments` | Lead Comments | Textarea |

### Web Tracking
| API Name | Label | Type |
|---|---|---|
| `First_Page_Visited` | First Page Visited | URL |
| `Last_Page_Visited` | Last Page Visited | URL |
| `Total_Page_Views` | Total Page Views | Integer |
| `Time_Spent_Minutes` | Time Spent Minutes | Double |
| `Referrer_URL` | Referrer URL | URL |

### AI Calling (Arrowhead)
| API Name | Label | Type |
|---|---|---|
| `Call_Status` | Call Status | Picklist (Pending/Connected/Not Connected) |
| `Call_Outcome` | Call Outcome | Picklist |
| `Last_Call_Date` | Last Call Date | DateTime |
| `Call_Duration` | Call Duration | Integer |
| `Call_Summary` | Call Summary | Textarea |
| `Call_History` | Call History | Textarea |

### WhatsApp (Lazybot)
| API Name | Label | Type |
|---|---|---|
| `WhatsApp_Status` | WhatsApp Status | Picklist (Sent/Delivered/Read/Replied/No Reply) |
| `Last_WhatsApp_Date` | Last WhatsApp Date | DateTime |
| `WhatsApp_Chat_History` | WhatsApp Chat History | Textarea |

### Standard Zoho Fields Used
| API Name | Label | Notes |
|---|---|---|
| `First_Name` | First Name | |
| `Last_Name` | Last Name | Required |
| `Mobile` | Phone Number | Primary phone — always 91XXXXXXXXXX |
| `Email` | Email | |
| `Lead_Source` | Lead Source | Meta Ads/Website/FIM/WhatsApp/Channel Partner |
