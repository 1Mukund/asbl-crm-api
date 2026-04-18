import { VercelRequest, VercelResponse } from "@vercel/node";
import { normalizePhone, parseName, detectProject } from "../_utils/normalize";
import { ingestLead } from "../_utils/ingest";
import { NormalizedLead } from "../_utils/types";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body;

    // Meta sends leads via LeadChain webhook
    // field_data is array: [{name, values}]
    const fields: Record<string, string> = {};
    if (Array.isArray(body.field_data)) {
      for (const f of body.field_data) {
        fields[f.name] = f.values?.[0] ?? "";
      }
    }

    const rawPhone = fields["phone_number"] || fields["phone"] || body.phone_number || body.phone || "";
    const mobile = normalizePhone(rawPhone);

    if (!mobile) return res.status(400).json({ error: "Invalid or missing phone number" });

    const fullName = fields["full_name"] || body.full_name || `${body.first_name ?? ""} ${body.last_name ?? ""}`.trim();
    const { first_name, last_name } = parseName(fullName);

    const campaignName = body.campaign_name || fields["campaign_name"] || "";
    const project = detectProject(campaignName) ?? detectProject(fields["project"]) ?? undefined;

    const lead: NormalizedLead = {
      first_name,
      last_name,
      mobile,
      email: fields["email"] || body.email || "",
      lead_source: "FIM Forms",
      source_lead_id: body.leadgen_id || body.id || fields["leadgen_id"] || "",
      campaign_name: campaignName,
      ad_set_name: body.adset_name || "",
      ad_name: body.ad_name || "",
      lead_received_at: new Date().toISOString(),
      project,
      budget: fields["budget"] || "",
      size_preference: fields["size_preference"] || fields["configuration"] || "",
      lead_comments: fields["message"] || fields["comments"] || "",
    };

    const result = await ingestLead(lead);
    return res.status(200).json({ success: true, ...result });

  } catch (err: any) {
    console.error("Meta ingest error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
