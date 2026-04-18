import { NormalizedLead } from "./types";
import {
  findLeadByPhone,
  findLeadByPhoneAndProject,
  getOrCreateMLID,
  generatePLID,
  createLead,
  updateLead,
} from "./zoho";

export type IngestResult = {
  action: "created" | "updated";
  zoho_lead_id: string;
  mlid: string;
  plid: string;
};

export async function ingestLead(lead: NormalizedLead): Promise<IngestResult> {
  const { mobile, project } = lead;

  // 1. Get or create MLID
  const mlid = await getOrCreateMLID(mobile);

  // 2. Dedup check
  let existingLead: any = null;
  if (project) {
    existingLead = await findLeadByPhoneAndProject(mobile, project);
  } else {
    existingLead = await findLeadByPhone(mobile);
  }

  const plid = await generatePLID(mlid, project ?? "UNKNOWN");

  // 3. Build Zoho payload
  const zohoPayload: Record<string, any> = {
    // ─── Standard Fields ─────────────────────────────────────────────────
    First_Name: lead.first_name,
    Last_Name: lead.last_name,
    Mobile: mobile,
    Email: lead.email ?? "",
    Lead_Source: lead.lead_source,

    // ─── Identity ─────────────────────────────────────────────────────────
    Master_Lead_ID: mlid,
    Project_Lead_ID: plid,
    Source_Lead_ID: lead.source_lead_id ?? "",

    // ─── Attribution ─────────────────────────────────────────────────────
    Campaign_Name: lead.campaign_name ?? "",
    Ad_Set_Name: lead.ad_set_name ?? "",
    Ad_Name: lead.ad_name ?? "",
    UTM_Source: lead.utm_source ?? "",
    UTM_Medium: lead.utm_medium ?? "",
    UTM_Campaign: lead.utm_campaign ?? "",
    UTM_Content: lead.utm_content ?? "",
    UTM_Term: lead.utm_term ?? "",
    Lead_Received_At: lead.lead_received_at.replace(/\.\d{3}Z$/, "+00:00"),

    // ─── Project & Interest ───────────────────────────────────────────────
    ASBL_Project: lead.project ?? "",
    Lead_Budget: lead.budget ?? "",
    Size_Preference: lead.size_preference ?? "",
    Floor_Preference: lead.floor_preference ?? "",
    Possession_Timeline: lead.possession_timeline ?? "",
    Purchase_Purpose: lead.purchase_purpose ?? "",
    Lead_Comments: lead.lead_comments ?? "",

    // ─── Web Tracking ────────────────────────────────────────────────────
    First_Page_Visited: lead.first_page_visited ?? "",
    Last_Page_Visited: lead.last_page_visited ?? "",
    Total_Page_Views: lead.total_page_views ?? 0,
    Time_Spent_Minutes: lead.time_spent_minutes ?? 0,
    Referrer_URL: lead.referrer_url ?? "",
  };

  // 4. Create or Update
  if (existingLead) {
    await updateLead(existingLead.id, zohoPayload);
    return { action: "updated", zoho_lead_id: existingLead.id, mlid, plid };
  } else {
    const newId = await createLead(zohoPayload);
    return { action: "created", zoho_lead_id: newId, mlid, plid };
  }
}
