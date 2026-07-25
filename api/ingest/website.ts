import { VercelRequest, VercelResponse } from "@vercel/node";
import { normalizePhone, parseName, detectProject } from "../_utils/normalize";
import { ingestLead } from "../_utils/ingest";
import { NormalizedLead } from "../_utils/types";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ── CORS headers — allow any origin (website forms, local test, etc.) ──
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");

  // Handle preflight
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ── Optional API-key auth ──────────────────────────────────────────────
  // Shares ONE key with /api/ingest/inncircles via INGEST_API_KEY (falls back
  // to the endpoint-specific WEBSITE_INGEST_KEY for back-compat). Enforced ONLY
  // when a key is set, so the endpoint stays OPEN until the key is rolled out to
  // every website integration (asblloft.com + asbllandmark.com) — set the env
  // var only after BOTH sites are sending it, else their leads get 401'd.
  // Accepts: Authorization: Bearer <key>  |  x-api-key: <key>  |  ?key=<key>
  const expectedKey = process.env.INGEST_API_KEY || process.env.WEBSITE_INGEST_KEY || "";
  if (expectedKey) {
    const authHeader = String(req.headers["authorization"] || "");
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    const got = bearer || String(req.headers["x-api-key"] || "") || String(req.query.key || "");
    if (got !== expectedKey) {
      return res.status(401).json({ error: "Unauthorized — missing or invalid API key" });
    }
  }

  try {
    const body = req.body;

    // MASTER FREEZE — archive the raw lead, do NOT process (no Mongo/Zoho/fanout).
    {
      const { isAutomationFrozen, archiveFrozen } = await import("../_utils/automation_freeze");
      if (await isAutomationFrozen()) {
        await archiveFrozen("ingest:website", body);
        // HONEST contract: success:false + a machine-readable code so a caller
        // that keys off HTTP status alone (200) doesn't record an archived-but-
        // unprocessed lead as a success. The lead is NOT in Zoho/Mongo yet — it
        // sits in frozen_inbox (30-day TTL) awaiting replay once the freeze lifts.
        return res.status(200).json({ success: false, frozen: true, code: "AUTOMATION_FROZEN", message: "automation frozen — lead archived, not processed" });
      }
    }

    const rawPhone = body.phone || body.mobile || body.phone_number || "";
    const mobile = normalizePhone(rawPhone);

    if (!mobile) return res.status(400).json({ error: "Invalid or missing phone number" });

    const { first_name, last_name } = parseName(body.name || `${body.first_name ?? ""} ${body.last_name ?? ""}`.trim());

    // Project detection from page URL or UTM
    const project =
      detectProject(body.utm_campaign) ??
      detectProject(body.page_url) ??
      detectProject(body.project) ??
      undefined;

    const lead: NormalizedLead = {
      first_name,
      last_name,
      mobile,
      email: body.email || "",
      lead_source: "Website Inquiry",
      source_lead_id: body.form_id || body.submission_id || "",
      campaign_name: body.utm_campaign || "",
      utm_source: body.utm_source || "",
      utm_medium: body.utm_medium || "",
      utm_campaign: body.utm_campaign || "",
      utm_content: body.utm_content || "",
      utm_term: body.utm_term || "",
      lead_received_at: new Date().toISOString(),
      project,
      budget: body.budget || "",
      size_preference: body.size_preference || body.configuration || "",
      floor_preference: body.floor_preference || "",
      possession_timeline: body.possession_timeline || "",
      purchase_purpose: body.purpose || body.purchase_purpose || "",
      lead_comments: [body.message, body.preferred_time ? `Preferred time: ${body.preferred_time}` : ""]
        .filter(Boolean).join(" | "),
      first_page_visited: body.first_page_visited || body.page_url || "",
      last_page_visited: body.last_page_visited || "",
      total_page_views: body.total_page_views || 0,
      time_spent_minutes: body.time_spent || body.time_spent_minutes || 0,
      referrer_url: body.referrer || body.referrer_url || "",
    };

    const result = await ingestLead(lead);

    // PRD v1.0: T=0 fanout — fire chatbot WhatsApp + AI call simultaneously
    // ONLY for fresh creates (not resubmissions; resubmission has its own
    // outreach cooldown via api/_utils/resubmission.ts).
    // BUG fix 2026-05-26: this was only wired into ingest/meta.ts so every
    // Website + FIM lead silently skipped PRD entirely → no first WhatsApp,
    // no T=0 AI call, follow-up cron skipped them because PRD_Stage was null.
    // MUST await — fire-and-forget gets killed when Vercel returns 200.
    if (result.action === "created") {
      try {
        const { handleLeadCreated } = await import("../_utils/prd_orchestrator");
        await handleLeadCreated({
          zoho_lead_id: result.zoho_lead_id!,
          phone: lead.mobile,
          customer_name: `${lead.first_name} ${lead.last_name}`.replace(/\s+\.$/, "").trim() || "there",
          project: lead.project,
          is_resubmission: false,
          last_page_visited: lead.last_page_visited,
          budget: lead.budget,
          size_preference: lead.size_preference,
        });
      } catch (err: any) {
        console.error(`[Website→PRD] handleLeadCreated failed: ${err.message}`);
      }
    }

    return res.status(200).json({ success: true, ...result });

  } catch (err: any) {
    console.error("Website ingest error:", err.message);
    return res.status(500).json({
      error: err.message,
      hint: "Check Vercel env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN",
    });
  }
}
