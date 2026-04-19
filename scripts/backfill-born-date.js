/**
 * Backfill Born_Date for all existing Zoho leads
 * Sets Born_Date = Created_Time (date only, YYYY-MM-DD)
 * Run: node scripts/backfill-born-date.js
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
      grant_type: "refresh_token",
      client_id: ZOHO_CLIENT_ID,
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
      params: { fields: "id,Created_Time,Born_Date", page, per_page: 200 },
    });
    const data = r.data.data || [];
    leads.push(...data);
    if (!r.data.info?.more_records) break;
    page++;
  }
  return leads;
}

async function main() {
  console.log("Getting Zoho access token...");
  const token = await getAccessToken();

  console.log("Fetching all leads...");
  const leads = await getAllLeads(token);
  console.log(`Found ${leads.length} leads\n`);

  let updated = 0, skipped = 0, errors = 0;

  for (const lead of leads) {
    const createdTime = lead.Created_Time; // e.g. "2026-04-19T11:43:08+05:30"
    const bornDate = createdTime ? createdTime.slice(0, 10) : null;

    if (!bornDate) { skipped++; continue; }
    if (lead.Born_Date) {
      console.log(`  SKIP  ${lead.id} — Born_Date already set: ${lead.Born_Date}`);
      skipped++;
      continue;
    }

    try {
      await axios.put(`${API_BASE}/Leads/${lead.id}`,
        { data: [{ Born_Date: bornDate }] },
        { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
      );
      console.log(`  ✓ Updated ${lead.id} → Born_Date: ${bornDate}`);
      updated++;
      await new Promise(r => setTimeout(r, 200)); // rate limit
    } catch (err) {
      console.error(`  ✗ Error ${lead.id}: ${err.response?.data?.message || err.message}`);
      errors++;
    }
  }

  console.log(`\nDone — Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
}

main().catch(console.error);
