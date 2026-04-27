# ASBL CRM — Zoho Deluge Functions

All functions go to: **Zoho CRM → Setup → Developer Space → Functions**

---

## FUNCTION 1: triggerArrowheadCall (FIXED)

**Name:** `automation.triggerArrowheadCall`  
**Description:** Triggers an Arrowhead AI call for a lead. Auto-increments attempt count.  
**Arguments:** `string lead_id`

> **What was wrong:** `zoho.crm.updateRecord` needs the record ID as a **Long**, not a string. Also datetime format for Zoho must use `zoho.currenttime` correctly.

```deluge
string automation.triggerArrowheadCall(string lead_id)
{
    // ── Fetch lead ────────────────────────────────────────────────────────────
    lead = zoho.crm.getRecordById("Leads", lead_id.toLong());
    phone = lead.get("Mobile");
    full_name = ifnull(lead.get("First_Name"), "") + " " + ifnull(lead.get("Last_Name"), "");
    project = ifnull(lead.get("ASBL_Project"), "");
    mlid = ifnull(lead.get("Master_Lead_ID"), "");
    plid = ifnull(lead.get("Project_Lead_ID"), "");

    // ── Phone validation: only +91 and +1 ────────────────────────────────────
    if(!phone.startsWith("+91") && !phone.startsWith("+1"))
    {
        return "SKIP: Non-callable country code for " + phone;
    }

    // ── Time check: 9AM–9PM IST ───────────────────────────────────────────────
    now_hour = zoho.currenttime.getHour();
    // zoho.currenttime is in UTC — IST = UTC+5:30, so IST hour = UTC hour + 5 (approx)
    ist_hour = (now_hour + 5) % 24;
    if(ist_hour < 9 || ist_hour >= 21)
    {
        return "SKIP: Outside calling hours (IST " + ist_hour + ":xx)";
    }

    // ── Increment call attempt count ──────────────────────────────────────────
    current_attempts = lead.get("Call_Attempt_Count");
    if(isNull(current_attempts))
    {
        current_attempts = 0;
    }
    new_attempt = current_attempts.toLong() + 1;
    external_schedule_id = plid + "-call-" + new_attempt;

    // ── Build Arrowhead payload ───────────────────────────────────────────────
    input_vars = Map();
    input_vars.put("customer_name", full_name.trim());
    input_vars.put("customer_phone", phone);
    input_vars.put("project_name", project);
    input_vars.put("mlid", mlid);
    input_vars.put("plid", plid);

    payload = Map();
    payload.put("phone_number", phone);
    payload.put("agent_id", "ag_crbk86r23fbfdc13f3f");
    payload.put("retell_llm_dynamic_variables", input_vars);
    payload.put("external_schedule_id", external_schedule_id);
    // _zoho_lead_id is stripped by the relay before forwarding to Arrowhead
    // — used only to trigger the "Lead Initiated" Blueprint transition
    payload.put("_zoho_lead_id", lead_id);

    // ── Call Arrowhead via Vercel relay ───────────────────────────────────────
    arrowhead_response = invokeurl
    [
        url: "https://asbl-crm-api.vercel.app/api/relay/arrowhead"
        type: POST
        parameters: payload.toString()
        headers: {"Content-Type": "application/json"}
    ];

    info "Arrowhead response: " + arrowhead_response;

    // ── Build update map for Zoho ─────────────────────────────────────────────
    now_str = zoho.currenttime.toString("yyyy-MM-dd'T'HH:mm:ssZ");

    update_map = Map();
    update_map.put("Call_Attempt_Count", new_attempt);
    update_map.put("Last_Call_At", now_str);
    update_map.put("Last_Arrowhead_Call_ID", external_schedule_id);
    update_map.put("Call_Status", "Not Called");

    // ── Update Zoho lead ──────────────────────────────────────────────────────
    update_resp = zoho.crm.updateRecord("Leads", lead_id.toLong(), update_map);
    info "Zoho update response: " + update_resp;

    return "OK: Call scheduled. Attempt #" + new_attempt + " | ID: " + external_schedule_id;
}
```

---

## FUNCTION 2: arrowheadPosthook (REST API Endpoint)

**Name:** `automation.arrowheadPosthook`  
**Return type:** `string`  
**Arguments:** None (reads from `request` object)

> After creating this function, expose it as a REST API:  
> **Setup → Developer Space → Functions → [this function] → REST API → Enable**  
> Copy the URL — give it to Arrowhead as the webhook/posthook URL.

```deluge
string automation.arrowheadPosthook()
{
    // ── Parse incoming webhook from Arrowhead ─────────────────────────────────
    body = request.get("body");
    info "Arrowhead posthook payload: " + body;

    external_schedule_id = body.get("external_schedule_id");
    call_outcome = body.get("call_status");           // connected / not_connected / busy / switched_off
    call_duration_sec = ifnull(body.get("duration_seconds"), 0);
    call_summary_text = ifnull(body.get("call_summary"), "");
    call_recording_url = ifnull(body.get("recording_url"), "");

    // Map Arrowhead status → Zoho picklist value
    zoho_status = "Not Connected";
    if(call_outcome == "connected") { zoho_status = "Connected"; }
    else if(call_outcome == "not_connected") { zoho_status = "Not Connected"; }
    else if(call_outcome == "busy") { zoho_status = "Busy"; }
    else if(call_outcome == "switched_off") { zoho_status = "Switched Off"; }
    else if(call_outcome == "pre_site") { zoho_status = "Pre Site"; }
    else if(call_outcome == "virtual_tour") { zoho_status = "Virtual Tour"; }
    else if(call_outcome == "not_interested") { zoho_status = "Not Interested"; }

    // ── Find the lead via external_schedule_id (matches Last_Arrowhead_Call_ID) ─
    // external_schedule_id format: PLID-call-N  e.g. 1002-BROADWAY-call-2
    search_response = zoho.crm.searchRecords("Leads", "Last_Arrowhead_Call_ID:equals:" + external_schedule_id);
    info "Search response: " + search_response;

    if(isNull(search_response) || search_response.size() == 0)
    {
        return "{\"status\":\"error\",\"message\":\"Lead not found for ID: " + external_schedule_id + "\"}";
    }

    lead = search_response.get(0);
    lead_id = lead.get("id");

    // ── Update Zoho lead ──────────────────────────────────────────────────────
    call_duration_min = call_duration_sec.toDecimal() / 60;

    update_map = Map();
    update_map.put("Call_Status", zoho_status);
    update_map.put("Call_Duration", call_duration_sec.toLong());
    update_map.put("Call_Summary", call_summary_text);

    // If connected, move Blueprint stage to "Contacted"
    if(zoho_status == "Connected")
    {
        update_map.put("Stage", "Contacted");
    }

    // If not interested, move Blueprint stage
    if(zoho_status == "Not Interested")
    {
        update_map.put("Stage", "Not Interested");
    }

    update_resp = zoho.crm.updateRecord("Leads", lead_id.toLong(), update_map);
    info "Zoho posthook update: " + update_resp;

    return "{\"status\":\"ok\",\"lead_id\":\"" + lead_id + "\",\"call_status\":\"" + zoho_status + "\"}";
}
```

---

## FUNCTION 3: bulkTriggerArrowheadCalls (Bulk Action)

**Name:** `automation.bulkTriggerArrowheadCalls`  
**Arguments:** `string ids` (comma-separated lead IDs passed by Zoho bulk action)

> After creating this function, go to:  
> **Setup → Customization → Modules → Leads → Buttons & Links → Add Button**  
> - Name: "Trigger Arrowhead Calls"  
> - Where to show: List View  
> - Action type: Function  
> - Select: `automation.bulkTriggerArrowheadCalls`

```deluge
string automation.bulkTriggerArrowheadCalls(string ids)
{
    id_list = ids.toList(",");
    success_count = 0;
    skip_count = 0;
    fail_count = 0;
    results = List();

    for each lead_id in id_list
    {
        lead_id_clean = lead_id.trim();
        if(lead_id_clean.length() > 0)
        {
            result = automation.triggerArrowheadCall(lead_id_clean);
            if(result.startsWith("OK"))
            {
                success_count = success_count + 1;
            }
            else if(result.startsWith("SKIP"))
            {
                skip_count = skip_count + 1;
            }
            else
            {
                fail_count = fail_count + 1;
            }
            results.add(lead_id_clean + ": " + result);
        }
    }

    summary = "Bulk call trigger complete.\nScheduled: " + success_count + 
              "\nSkipped: " + skip_count + 
              "\nFailed: " + fail_count;
    info summary;
    return summary;
}
```

---

## FUNCTION 4: sendPeriskopeMessage

**Name:** `automation.sendPeriskopeMessage`  
**Arguments:** `string lead_id`, `string message_type`

> `message_type` options: `initial_greeting`, `brochure`, `price_sheet`, `site_visit_slots`, `followup`

```deluge
string automation.sendPeriskopeMessage(string lead_id, string message_type)
{
    lead = zoho.crm.getRecordById("Leads", lead_id.toLong());
    phone = lead.get("Mobile");
    first_name = ifnull(lead.get("First_Name"), "");
    project = ifnull(lead.get("ASBL_Project"), "ASBL");

    // Build message based on type
    message_body = "";

    if(message_type == "initial_greeting")
    {
        message_body = "Hi " + first_name + "! 👋 This is Anandita from ASBL. I saw you were interested in " + project + ". I'd love to help you find your dream home. What would you like to know? 🏡";
    }
    else if(message_type == "brochure")
    {
        message_body = "Hi " + first_name + "! Here's the brochure for " + project + " as requested. Let me know if you have any questions! 📄";
    }
    else if(message_type == "price_sheet")
    {
        message_body = "Hi " + first_name + "! Here's the price sheet for " + project + ". We have some great options! Let me know your budget preference and I'll help narrow it down. 💰";
    }
    else if(message_type == "site_visit_slots")
    {
        message_body = "Hi " + first_name + "! We'd love to have you visit " + project + " in person. Here are our available slots this week. Which works best for you? 📅";
    }
    else if(message_type == "followup")
    {
        message_body = "Hi " + first_name + "! Just checking in on your interest in " + project + ". Have you had a chance to review the details we shared? Happy to answer any questions! 😊";
    }

    // ── Send via Periskope ────────────────────────────────────────────────────
    periskope_payload = Map();
    periskope_payload.put("phone_number", phone);
    periskope_payload.put("message", message_body);

    periskope_response = invokeurl
    [
        url: "https://api.periskope.app/v1/messages/send"
        type: POST
        parameters: periskope_payload.toString()
        headers: {"Authorization": "Bearer YOUR_PERISKOPE_API_KEY", "Content-Type": "application/json"}
    ];

    info "Periskope response: " + periskope_response;

    // ── Update Zoho fields ────────────────────────────────────────────────────
    now_str = zoho.currenttime.toString("yyyy-MM-dd'T'HH:mm:ssZ");

    update_map = Map();
    update_map.put("Whatsapp_Sent", true);
    update_map.put("Last_Whatsapp_At", now_str);

    if(message_type == "brochure")
    {
        update_map.put("Brochure_Sent", true);
    }
    else if(message_type == "price_sheet")
    {
        update_map.put("Price_Sheet_Sent", true);
    }
    else if(message_type == "site_visit_slots")
    {
        update_map.put("Site_Visit_Slots_Sent", true);
    }

    zoho.crm.updateRecord("Leads", lead_id.toLong(), update_map);

    return "OK: Message sent via Periskope | Type: " + message_type;
}
```

---

## FUNCTION 5: callAnandita (WhatsApp Incoming Reply Handler)

**Name:** `automation.callAnandita`  
**Arguments:** `string lead_id`, `string user_message`

> This is called by the Periskope webhook when a customer replies on WhatsApp.  
> Anandita LLM handles intent detection + response generation — no Gemini needed.

```deluge
string automation.callAnandita(string lead_id, string user_message)
{
    lead = zoho.crm.getRecordById("Leads", lead_id.toLong());
    first_name = ifnull(lead.get("First_Name"), "");
    project = ifnull(lead.get("ASBL_Project"), "");
    phone = lead.get("Mobile");

    // ── Build prompt for Anandita LLM ─────────────────────────────────────────
    system_context = "You are Anandita, a friendly and knowledgeable sales consultant for ASBL real estate. "
                   + "You help customers with information about " + project + ". "
                   + "Customer name: " + first_name + ". "
                   + "Keep responses concise and WhatsApp-friendly (under 150 words). "
                   + "Detect intent from the message: general / brochure / price / call_me / site_visit / not_interested. "
                   + "Reply ONLY with JSON: {\"response\": \"<your reply>\", \"intent\": \"<detected intent>\"}";

    anandita_payload = Map();
    anandita_payload.put("message", user_message);
    anandita_payload.put("system", system_context);
    anandita_payload.put("stream", false);

    anandita_response = invokeurl
    [
        url: "http://35.154.144.37:8080/api/chat/"
        type: POST
        parameters: anandita_payload.toString()
        headers: {"Content-Type": "application/json"}
    ];

    info "Anandita response: " + anandita_response;

    // ── Parse Anandita response ───────────────────────────────────────────────
    reply_text = "";
    detected_intent = "general";

    if(!isNull(anandita_response))
    {
        reply_text = anandita_response.get("response");
        detected_intent = ifnull(anandita_response.get("intent"), "general");
    }

    if(isNull(reply_text) || reply_text.length() == 0)
    {
        reply_text = "Hi " + first_name + "! Thank you for reaching out. Let me connect you with our team right away. 🏡";
        detected_intent = "general";
    }

    // ── Send reply via Periskope ──────────────────────────────────────────────
    periskope_payload = Map();
    periskope_payload.put("phone_number", phone);
    periskope_payload.put("message", reply_text);

    invokeurl
    [
        url: "https://api.periskope.app/v1/messages/send"
        type: POST
        parameters: periskope_payload.toString()
        headers: {"Authorization": "Bearer YOUR_PERISKOPE_API_KEY", "Content-Type": "application/json"}
    ];

    // ── Update Zoho lead with intent + WhatsApp tracking ──────────────────────
    now_str = zoho.currenttime.toString("yyyy-MM-dd'T'HH:mm:ssZ");

    update_map = Map();
    update_map.put("Last_Intent", detected_intent);
    update_map.put("Whatsapp_Replied", true);
    update_map.put("Last_Whatsapp_At", now_str);

    // Handle special intents
    if(detected_intent == "call_me")
    {
        update_map.put("High_Intent", true);
        update_map.put("High_Intent_Reason", "Customer requested callback via WhatsApp");
        // Auto-trigger an Arrowhead call
        automation.triggerArrowheadCall(lead_id);
    }
    else if(detected_intent == "site_visit")
    {
        update_map.put("High_Intent", true);
        update_map.put("High_Intent_Reason", "Customer requested site visit via WhatsApp");
    }
    else if(detected_intent == "not_interested")
    {
        update_map.put("Stage", "Not Interested");
    }
    else if(detected_intent == "brochure")
    {
        // Send brochure in next message
        automation.sendPeriskopeMessage(lead_id, "brochure");
    }
    else if(detected_intent == "price")
    {
        automation.sendPeriskopeMessage(lead_id, "price_sheet");
    }

    zoho.crm.updateRecord("Leads", lead_id.toLong(), update_map);

    return "OK: Anandita replied | Intent: " + detected_intent;
}
```

---

## FUNCTION 6: periskopeWebhook (REST API Endpoint)

**Name:** `automation.periskopeWebhook`  
**Arguments:** None (reads from `request`)

> Expose as REST API → give URL to Periskope as incoming message webhook.

```deluge
string automation.periskopeWebhook()
{
    body = request.get("body");
    info "Periskope webhook: " + body;

    from_phone = body.get("from");          // customer's phone e.g. +919876543210
    message_text = body.get("text");
    direction = body.get("direction");      // "inbound" or "outbound"

    // Only handle inbound messages
    if(direction != "inbound")
    {
        return "{\"status\":\"ok\",\"message\":\"outbound — ignored\"}";
    }

    // ── Find lead by phone ────────────────────────────────────────────────────
    search_response = zoho.crm.searchRecords("Leads", "Mobile:equals:" + from_phone);

    if(isNull(search_response) || search_response.size() == 0)
    {
        info "No lead found for phone: " + from_phone;
        return "{\"status\":\"ok\",\"message\":\"no lead found\"}";
    }

    lead = search_response.get(0);
    lead_id = lead.get("id").toString();

    // ── Call Anandita to process and reply ────────────────────────────────────
    result = automation.callAnandita(lead_id, message_text);
    info "Anandita result: " + result;

    return "{\"status\":\"ok\",\"result\":\"" + result + "\"}";
}
```

---

## SETUP GUIDE

### Step 1: Create Functions in Zoho

Go to: **Setup → Developer Space → Functions → + New Function**

Create each function above in order. For REST API functions (`arrowheadPosthook` and `periskopeWebhook`):
- After saving → click **REST API** tab → **Enable** → copy the URL

### Step 2: Workflow Rule — Auto-call on Lead Creation

**Setup → Automation → Workflow Rules → + New Rule**

| Field | Value |
|-------|-------|
| Module | Leads |
| Rule Name | Auto-trigger Arrowhead Call |
| Trigger | On a Record Action → Created |
| Condition | Call_Eligible = true (or leave blank for all) |
| Action | Custom Function → `automation.triggerArrowheadCall` |
| Arguments | `lead_id` = `${Leads.id}` |

> The function itself already checks for +91/+1 numbers and 9AM-9PM window, so it's safe to trigger for all leads.

### Step 3: Bulk Action Button — Manual Trigger

**Setup → Customization → Modules → Leads → Buttons & Links → + New Button**

| Field | Value |
|-------|-------|
| Button Name | Trigger Arrowhead Calls |
| Where to Show | List View |
| Action Type | Function |
| Function | `automation.bulkTriggerArrowheadCalls` |
| Argument | Pass `${Leads.id}` comma-separated |

### Step 4: API Keys to Replace

In all functions, replace these placeholders:
- `YOUR_ARROWHEAD_API_KEY` → your Arrowhead API key
- `YOUR_PERISKOPE_API_KEY` → your Periskope API key

### Step 5: Zoho Custom Connections (Recommended)

Instead of hardcoding API keys in functions, use **Zoho Connections**:
- **Setup → Developer Space → Connections → + Add Connection**
- Create connections for Arrowhead and Periskope
- Reference as `invokeurl [...] connection: "arrowhead_connection"`

---

## Field API Names Reference (for Deluge)

These are the exact API names to use in `zoho.crm.updateRecord`:

| Field Label | API Name (use in Deluge) |
|-------------|--------------------------|
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
| UTM Content | `UTM_Content` |
| UTM Term | `UTM_Term` |
| Lead Received At | `Lead_Received_At` |
| Lead Budget | `Lead_Budget` |
| Size Preference | `Size_Preference` |
| Floor Preference | `Floor_Preference` |
| Possession Timeline | `Possession_Timeline` |
| Purchase Purpose | `Purchase_Purpose` |
| Lead Comments | `Lead_Comments` |
| First Page Visited | `First_Page_Visited` |
| Last Page Visited | `Last_Page_Visited` |
| Total Page Views | `Total_Page_Views` |
| Time Spent Minutes | `Time_Spent_Minutes` |
| Referrer URL | `Referrer_URL` |
| Ad Set Name | `Ad_Set_Name` |
| Ad Name | `Ad_Name` |
