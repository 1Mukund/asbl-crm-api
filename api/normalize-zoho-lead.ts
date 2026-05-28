import { VercelRequest, VercelResponse } from "@vercel/node";
import { normalizePhone, parseName, detectProject } from "./_utils/normalize";
import { getOrCreateMLID, getOrCreatePLID, upsertLead } from "./_utils/supabase";
import { updateLead } from "./_utils/zoho";
import { NormalizedLead } from "./_utils/types";

// ─── Called from Zoho Deluge Workflow after LeadChain creates a lead ──────────
// Zoho sends: zoho_lead_id, phone, full_name, campaign_name, lead_source, email
//
// 2026-05-28 fix: was previously only generating MLID/PLID + patching Zoho.
// Mongo `leads` collection was NEVER updated for LeadChain-sourced leads,
// and PRD T=0 (chatbot WhatsApp + AI call) NEVER fired. Result: 36 leads
// in Zoho without a Mongo `leads` doc, no WhatsApp greeting, no T=0 call.
// Now does the full pipeline like /api/ingest/website + /api/ingest/meta.

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

    // ── 4. Get or create MLID + PLID (Mongo-backed atomic counters) ────────────
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

    // ── 6. UPSERT into Mongo `leads` so dedup + cron + PRD all see this lead ──
    // Was skipped previously → 36 LeadChain leads existed in Zoho but not in Mongo.
    const normalized: NormalizedLead = {
      first_name,
      last_name,
      mobile,
      email: email || undefined,
      lead_source: (leadSource as any),
      source_lead_id: "",
      campaign_name: campaignName,
      lead_received_at: new Date().toISOString(),
      project,
    };
    try {
      await upsertLead(normalized, mlid, plid, zohoLeadId, true);
    } catch (err: any) {
      console.error(`[normalize-zoho-lead] upsertLead failed: ${err.message}`);
    }

    // ── 7. PRD T=0 fanout — DISABLED 2026-05-28 ────────────────────────────
    // Was firing handleLeadCreated on every call. But Zoho Deluge fires this
    // endpoint on lead UPDATES too (not just creations) → same lead got T=0
    // re-fired 4-5x → mass WhatsApp spam. The /api/ingest/* webhooks (which
    // ARE clearly one-shot per lead) handle PRD T=0 correctly. LeadChain
    // leads are NOT a typical lead-create event flow — sales/ops handle
    // those manually. So this endpoint is now strictly NORMALISE + SYNC,
    // never triggers outbound bot messages.
    //
    // If you need T=0 for LeadChain leads in the future, gate it on a
    // strict "first time only" check (e.g. findLeadByPLID returns null
    // BEFORE the upsert above runs).

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
