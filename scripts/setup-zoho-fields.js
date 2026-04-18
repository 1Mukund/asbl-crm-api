/**
 * ASBL CRM — Zoho Custom Field Setup Script
 * Run once: node scripts/setup-zoho-fields.js
 *
 * Creates all required custom fields in Zoho CRM Leads module.
 * Safe to re-run — skips fields that already exist.
 */

const axios = require("axios");

const TOKEN_URL = "https://accounts.zoho.in/oauth/v2/token";
const API_BASE  = "https://www.zohoapis.in/crm/v3";

// Load from .env manually
require("fs").readFileSync(".env", "utf8").split("\n").forEach(line => {
  const [k, ...v] = line.split("=");
  if (k && v.length) process.env[k.trim()] = v.join("=").trim();
});

const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;

// ─── All custom fields to create ────────────────────────────────────────────

const FIELDS_TO_CREATE = [
  // Identity
  { field_label: "Master Lead ID",      api_name: "Master_Lead_ID",      data_type: "text",     length: 50  },
  { field_label: "Project Lead ID",     api_name: "Project_Lead_ID",     data_type: "text",     length: 50  },
  { field_label: "Source Lead ID",      api_name: "Source_Lead_ID",      data_type: "text",     length: 100 },

  // Attribution
  { field_label: "Ad Set Name",         api_name: "Ad_Set_Name",         data_type: "text",     length: 200 },
  { field_label: "Ad Name",             api_name: "Ad_Name",             data_type: "text",     length: 200 },
  { field_label: "UTM Source",          api_name: "UTM_Source",          data_type: "text",     length: 100 },
  { field_label: "UTM Medium",          api_name: "UTM_Medium",          data_type: "text",     length: 100 },
  { field_label: "UTM Campaign",        api_name: "UTM_Campaign",        data_type: "text",     length: 200 },
  { field_label: "UTM Content",         api_name: "UTM_Content",         data_type: "text",     length: 200 },
  { field_label: "UTM Term",            api_name: "UTM_Term",            data_type: "text",     length: 200 },
  { field_label: "Lead Received At",    api_name: "Lead_Received_At",    data_type: "datetime"              },

  // Project & Interest
  {
    field_label: "ASBL Project",
    api_name: "ASBL_Project",
    data_type: "picklist",
    pick_list_values: [
      { display_value: "LOFT",     sequence_number: 1 },
      { display_value: "SPECTRA",  sequence_number: 2 },
      { display_value: "BROADWAY", sequence_number: 3 },
      { display_value: "LANDMARK", sequence_number: 4 },
      { display_value: "LEGACY",   sequence_number: 5 },
    ],
  },
  { field_label: "Lead Budget",         api_name: "Lead_Budget",         data_type: "text",     length: 100 },
  { field_label: "Size Preference",     api_name: "Size_Preference",     data_type: "text",     length: 100 },
  { field_label: "Floor Preference",    api_name: "Floor_Preference",    data_type: "text",     length: 100 },
  { field_label: "Possession Timeline", api_name: "Possession_Timeline", data_type: "text",     length: 100 },
  {
    field_label: "Purchase Purpose",
    api_name: "Purchase_Purpose",
    data_type: "picklist",
    pick_list_values: [
      { display_value: "Self Use",   sequence_number: 1 },
      { display_value: "Investment", sequence_number: 2 },
    ],
  },
  { field_label: "Lead Comments",       api_name: "Lead_Comments",       data_type: "textarea"              },

  // Web Tracking
  { field_label: "First Page Visited",  api_name: "First_Page_Visited",  data_type: "text",     length: 500 },
  { field_label: "Last Page Visited",   api_name: "Last_Page_Visited",   data_type: "text",     length: 500 },
  { field_label: "Total Page Views",    api_name: "Total_Page_Views",    data_type: "integer"               },
  { field_label: "Time Spent Minutes",  api_name: "Time_Spent_Minutes",  data_type: "decimal"               },
  { field_label: "Referrer URL",        api_name: "Referrer_URL",        data_type: "text",     length: 500 },

  // AI Calling
  {
    field_label: "Call Status",
    api_name: "Call_Status",
    data_type: "picklist",
    pick_list_values: [
      { display_value: "Pending",       sequence_number: 1 },
      { display_value: "Connected",     sequence_number: 2 },
      { display_value: "Not Connected", sequence_number: 3 },
    ],
  },
  {
    field_label: "Call Outcome",
    api_name: "Call_Outcome",
    data_type: "picklist",
    pick_list_values: [
      { display_value: "Connected",            sequence_number: 1 },
      { display_value: "Not Connected",        sequence_number: 2 },
      { display_value: "Pre Site",             sequence_number: 3 },
      { display_value: "Virtual Walkthrough",  sequence_number: 4 },
      { display_value: "Share Brochure",       sequence_number: 5 },
      { display_value: "Call For Other Project", sequence_number: 6 },
    ],
  },
  { field_label: "Last Call Date",      api_name: "Last_Call_Date",      data_type: "datetime"              },
  { field_label: "Call Duration",       api_name: "Call_Duration",       data_type: "integer"               },
  { field_label: "Call Summary",        api_name: "Call_Summary",        data_type: "textarea"              },
  { field_label: "Call History",        api_name: "Call_History",        data_type: "textarea"              },

  // WhatsApp
  {
    field_label: "WhatsApp Status",
    api_name: "WhatsApp_Status",
    data_type: "picklist",
    pick_list_values: [
      { display_value: "Sent",      sequence_number: 1 },
      { display_value: "Delivered", sequence_number: 2 },
      { display_value: "Read",      sequence_number: 3 },
      { display_value: "Replied",   sequence_number: 4 },
      { display_value: "No Reply",  sequence_number: 5 },
    ],
  },
  { field_label: "Last WhatsApp Date",     api_name: "Last_WhatsApp_Date",     data_type: "datetime" },
  { field_label: "WhatsApp Chat History",  api_name: "WhatsApp_Chat_History",  data_type: "textarea" },
];

// ─── Main ────────────────────────────────────────────────────────────────────

async function getToken() {
  const res = await axios.post(TOKEN_URL, null, {
    params: { grant_type: "refresh_token", client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, refresh_token: ZOHO_REFRESH_TOKEN },
  });
  return res.data.access_token;
}

async function getExistingFields(token) {
  const res = await axios.get(`${API_BASE}/settings/fields?module=Leads`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  return new Set((res.data.fields || []).map(f => f.api_name));
}

async function createField(token, field) {
  try {
    const res = await axios.post(
      `${API_BASE}/settings/fields?module=Leads`,
      { fields: [field] },
      { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
    );
    const result = res.data?.fields?.[0];
    if (result?.status === "success") {
      console.log(`  ✅ Created: ${field.field_label} (${field.api_name})`);
    } else {
      console.log(`  ⚠️  Unexpected response for ${field.field_label}:`, JSON.stringify(result));
    }
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    console.log(`  ❌ Failed: ${field.field_label} →`, JSON.stringify(detail));
  }
}

async function main() {
  console.log("🚀 ASBL CRM — Zoho Custom Field Setup\n");

  const token = await getToken();
  console.log("✅ Token acquired\n");

  const existing = await getExistingFields(token);
  console.log(`📋 Found ${existing.size} existing fields in Leads module\n`);

  console.log("Creating custom fields...\n");
  for (const field of FIELDS_TO_CREATE) {
    if (existing.has(field.api_name)) {
      console.log(`  ⏭️  Skipped (already exists): ${field.field_label}`);
      continue;
    }
    await createField(token, field);
    await new Promise(r => setTimeout(r, 300)); // rate limit
  }

  console.log("\n✅ Done! Now add these fields to your Zoho Leads layout:");
  console.log("   Settings → Modules & Fields → Leads → Layouts → Standard");
}

main().catch(err => {
  console.error("Fatal error:", err.response?.data ?? err.message);
  process.exit(1);
});
