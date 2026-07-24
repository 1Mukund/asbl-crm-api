import { NormalizedLead } from "./types";
import { getOrCreateMLID, getOrCreatePLID, upsertLead, findLeadByPLID, claimLeadCreation } from "./supabase";
import {
  findLeadByPhoneAndProject,
  findLeadByPhone,
  getLeadById,
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

/** Set when action = "updated" — the lead resubmitted a form. Includes the new
 *  total count, source, the audit-line we just appended, and whether outreach
 *  was suppressed by the per-lead cooldown. Sales debugs this when they ask
 *  "did the resubmission trigger fire?". */
export type ResubmissionInfo = {
  count: number;
  source: string;
  history_line: string;
  outreach_suppressed: boolean;
  cooldown_remaining_minutes: number;
};

export type IngestResult = {
  // "created"/"updated" landed in Zoho (zoho_lead_id present). "queued" = Zoho
  // create failed (trial expired / auth / outage) so the lead was persisted to
  // Mongo ONLY (zoho_lead_id null); reconcile-zoho-pending syncs it later.
  action: "created" | "updated" | "queued";
  zoho_lead_id: string | null;
  mlid: string;
  plid: string;
  /** Why the Zoho write failed. Set when action = "queued" (create failed →
   *  Mongo-only, reconcile later) OR when action = "updated" but the Zoho
   *  field-sync failed (lead is already durable in Mongo; reconcile re-applies). */
  zoho_error?: string;
  resubmission?: ResubmissionInfo;
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
    // Born Date = the lead's ORIGINAL born date at source (caller-supplied when
    // available — may predate CRM entry for bulk transfers / reactivations),
    // else the CRM-entry date as fallback. YYYY-MM-DD for Zoho's date field.
    Born_Date: lead.born_date || lead.lead_received_at.slice(0, 10),
    // Dedicated Inncircles-supplied born date (only when the caller sent one).
    // Drives the per-person "latest-born project = the one we call" selection.
    ...(lead.born_date ? { Inncircles_Born_Date: lead.born_date } : {}),

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

    // Per-section engagement time (Inncircles). Only sent when present so
    // other sources don't overwrite with 0.
    ...(lead.section_timespent?.home          != null ? { Home_Timespent:          lead.section_timespent.home }          : {}),
    ...(lead.section_timespent?.plans         != null ? { Plans_Timespent:         lead.section_timespent.plans }         : {}),
    ...(lead.section_timespent?.price         != null ? { Price_Timespent:         lead.section_timespent.price }         : {}),
    ...(lead.section_timespent?.location      != null ? { Location_Timespent:      lead.section_timespent.location }      : {}),
    ...(lead.section_timespent?.specification != null ? { Specification_Timespent: lead.section_timespent.specification } : {}),
    ...(lead.section_timespent?.amenities     != null ? { Amenities_Timespent:     lead.section_timespent.amenities }     : {}),
    ...(lead.section_timespent?.media         != null ? { Media_Timespent:         lead.section_timespent.media }         : {}),

    // Manual-reactivation only: purple-row flag for the latest-project lead.
    ...(lead.reactivation_is_latest != null ? { Reactivation_Is_Latest: lead.reactivation_is_latest } : {}),

    // Inncircles origin flags — only sent when the caller included them.
    ...(lead.inncircles_flags?.is_reactivated           != null ? { IsReactivated:          lead.inncircles_flags.is_reactivated }           : {}),
    ...(lead.inncircles_flags?.is_born_fresh            != null ? { IsBorn_Fresh:           lead.inncircles_flags.is_born_fresh }            : {}),
    ...(lead.inncircles_flags?.is_born_in_other_project != null ? { IsBorn_InOtherProject:  lead.inncircles_flags.is_born_in_other_project } : {}),
    ...(lead.inncircles_flags?.is_bulk_transfer         != null ? { IsBulkTransfer:         lead.inncircles_flags.is_bulk_transfer }         : {}),
  };

  // ── Step 3: Atomic dedupe via Mongo claim — closes ALL race windows ─────
  //
  // Pattern: claimLeadCreation does an upsert on leads._id=plid with
  // returnDocument:'before'. Mongo serialises concurrent calls — exactly
  // ONE request gets `status: "first"` (the upsert just inserted the doc),
  // every other concurrent request gets `status: "duplicate"` (the upsert
  // found an existing doc). The duplicate path waits briefly for the first
  // request's zoho_lead_id to land and uses that ID for updateLead —
  // never calls Zoho createLead again. Result: at most ONE Zoho lead per
  // PLID even under heavy concurrent submission.
  //
  // History of this race:
  //   2026-05-22: 13 dupes found created 3-7s apart (Zoho search lag).
  //               Fix a4e0d62 added findLeadByPLID pre-check — shrunk
  //               window from ~30s to ~3s but didn't close it.
  //   2026-05-22: Phase 7 moved leads to Mongo with _id=plid atomic
  //               upsert — Mongo doc is single but Zoho createLead still
  //               fires twice if both requests reach it.
  //   2026-05-26: 1 more dupe observed (1562-LOFT). Atomic CLAIM pattern
  //               below now serialises Zoho-create attempts via Mongo's
  //               upsert-returnDocument-before contract. Race fully closed.
  let existingLead: any = null;
  let claimedFirst = false;

  try {
    const claim = await claimLeadCreation(plid, mobile, mlid);
    if (claim.status === "first") {
      claimedFirst = true;
      console.log(`[Ingest] claim WON for plid=${plid} — will call Zoho createLead`);
    } else if (claim.status === "duplicate") {
      console.log(`[Ingest] claim LOST for plid=${plid} → reusing zoho_lead_id=${claim.zoho_lead_id}`);
      try {
        existingLead = await getLeadById(claim.zoho_lead_id);
      } catch (err: any) {
        console.error(`[Ingest] getLeadById(${claim.zoho_lead_id}) threw: ${err.message}`);
      }
    } else {
      // duplicate_pending — first request timed out before producing a
      // zoho_lead_id. Fall through to legacy Zoho search as last resort.
      console.warn(`[Ingest] claim PENDING for plid=${plid} — first request still in flight after 6s, falling through to Zoho search`);
    }
  } catch (err: any) {
    console.error(`[Ingest] claimLeadCreation threw: ${err.message} — falling through to legacy dedupe`);
  }

  // Legacy fallback paths (only used when claim returned duplicate_pending
  // OR threw). Kept for resilience — the claim path is the primary defence.
  if (!claimedFirst && !existingLead) {
    if (project) {
      existingLead = await findLeadByPhoneAndProject(mobile, project);
    } else {
      existingLead = await findLeadByPhone(mobile);
    }
  }

  // ── Step 4: MONGO-FIRST durability (Mongo is the source of truth) ─────────
  // Persist the FULL lead to Mongo BEFORE any Zoho write. The lead is durable
  // here regardless of whether Zoho is reachable, so nothing downstream depends
  // on Zoho for the lead to exist. Zoho is then written best-effort / non-
  // blocking and the doc is stamped zoho_synced=true ONLY when the Zoho write
  // actually lands; every failure falls through to the queued/reconcile pattern
  // instead of losing (or failing) the lead.
  const preZohoId: string | null = existingLead ? String(existingLead.id) : null;
  await upsertLead(lead, mlid, plid, preZohoId, false);

  // ── New event-sourced model (rebuild v1) — Mongo-first, additive ──────────
  // Populate persons / crm_leads / lead_events (+ stale_person_record for
  // not-interested Inncircles siblings) alongside the legacy `leads` mirror.
  // Best-effort: a failure here must NEVER fail ingest (the legacy write above
  // already made the lead durable). Runs only when not frozen (the ingest
  // handlers gate on the freeze before ever calling ingestLead).
  try {
    const { recordIngestToNewModel } = await import("./crm_model");
    await recordIngestToNewModel({
      phone: mobile,
      project,
      source: lead.lead_source,
      name: `${lead.first_name} ${lead.last_name}`.trim(),
      email: lead.email,
      born_at: lead.born_date || lead.lead_received_at,
      // The Inncircles-supplied original born date drives active/stale +
      // primary-caller ordering. Only meaningful when the caller sent one.
      inncircles_born_date: lead.born_date,
      source_lead_id: lead.source_lead_id,
      flags: lead.inncircles_flags,
      zoho_lead_id: preZohoId,
      prefs: {
        budget: lead.budget,
        size: lead.size_preference,
        facing: lead.floor_preference,
        timeline: lead.possession_timeline,
        purpose: lead.purchase_purpose,
      },
    });
  } catch (merrModel: any) {
    console.error(`[Ingest] recordIngestToNewModel failed (legacy write is durable) for plid=${plid}: ${merrModel.message}`);
  }

  let zohoLeadId: string | null = preZohoId;
  let action: "created" | "updated";
  let zohoSynced = false;
  let zohoError: string | undefined;
  let resubmission: ResubmissionInfo | undefined = undefined;

  if (existingLead) {
    action = "updated";
    // Don't overwrite Born_Date / Inncircles_Born_Date on resubmissions — they
    // should reflect the ORIGINAL born date, not the latest resubmit.
    // (Resubmission timing is captured separately on Last_Resubmission_At.)
    const { Born_Date: _ignored, Inncircles_Born_Date: _ignored2, ...payloadForUpdate } = zohoPayload;
    // Zoho field-sync is OPTIONAL — Mongo already holds the full record. A Zoho
    // outage must not fail ingest; leave the doc zoho_synced=false so reconcile
    // re-applies later.
    try {
      await updateLead(existingLead.id, payloadForUpdate);
      zohoSynced = true;
    } catch (zerr: any) {
      zohoError = zerr.message;
      console.error(`[Ingest] updateLead FAILED (Mongo already durable) for ${existingLead.id}: ${zerr.message}`);
    }

    // ── Resubmission tracking ─────────────────────────────────────────────
    // Existing-lead-found-by-phone-and-project means the user filled a form
    // again after their lead was already created — that's a resubmission.
    // recordResubmission stamps the count/history fields, then fires
    // WhatsApp + voice call (fire-and-forget).
    try {
      const r = await recordResubmission({
        lead,
        zohoLeadId: existingLead.id,
        mlid,
        plid,
        existingLead,
      });
      resubmission = r;
    } catch (err: any) {
      // Never block ingest on resubmission tracking — log and move on.
      console.error(`[Ingest] recordResubmission threw for ${existingLead.id}: ${err.message}`);
    }
  } else {
    // Zoho create is OPTIONAL / non-blocking. On failure (INVALID_TOKEN storm,
    // rate-limit, CRM Plus trial expired) the lead is ALREADY durable in Mongo
    // (upsertLead above) as un-synced (zoho_lead_id=null, zoho_synced=false); we
    // stash the payload + return "queued" so the reconcile-zoho-pending cron
    // re-creates it in Zoho once Zoho recovers. Mongo — not Zoho — is what
    // guarantees the lead is never lost.
    try {
      zohoLeadId = await createLead(zohoPayload);
      action = "created";
      zohoSynced = true;
      // Zoho sometimes ignores custom fields in POST — patch Born_Date separately
      if (zohoPayload.Born_Date) {
        await updateLead(zohoLeadId, { Born_Date: zohoPayload.Born_Date }).catch(() => {});
      }
    } catch (zerr: any) {
      console.error(`[Ingest] createLead FAILED — lead already durable in Mongo (plid=${plid}): ${zerr.message}`);
      // Stash the exact Zoho payload + error so the reconcile job can re-create
      // the lead in Zoho without rebuilding it.
      try {
        const { getCollection, COL } = await import("./mongo");
        const col = await getCollection(COL.LEADS);
        await col.updateOne(
          { _id: plid } as any,
          { $set: { zoho_payload_pending: zohoPayload, zoho_error: zerr.message, zoho_queued_at: new Date().toISOString() } },
        );
      } catch (stashErr: any) {
        console.error(`[Ingest] failed to stash pending payload for ${plid}: ${stashErr.message}`);
      }
      return { action: "queued", zoho_lead_id: null, mlid, plid, zoho_error: zerr.message };
    }
  }

  // ── Step 5: stamp Mongo as Zoho-synced ONLY when the Zoho write landed ────
  // (Re-upserts the full doc with the resolved zoho_lead_id + zoho_synced=true.)
  if (zohoSynced && zohoLeadId) {
    await upsertLead(lead, mlid, plid, zohoLeadId, true);
    // Mirror the resolved Zoho id onto the new-model doc (best-effort).
    try {
      const { setLeadZohoId, personIdOf, leadIdOf } = await import("./crm_model");
      await setLeadZohoId(leadIdOf(personIdOf(mobile), project), zohoLeadId);
    } catch (zerr2: any) {
      console.error(`[Ingest] setLeadZohoId failed for plid=${plid}: ${zerr2.message}`);
    }
  }

  return {
    action,
    zoho_lead_id: zohoLeadId,
    mlid,
    plid,
    ...(zohoError ? { zoho_error: zohoError } : {}),
    resubmission,
  };
}
