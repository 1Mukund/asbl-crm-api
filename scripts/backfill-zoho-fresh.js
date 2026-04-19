/**
 * backfill-zoho-fresh.js
 *
 * Zoho ke saare leads jinka Last_Intent empty hai → "general" set karo
 * Isse Zoho Workflow fire hoga → Lead Status = "Lead Initiated"
 *
 * Run: node scripts/backfill-zoho-fresh.js
 */

require("dotenv").config();

const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_API_BASE      = "https://www.zohoapis.in/crm/v3";

// ── Zoho token ────────────────────────────────────────────────────────────────
async function getZohoToken() {
  const r = await fetch(
    `https://accounts.zoho.in/oauth/v2/token?grant_type=refresh_token&client_id=${ZOHO_CLIENT_ID}&client_secret=${ZOHO_CLIENT_SECRET}&refresh_token=${ZOHO_REFRESH_TOKEN}`,
    { method: "POST" }
  );
  const data = await r.json();
  if (!data.access_token) throw new Error("Token error: " + JSON.stringify(data));
  return data.access_token;
}

// ── Fetch all Zoho leads (paginated) ─────────────────────────────────────────
async function getAllLeads(token) {
  let page = 1;
  let allLeads = [];

  while (true) {
    const r = await fetch(
      `${ZOHO_API_BASE}/Leads?fields=id,Last_Name,Mobile,Phone,Last_Intent,Whatsapp_Sent&per_page=200&page=${page}`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const data = await r.json();

    if (!data?.data?.length) break;
    allLeads = allLeads.concat(data.data);

    if (!data.info?.more_records) break;
    page++;
    await new Promise(r => setTimeout(r, 200)); // rate limit
  }

  return allLeads;
}

// ── Zoho: Bulk update up to 100 leads at a time ───────────────────────────────
async function bulkUpdate(leads, token) {
  // Zoho allows max 100 records per PATCH
  const chunks = [];
  for (let i = 0; i < leads.length; i += 100) {
    chunks.push(leads.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    const r = await fetch(`${ZOHO_API_BASE}/Leads`, {
      method: "PATCH",
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: chunk }),
    });
    const result = await r.json();
    const success = result?.data?.filter(d => d.status === "success").length || 0;
    const fail    = result?.data?.filter(d => d.status !== "success").length || 0;
    console.log(`   Batch: ✅ ${success} updated, ❌ ${fail} failed`);
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 Backfill (fresh leads) starting...\n");

  console.log("🔑 Getting Zoho token...");
  const token = await getZohoToken();
  console.log("✅ Zoho token obtained\n");

  console.log("📋 Fetching all leads from Zoho...");
  const allLeads = await getAllLeads(token);
  console.log(`✅ Total leads fetched: ${allLeads.length}\n`);

  // Filter: Last_Intent empty/null
  const toUpdate = allLeads
    .filter(l => !l.Last_Intent || l.Last_Intent.trim() === "")
    .map(l => ({
      id:           l.id,
      Last_Intent:  "general",
    }));

  const alreadySet = allLeads.length - toUpdate.length;

  console.log(`📊 Summary:`);
  console.log(`   Already have Last_Intent: ${alreadySet}`);
  console.log(`   Empty (will update):      ${toUpdate.length}\n`);

  if (toUpdate.length === 0) {
    console.log("✅ Nothing to update — all leads already have Last_Intent set!");
    return;
  }

  console.log(`⚡ Updating ${toUpdate.length} leads → Last_Intent="general"...`);
  await bulkUpdate(toUpdate, token);

  console.log(`\n✅ Backfill complete! ${toUpdate.length} leads updated.`);
  console.log(`   Zoho Workflow Rules will now fire → Lead Status = "Lead Initiated"`);
}

main().catch(console.error);
