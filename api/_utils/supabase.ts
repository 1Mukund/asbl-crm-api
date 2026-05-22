import { createClient } from "@supabase/supabase-js";
import { NormalizedLead } from "./types";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

// ─── MLID: Atomic get-or-create via Postgres function ────────────────────────

export async function getOrCreateMLID(phone: string): Promise<string> {
  const { data, error } = await supabase.rpc("get_or_create_mlid", {
    p_phone: phone,
  });
  if (error) throw new Error(`Supabase MLID error: ${JSON.stringify(error)}`);
  return String(data);
}

// ─── PLID: Atomic get-or-create via Postgres function ────────────────────────

export async function getOrCreatePLID(
  phone: string,
  mlid: string,
  project: string
): Promise<string> {
  const { data, error } = await supabase.rpc("get_or_create_plid", {
    p_phone: phone,
    p_mlid: mlid,
    p_project: project,
  });
  if (error) throw new Error(`Supabase PLID error: ${JSON.stringify(error)}`);
  return String(data);
}

// ─── Lookup existing Zoho lead ID by PLID (the v2 dedupe path) ──────────────
//
// PREVIOUS BUG (2026-05-22 fix): this function queried `plid_registry` and
// selected only the `plid` field — never returned a real `zoho_lead_id`,
// so the dedupe check in ingestLead always saw null and fell through to
// the racy Zoho search path. Result: 13 duplicate leads observed in Zoho
// (3-7 seconds apart on identical phone+project).
//
// Now reads from the `leads` table, which stores zoho_lead_id from the
// previous successful ingest. If a non-null zoho_lead_id comes back, the
// caller can skip the Zoho search (which has 5-30s indexing lag) and go
// straight to updateLead with the known ID.
export async function findLeadByPLID(
  plid: string
): Promise<{ zoho_lead_id: string | null; updated_at: string | null } | null> {
  const { data, error } = await supabase
    .from("leads")
    .select("zoho_lead_id,updated_at")
    .eq("plid", plid)
    .maybeSingle();

  if (error || !data) return null;
  return {
    zoho_lead_id: data.zoho_lead_id ?? null,
    updated_at: data.updated_at ?? null,
  };
}

// ─── Store lead in Supabase ───────────────────────────────────────────────────

export async function upsertLead(
  lead: NormalizedLead,
  mlid: string,
  plid: string,
  zohoLeadId: string | null,
  zohoSynced: boolean
): Promise<void> {
  const { error } = await supabase.from("leads").upsert(
    {
      mlid,
      plid,
      phone: lead.mobile,
      first_name: lead.first_name,
      last_name: lead.last_name,
      email: lead.email ?? "",
      lead_source: lead.lead_source,
      source_lead_id: lead.source_lead_id ?? "",
      campaign_name: lead.campaign_name ?? "",
      ad_set_name: lead.ad_set_name ?? "",
      ad_name: lead.ad_name ?? "",
      utm_source: lead.utm_source ?? "",
      utm_medium: lead.utm_medium ?? "",
      utm_campaign: lead.utm_campaign ?? "",
      utm_content: lead.utm_content ?? "",
      utm_term: lead.utm_term ?? "",
      project: lead.project ?? "",
      lead_budget: lead.budget ?? "",
      size_preference: lead.size_preference ?? "",
      floor_preference: lead.floor_preference ?? "",
      possession_timeline: lead.possession_timeline ?? "",
      purchase_purpose: lead.purchase_purpose ?? "",
      lead_comments: lead.lead_comments ?? "",
      first_page_visited: lead.first_page_visited ?? "",
      last_page_visited: lead.last_page_visited ?? "",
      total_page_views: lead.total_page_views ?? 0,
      time_spent_minutes: lead.time_spent_minutes ?? 0,
      referrer_url: lead.referrer_url ?? "",
      zoho_lead_id: zohoLeadId,
      zoho_synced: zohoSynced,
      zoho_synced_at: zohoSynced ? new Date().toISOString() : null,
      lead_received_at: lead.lead_received_at,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "plid" }
  );

  if (error) throw new Error(`Supabase upsert error: ${JSON.stringify(error)}`);
}
