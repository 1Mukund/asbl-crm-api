/**
 * Backfill WhatsApp messages to all existing Zoho leads
 * Sends Periskope WhatsApp message to leads where Whatsapp_Sent is false/empty
 * Run: node scripts/backfill-whatsapp.js
 */

const axios = require("axios");
require("fs").readFileSync(".env", "utf8").split("\n").forEach(line => {
  const [k, ...v] = line.split("=");
  if (k && v.length) process.env[k.trim()] = v.join("=").trim();
});

const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;
const VERCEL_URL = "https://asbl-crm-api.vercel.app/api/relay/periskope";
const API_BASE   = "https://www.zohoapis.in/crm/v3";

async function getAccessToken() {
  const r = await axios.post("https://accounts.zoho.in/oauth/v2/token", null, {
    params: {
      grant_type:    "refresh_token",
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN,
    },
  });
  return r.data.access_token;
}

async function getAllLeads(token) {
  const leads = [];
  let page = 1;
  while (true) {
    const r = await axios.get(`${API_BASE}/Leads`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: {
        fields:   "id,First_Name,Last_Name,Mobile,ASBL_Project,Lead_Budget,Size_Preference,Lead_Source,Whatsapp_Sent",
        page,
        per_page: 200,
      },
    });
    const data = r.data.data || [];
    leads.push(...data);
    if (!r.data.info?.more_records) break;
    page++;
  }
  return leads;
}

async function sendWhatsApp(lead, token) {
  const phone = (lead.Mobile || "").replace(/\D/g, "");
  if (!phone || phone.length < 10) return { skipped: true, reason: "no phone" };

  // Send via Periskope
  const r = await axios.post(VERCEL_URL, {
    phone,
    first_name:      lead.First_Name || "",
    project:         lead.ASBL_Project || "",
    budget:          lead.Lead_Budget || "",
    size_preference: lead.Size_Preference || "",
    lead_source:     lead.Lead_Source || "",
  });

  // Update Zoho: Whatsapp_Sent = true
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  await axios.patch(
    `${API_BASE}/Leads`,
    { data: [{ id: lead.id, Whatsapp_Sent: true, Last_Whatsapp_At: now }] },
    { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
  );

  return r.data;
}

async function main() {
  console.log("Getting Zoho access token...");
  const token = await getAccessToken();

  console.log("Fetching all leads...");
  const leads = await getAllLeads(token);
  console.log(`Found ${leads.length} leads\n`);

  // Filter: only leads without WhatsApp sent + have phone
  const pending = leads.filter(l => {
    const phone = (l.Mobile || "").replace(/\D/g, "");
    return phone.length >= 10 && !l.Whatsapp_Sent;
  });

  console.log(`Pending (no WhatsApp sent): ${pending.length}`);
  console.log(`Already sent: ${leads.length - pending.length}\n`);

  if (pending.length === 0) {
    console.log("Nothing to send!");
    return;
  }

  let sent = 0, skipped = 0, errors = 0;

  for (const lead of pending) {
    const name = `${lead.First_Name || ""} ${lead.Last_Name || ""}`.trim() || "Unknown";
    const phone = (lead.Mobile || "").replace(/\D/g, "");

    process.stdout.write(`  [${sent + skipped + errors + 1}/${pending.length}] ${name} (${phone}) → `);

    try {
      const result = await sendWhatsApp(lead, token);
      if (result.skipped) {
        console.log(`SKIP — ${result.reason}`);
        skipped++;
      } else {
        console.log(`✓ Sent via ${result.sender}`);
        sent++;
      }
    } catch (err) {
      console.log(`✗ Error — ${err.response?.data?.error || err.message}`);
      errors++;
    }

    // 1 minute gap between messages (avoid WhatsApp flag/block)
    if (sent + skipped + errors < pending.length) {
      process.stdout.write(`     ⏳ Waiting 60s before next...\n`);
      await new Promise(r => setTimeout(r, 60000));
    }
  }

  console.log(`\n✅ Done — Sent: ${sent}, Skipped: ${skipped}, Errors: ${errors}`);
}

main().catch(console.error);
