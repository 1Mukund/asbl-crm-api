import { VercelRequest, VercelResponse } from "@vercel/node";
import { normalizePhone, parseName, detectProject } from "./_utils/normalize";
import { getOrCreateMLID, getOrCreatePLID } from "./_utils/supabase";
import { updateLead } from "./_utils/zoho";

// ─── Called from Zoho Deluge Workflow after LeadChain creates a lead ──────────
// Zoho sends: zoho_lead_id, phone, full_name, campaign_name, lead_source, email

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Allow Zoho Deluge to call this (it uses GET sometimes)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = req.method === "GET" ? req.query : req.body;

    const zohoLeadId   = String(body.zoho_lead_id || "").trim();
    const rawPhone     = String(body.phone || body.mobile || "").trim();
    const fullName     = String(body.full_name || body.name || "").trim();
    const campaignName = String(body.campaign_name || "").trim();
    const leadSource   = String(body.lead_source || "FIM Forms").trim();
    const email        = String(body.email || "").trim();

    if (!zohoLeadId) {
      return res.status(400).json({ error: "Missing zoho_lead_id" });
    }

    // ── 1. Normalize phone ─────────────────────────────────────────────────────
    const mobile = normalizePhone(rawPhone);
    if (!mobile) {
      return res.status(400).json({ error: "Invalid or missing phone number" });
    }

    // ── 2. Parse name into first + last ───────────────────────────────────────
    const { first_name, last_name } = parseName(fullName);

    // ── 3. Detect project from campaign name ──────────────────────────────────
    const project = detectProject(campaignName) ?? "LOFT"; // Default LOFT for LeadChain leads

    // ── 4. Get or create MLID + PLID from Supabase (same logic as Vercel API) ─
    const mlid = await getOrCreateMLID(mobile);
    const plid = await getOrCreatePLID(mobile, mlid, project);

    // ── 5. Update Zoho lead with normalized fields ─────────────────────────────
    await updateLead(zohoLeadId, {
      Mobile:           mobile,
      First_Name:       first_name,
      Last_Name:        last_name,
      Lead_Source:      leadSource,
      Master_Lead_ID:   mlid,
      Project_Lead_ID:  plid,
      ASBL_Project:     project,
      Campaign_Name:    campaignName,
      ...(email ? { Email: email } : {}),
    });

    console.log(`✅ Normalized lead ${zohoLeadId} → MLID: ${mlid}, PLID: ${plid}, Project: ${project}`);

    return res.status(200).json({
      success:       true,
      zoho_lead_id:  zohoLeadId,
      mlid,
      plid,
      project,
      mobile,
      first_name,
      last_name,
    });

  } catch (err: any) {
    console.error("normalize-zoho-lead error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
