import { NormalizedLead } from "./types";
import { getOrCreateMLID, getOrCreatePLID, upsertLead } from "./supabase";
import {
  findLeadByPhoneAndProject,
  findLeadByPhone,
  createLead,
  updateLead,
} from "./zoho";
import { recordResubmission } from "./resubmission";

function isValidUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}

export type IngestResult = {
  action: "created" | "updated";
  zoho_lead_id: string;
  mlid: string;
  plid: string;
  /** Set when action = "updated" — the lead resubmitted a form. Includes
   *  the new total count, source, the audit-line we just appended, and
   *  whether outreach was suppressed by the per-lead cooldown.
   *  Sales debugs this when they ask "did the resubmission trigger fire?". */
  resubmission?: {
    count: number;
    source: string;
    history_line: string;
    outreach_suppressed: boolean;
    cooldown_remaining_minutes: number;
  };
};

export async function ingestLead(lead: NormalizedLead): Promise<IngestResult> {
  const { mobile, project } = lead;

  // ── Step 1: Get or create MLID + PLID from Supabase (atomic, race-safe) ──
  const mlid = await getOrCreateMLID(mobile);
  const plid = await getOrCreatePLID(mobile, mlid, project ?? "UNKNOWN");

  // ── Step 2: Build Zoho payload ────────────────────────────────────────────
  const zohoPayload: Record<string, any> = {
    // Standard fields
    First_Name: lead.first_name,
    Last_Name: lead.last_name,
    Mobile: mobile,
    Email: lead.email ?? "",
    Lead_Source: lead.lead_source,

    // Identity
    Master_Lead_ID: mlid,
    Project_Lead_ID: plid,
    Source_Lead_ID: lead.source_lead_id ?? "",

    // Attribution
    Campaign_Name: lead.campaign_name ?? "",
    Ad_Set_Name: lead.ad_set_name ?? "",
    Ad_Name: lead.ad_name ?? "",
    UTM_Source: lead.utm_source ?? "",
    UTM_Medium: lead.utm_medium ?? "",
    UTM_Campaign: lead.utm_campaign ?? "",
    UTM_Content: lead.utm_content ?? "",
    UTM_Term: lead.utm_term ?? "",
    Lead_Received_At: lead.lead_received_at.replace(/\.\d{3}Z$/, "+00:00"),
    // Born Date = date lead entered CRM (YYYY-MM-DD format for Zoho date field)
    Born_Date: lead.lead_received_at.slice(0, 10),

    // Project & Interest
    ASBL_Project: lead.project ?? "",
    Lead_Budget: lead.budget ?? "",
    Size_Preference: lead.size_preference ?? "",
    Floor_Preference: lead.floor_preference ?? "",
    Possession_Timeline: lead.possession_timeline ?? "",
    Purchase_Purpose: lead.purchase_purpose ?? "",
    Lead_Comments: lead.lead_comments ?? "",

    // Web Tracking — only send valid http/https URLs, skip empty to avoid Zoho INVALID_DATA
    ...(isValidUrl(lead.first_page_visited) ? { First_Page_Visited: lead.first_page_visited } : {}),
    ...(isValidUrl(lead.last_page_visited)  ? { Last_Page_Visited: lead.last_page_visited }  : {}),
    ...(isValidUrl(lead.referrer_url)       ? { Referrer_URL: lead.referrer_url }             : {}),
    Total_Page_Views: lead.total_page_views ?? 0,
    Time_Spent_Minutes: lead.time_spent_minutes ?? 0,
  };

  // ── Step 3: Dedup check in Zoho + Create or Update ───────────────────────
  let existingLead: any = null;
  if (project) {
    existingLead = await findLeadByPhoneAndProject(mobile, project);
  } else {
    existingLead = await findLeadByPhone(mobile);
  }

  let zohoLeadId: string;
  let action: "created" | "updated";
  let resubmission: IngestResult["resubmission"] = undefined;

  if (existingLead) {
    // Don't overwrite Born_Date on resubmissions — it should reflect the
    // ORIGINAL CRM creation date, not the date of the latest resubmit.
    // (Resubmission timing is captured separately on Last_Resubmission_At.)
    const { Born_Date: _ignored, ...payloadForUpdate } = zohoPayload;
    await updateLead(existingLead.id, payloadForUpdate);
    zohoLeadId = existingLead.id;
    action = "updated";

    // ── Resubmission tracking ─────────────────────────────────────────────
    // Existing-lead-found-by-phone-and-project means the user filled a form
    // again after their lead was already created — that's a resubmission.
    // recordResubmission stamps the count/history fields, then fires
    // WhatsApp + voice call (fire-and-forget).
    try {
      const r = await recordResubmission({
        lead,
        zohoLeadId,
        mlid,
        plid,
        existingLead,
      });
      resubmission = r;
    } catch (err: any) {
      // Never block ingest on resubmission tracking — log and move on.
      console.error(`[Ingest] recordResubmission threw for ${zohoLeadId}: ${err.message}`);
    }
  } else {
    zohoLeadId = await createLead(zohoPayload);
    action = "created";
    // Zoho sometimes ignores custom fields in POST — patch Born_Date separately
    if (zohoPayload.Born_Date) {
      await updateLead(zohoLeadId, { Born_Date: zohoPayload.Born_Date }).catch(() => {});
    }
  }

  // ── Step 4: Store in Supabase (source of truth + safety net) ─────────────
  await upsertLead(lead, mlid, plid, zohoLeadId, true);

  return { action, zoho_lead_id: zohoLeadId, mlid, plid, resubmission };
}
