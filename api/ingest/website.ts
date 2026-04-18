import { VercelRequest, VercelResponse } from "@vercel/node";
import { normalizePhone, parseName, detectProject } from "../_utils/normalize";
import { ingestLead } from "../_utils/ingest";
import { NormalizedLead } from "../_utils/types";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body;

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
    return res.status(200).json({ success: true, ...result });

  } catch (err: any) {
    console.error("Website ingest error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
