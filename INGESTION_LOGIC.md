# ASBL CRM — Lead Ingestion Logic

## Endpoints

| Endpoint | Source | Lead Source Value |
|---|---|---|
| POST /api/ingest/meta | Meta Ads via LeadChain | FIM Forms |
| POST /api/ingest/website | Website Form | Website Inquiry |

---

## Flow

```
Source → POST /api/ingest/{source}
              ↓
        Normalize phone
              ↓
        Parse name, detect project
              ↓
        Get/Create MLID (phone-based)
              ↓
        Dedup check (phone + project)
              ↓
        Same phone + same project? → UPDATE existing lead
        Same phone + new project?  → CREATE new lead (same MLID)
        New phone?                 → CREATE new lead (new MLID)
              ↓
        Push to Zoho CRM
              ↓
        Return { action, zoho_lead_id, mlid, plid }
```

---

## Phone Normalization Rules

| Input | Output | Logic |
|---|---|---|
| 9876543210 | 919876543210 | 10 digits → add 91 |
| 09876543210 | 919876543210 | 11 digits, starts 0 → remove 0, add 91 |
| 919876543210 | 919876543210 | 12 digits, starts 91 → keep |
| +919876543210 | 919876543210 | strip +, keep |
| 971501234567 | 971501234567 | UAE country code → keep |
| 14155550100 | 14155550100 | US → keep |

Indian number = starts with 91, length 12

---

## MLID Logic

```
1. Search Zoho: Mobile = normalized_phone
2. Found? → use existing Master_Lead_ID
3. Not found? → max(all Master_Lead_IDs) + 1 (starts at 1001)
```

Same person, multiple projects → same MLID always.

---

## PLID Logic

```
PLID = MLID + "-" + PROJECT
Example: 1001-LOFT, 1001-SPECTRA
```

---

## Dedup Rules

| Scenario | Action |
|---|---|
| New phone, any project | CREATE — new MLID, new PLID |
| Existing phone, new project | CREATE — same MLID, new PLID |
| Existing phone, same project | UPDATE — same MLID, same PLID |

---

## Project Detection

Auto-detected from (in order):
1. `utm_campaign` field
2. `page_url` field
3. `project` field (explicit)
4. `campaign_name` field (Meta)

Keywords: loft → LOFT, spectra → SPECTRA, broadway → BROADWAY, landmark → LANDMARK, legacy → LEGACY

---

## Meta Webhook Payload (expected)

```json
{
  "leadgen_id": "1234567890",
  "full_name": "Rahul Sharma",
  "phone_number": "+919876543210",
  "email": "rahul@gmail.com",
  "campaign_name": "LOFT_April_2026",
  "adset_name": "Hyderabad_25-45",
  "ad_name": "3BHK_Creative_1",
  "field_data": [
    { "name": "budget", "values": ["2Cr"] },
    { "name": "size_preference", "values": ["3BHK"] }
  ]
}
```

## Website Payload (expected)

```json
{
  "name": "Priya Singh",
  "phone": "9876543210",
  "email": "priya@gmail.com",
  "message": "Interested in 3BHK",
  "preferred_time": "morning",
  "utm_source": "google",
  "utm_medium": "cpc",
  "utm_campaign": "spectra_search",
  "page_url": "https://asbl.in/spectra",
  "time_spent": 3.5,
  "referrer": "https://google.com"
}
```

---

## Zoho Fields Mapped

| NormalizedLead Field | Zoho API Name |
|---|---|
| first_name | First_Name |
| last_name | Last_Name |
| mobile | Mobile |
| email | Email |
| lead_source | Lead_Source |
| mlid (generated) | Master_Lead_ID |
| plid (generated) | Project_Lead_ID |
| source_lead_id | Source_Lead_ID |
| campaign_name | Campaign_Name |
| ad_set_name | Ad_Set_Name |
| ad_name | Ad_Name |
| utm_source | UTM_Source |
| utm_medium | UTM_Medium |
| utm_campaign | UTM_Campaign |
| utm_content | UTM_Content |
| utm_term | UTM_Term |
| lead_received_at | Lead_Received_At |
| project | ASBL_Project |
| budget | Lead_Budget |
| size_preference | Size_Preference |
| floor_preference | Floor_Preference |
| possession_timeline | Possession_Timeline |
| purchase_purpose | Purchase_Purpose |
| lead_comments | Lead_Comments |
| first_page_visited | First_Page_Visited |
| last_page_visited | Last_Page_Visited |
| total_page_views | Total_Page_Views |
| time_spent_minutes | Time_Spent_Minutes |
| referrer_url | Referrer_URL |
