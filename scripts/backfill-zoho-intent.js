/**
 * backfill-zoho-intent.js
 *
 * Supabase se saare unique phones uthao jinka Last_Intent Zoho mein khali hai
 * → latest inbound message se intent detect karo
 * → Zoho mein Last_Intent update karo
 *
 * Run: node scripts/backfill-zoho-intent.js
 */

require("dotenv").config();

const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_API_BASE      = "https://www.zohoapis.in/crm/v3";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

// ── Intent detection (same as webhook) ───────────────────────────────────────
function detectIntent(message) {
  const msg = message.toLowerCase();

  if (/not interested|nahi chahiye|nhi chahiye|nahin chahiye|interested nahi|interest nahi|band karo|mat karo|mujhe nahi|mujhe nhi|no thanks|don't contact|do not contact|stop|unsubscribe|remove me|spam/i.test(msg))
    return "not_interested";

  if (/virtual tour|virtual visit|online tour|online dekh|zoom|video call|video pe dikhao|virtually|virtual/i.test(msg))
    return "virtual_tour";

  if (/site visit|visit karna|visit krna|aa jaun|aa sakta|aa rha|aa raha|physical|dekhna chahta|dekhna chahti|location|address|kahan hai|kahan h|show flat|flat dikhao|project dikhao|aaunga|aaungi|kal \d|aaj \d|sunday|saturday|monday|tuesday|wednesday|thursday|friday|parso|kal aata|kal aaunga|kal milte|baje aa|baje visit|time confirm|slot confirm|visit confirm|confirmed visit/i.test(msg))
    return "site_visit";

  if (/price|cost|rate|kitna|budget|amount|kitne ka|kitne mein|kaafi mehnga|affordable|emi|loan/i.test(msg))
    return "price";

  if (/brochure|pdf|details|information|info bhejo|send|bhej do|share karo/i.test(msg))
    return "brochure";

  if (/call karo|call me|call krna|phone karo|baat karna|baat krni|call back|callback/i.test(msg))
    return "call_me";

  if (/haan|ha |yes|interested|batao|bataiye|theek hai|thik hai|okay|ok|acha|accha|sure|zaroor/i.test(msg))
    return "general";

  return "general";
}

// ── Zoho: Get access token ────────────────────────────────────────────────────
async function getZohoToken() {
  const r = await fetch(
    `https://accounts.zoho.in/oauth/v2/token?grant_type=refresh_token&client_id=${ZOHO_CLIENT_ID}&client_secret=${ZOHO_CLIENT_SECRET}&refresh_token=${ZOHO_REFRESH_TOKEN}`,
    { method: "POST" }
  );
  const data = await r.json();
  if (!data.access_token) throw new Error("Zoho token error: " + JSON.stringify(data));
  return data.access_token;
}

// ── Supabase: Get all unique phones with their latest inbound message ─────────
async function getPhoneMessages() {
  // Get all inbound messages ordered by created_at desc
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/whatsapp_messages?direction=eq.inbound&order=created_at.desc&limit=1000`,
    {
      headers: {
        "apikey":        SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
      },
    }
  );
  const rows = await r.json();

  // Keep only latest message per phone
  const seen = new Map();
  for (const row of rows) {
    if (!seen.has(row.phone)) {
      seen.set(row.phone, row.message);
    }
  }
  return seen; // Map<phone, latestMessage>
}

// ── Zoho: Find lead by phone ──────────────────────────────────────────────────
async function findLeadByPhone(phone, token) {
  // Try Mobile
  const r = await fetch(
    `${ZOHO_API_BASE}/Leads/search?criteria=(Mobile:equals:${phone})&fields=id,Last_Intent,Mobile,Phone`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
  const data = await r.json();
  if (data?.data?.[0]) return data.data[0];

  // Try Phone
  const r2 = await fetch(
    `${ZOHO_API_BASE}/Leads/search?criteria=(Phone:equals:${phone})&fields=id,Last_Intent,Mobile,Phone`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
  const data2 = await r2.json();
  return data2?.data?.[0] || null;
}

// ── Zoho: Update Last_Intent ──────────────────────────────────────────────────
async function updateZohoIntent(leadId, intent, token) {
  const r = await fetch(`${ZOHO_API_BASE}/Leads`, {
    method: "PATCH",
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: [{ id: leadId, Last_Intent: intent, Whatsapp_Replied: true }] }),
  });
  const data = await r.json();
  return data;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 Backfill starting...\n");

  // 1. Get Zoho token
  console.log("🔑 Getting Zoho token...");
  const token = await getZohoToken();
  console.log("✅ Zoho token obtained\n");

  // 2. Get all unique phones from Supabase
  console.log("📱 Fetching WhatsApp messages from Supabase...");
  const phoneMap = await getPhoneMessages();
  console.log(`✅ Found ${phoneMap.size} unique phone numbers with inbound messages\n`);

  let updated = 0;
  let skipped_no_lead = 0;
  let skipped_already_set = 0;
  let errors = 0;

  // 3. Process each phone
  for (const [phone, message] of phoneMap) {
    try {
      // Detect intent
      const intent = detectIntent(message);

      // Find lead in Zoho
      const lead = await findLeadByPhone(phone, token);

      if (!lead) {
        console.log(`⚠️  ${phone} — Lead not found in Zoho`);
        skipped_no_lead++;
        continue;
      }

      // Skip if Last_Intent already set
      if (lead.Last_Intent && lead.Last_Intent.trim() !== "") {
        console.log(`⏭️  ${phone} — Already has Last_Intent="${lead.Last_Intent}", skipping`);
        skipped_already_set++;
        continue;
      }

      // Update
      await updateZohoIntent(lead.id, intent, token);
      console.log(`✅ ${phone} → Lead ${lead.id}: Last_Intent=${intent} | msg: "${message.slice(0, 50)}"`);
      updated++;

      // Small delay to avoid Zoho rate limits
      await new Promise(r => setTimeout(r, 300));

    } catch (err) {
      console.error(`❌ ${phone} — Error: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n📊 Backfill complete!`);
  console.log(`   ✅ Updated:              ${updated}`);
  console.log(`   ⏭️  Already had intent:   ${skipped_already_set}`);
  console.log(`   ⚠️  Lead not in Zoho:    ${skipped_no_lead}`);
  console.log(`   ❌ Errors:               ${errors}`);
}

main().catch(console.error);
