/**
 * Backfill Whatsapp_Sent = true in Zoho for all leads with a phone number
 * Messages already sent — this just updates the Zoho fields
 * Run: node scripts/backfill-whatsapp-zoho.js
 */

const axios = require("axios");
require("fs").readFileSync(".env", "utf8").split("\n").forEach(line => {
  const [k, ...v] = line.split("=");
  if (k && v.length) process.env[k.trim()] = v.join("=").trim();
});

const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;
const API_BASE = "https://www.zohoapis.in/crm/v3";

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
      params: { fields: "id,First_Name,Mobile,Whatsapp_Sent", page, per_page: 200 },
    });
    const data = r.data.data || [];
    leads.push(...data);
    if (!r.data.info?.more_records) break;
    page++;
  }
  return leads;
}

async function main() {
  console.log("Getting Zoho token...");
  const token = await getAccessToken();

  console.log("Fetching leads...");
  const leads = await getAllLeads(token);

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

  // Filter leads with phone and Whatsapp_Sent not true
  const pending = leads.filter(l => {
    const phone = (l.Mobile || "").replace(/\D/g, "");
    return phone.length >= 10 && !l.Whatsapp_Sent;
  });

  console.log(`Total: ${leads.length} | To update: ${pending.length}\n`);

  let updated = 0, errors = 0;

  // Zoho allows bulk update of 100 records at a time
  for (let i = 0; i < pending.length; i += 100) {
    const batch = pending.slice(i, i + 100);
    const data  = batch.map(l => ({
      id:               l.id,
      Whatsapp_Sent:    true,
      Last_Whatsapp_At: now,
    }));

    try {
      const r = await axios.patch(
        `${API_BASE}/Leads`,
        { data },
        { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
      );

      const results = r.data?.data || [];
      results.forEach((res, idx) => {
        const lead = batch[idx];
        const name = lead.First_Name || lead.id;
        if (res.code === "SUCCESS") {
          console.log(`  ✓ ${name}`);
          updated++;
        } else {
          console.log(`  ✗ ${name} — ${res.message || res.code}`);
          errors++;
        }
      });
    } catch (err) {
      console.error(`  ✗ Batch error: ${err.response?.data?.message || err.message}`);
      errors += batch.length;
    }
  }

  console.log(`\n✅ Done — Updated: ${updated}, Errors: ${errors}`);
}

main().catch(console.error);
